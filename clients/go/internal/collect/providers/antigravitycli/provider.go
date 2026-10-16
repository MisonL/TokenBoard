package antigravitycli

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravityhistory"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravitymeta"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravityscan"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessioncursor"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessionusage"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
	"github.com/MisonL/TokenBoard/clients/go/internal/state"
)

const sourceLabel = "Antigravity CLI"

// Options configures one collection. Zero values fall back to the environment
// and the clock, matching the TypeScript defaults.
type Options struct {
	Timezone        string
	CollectedAt     string
	Since           string
	StateDir        string
	ConversationDir string
	CursorScope     string
	// MaxDbFiles is the per-run database budget. Nil means "unset": a bounded
	// run keeps the reader's default and a full-history run reads everything.
	MaxDbFiles *int
	// ReadUsageEvents replaces the real SQLite reader, for tests and the
	// shadow harness. Nil reads the conversations directory.
	ReadUsageEvents func(antigravityhistory.Options) (antigravityhistory.Result, error)
	SQLiteBin       *string
	ReadSQLite      antigravityhistory.ReadSQLite
	StatFile        antigravityhistory.StatFile
	ListFiles       antigravityhistory.ListFiles
	Stderr          func(line string)
	// Env resolves TOKENBOARD_STATE_DIR/TOKENBOARD_CONFIG_DIR and
	// TOKENBOARD_SQLITE_BIN; nil means the process environment.
	Env func(string) string
	// HomeDir is the fallback state directory's parent, and the default
	// conversations directory's root. Empty uses the process home.
	HomeDir string
}

// Collect gathers Antigravity CLI usage from its SQLite conversation history.
//
// The ordering is the contract: the legacy migration must succeed (and, when
// it needs one, the full scan must be requested) before any database is read,
// because a partially migrated cursor would double-count statusline totals.
func Collect(options Options) ([]contract.Snapshot, error) {
	timezone := options.Timezone
	if timezone == "" {
		timezone = sessionusage.LocalTimezone()
	}
	collectedAt := options.CollectedAt
	if collectedAt == "" {
		collectedAt = time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	}
	stateDir := options.StateDir
	if stateDir == "" {
		stateDir = state.ResolveDir(options.Env, homeDir(options))
	}

	rangeValue, err := antigravityscan.ResolveCollectionRange(sincePointer(options.Since), timezone, options.Env)
	if err != nil {
		return nil, err
	}
	if err := assertFullHistoryCanReadEveryDatabase(rangeValue, options.MaxDbFiles); err != nil {
		return nil, err
	}

	cursorPath := filepath.Join(stateDir, sessioncursor.FileName(contract.SourceAntigravityCLI, options.CursorScope))
	lock, err := state.Acquire(cursorPath+".lock", cursorLockTimeout)
	if err != nil {
		return nil, err
	}
	if lock == nil {
		return nil, fmt.Errorf("could not acquire the %s cursor lock at %s", sourceLabel, cursorPath)
	}
	defer func() { _ = lock.Release() }()

	cursor, err := sessioncursor.Read(cursorPath, string(contract.SourceAntigravityCLI))
	if err != nil {
		return nil, err
	}

	plan, err := PlanHistoryAuthorityMigration(cursor, rangeValue.FullHistory)
	if err != nil {
		return nil, err
	}
	rebuildFullHistory := ShouldRebuildHistoryFromFullScan(rangeValue.FullHistory)
	// A legacy cursor must be rebuilt from SQLite before it becomes
	// authoritative, so the persisted file is only replaced once that read
	// succeeds.
	nextCursor := cursor
	if plan.Required || rebuildFullHistory {
		nextCursor = cloneState(cursor)
	}
	if plan.Required {
		if err := ApplyHistoryAuthorityMigration(&nextCursor, collectedAt, plan.Corrections, plan.Reset); err != nil {
			return nil, err
		}
	}
	var retained []RetainedEntry
	if rebuildFullHistory {
		retained, err = PrepareHistoryFullRebuild(&nextCursor)
		if err != nil {
			return nil, err
		}
	}

	pendingSnapshotGroups := sessioncursor.SelectPendingCursorSnapshotGroups(
		&nextCursor, rangeValue.SinceDate, nil)
	scanState := cursorDBFileScan(nextCursor)
	nextCursor.SetExtra(cursorKeyDBFileScan, scanState)

	var snapshots []contract.Snapshot
	emittedKeys := map[string]bool{}

	localDbUsage, err := readLocalDBUsage(options, &nextCursor, rangeValue, timezone, &scanState)
	if err != nil {
		return nil, err
	}
	if err := assertFullHistoryDirectoryScanComplete(rangeValue, localDbUsage); err != nil {
		return nil, err
	}
	historyEvents := make([]antigravitymeta.UsageEvent, 0, len(localDbUsage.Events))
	for _, event := range localDbUsage.Events {
		if rangeValue.IncludesTimestamp(parseIsoTime(event.CreatedAt)) {
			historyEvents = append(historyEvents, event)
		}
	}
	if err := assertBoundedHistoryScanComplete(nextCursor, localDbUsage, rangeValue); err != nil {
		return nil, err
	}
	if !rebuildFullHistory {
		if err := AssertCLIHistoryEventsCanApplyIncrementally(nextCursor, historyEvents, timezone); err != nil {
			return nil, err
		}
	}
	for _, event := range historyEvents {
		PushCLIHistoryUsageEvent(PushCLIHistoryUsageEventInput{
			Event:       event,
			Cursor:      &nextCursor,
			Snapshots:   &snapshots,
			EmittedKeys: emittedKeys,
			Timezone:    timezone,
			CollectedAt: collectedAt,
		})
	}
	MarkCLIDbRowsProcessed(MarkCLIDbRowsProcessedInput{
		State:                     &nextCursor,
		KnownCascadeIDs:           localDbUsage.KnownCascadeIDs,
		LastReadRowIndexByCascade: localDbUsage.LastReadRowIndexByCascade,
		HistoryScope:              rangeValue.HistoryScope,
		CollectedAt:               collectedAt,
	})
	if rebuildFullHistory {
		rebuiltGroups := map[string]bool{}
		for _, event := range historyEvents {
			rebuiltGroups[CLIHistorySnapshotGroupFromEvent(event, timezone)] = true
		}
		if err := RestoreHistoryEntriesOutsideFullRebuild(&nextCursor, retained, rebuiltGroups, collectedAt); err != nil {
			return nil, err
		}
		if err := MarkHistoryFullScanComplete(&nextCursor); err != nil {
			return nil, err
		}
	}
	PushCompleteCLICursorSnapshots(&snapshots, &nextCursor, collectedAt, emittedKeys, func(snapshot sessioncursor.Snapshot) bool {
		return sessioncursor.ShouldIncludeCursorSnapshot(snapshot, rangeValue.SinceDate, pendingSnapshotGroups)
	})

	merged := sessioncursor.MergeSnapshots(snapshots)
	for _, snapshot := range merged {
		if err := snapshot.Validate(); err != nil {
			return nil, fmt.Errorf("%s snapshot rejected: %w", sourceLabel, err)
		}
	}
	if err := setCursorDBFileScan(&nextCursor, scanState); err != nil {
		return nil, err
	}
	if err := sessioncursor.Write(cursorPath, nextCursor); err != nil {
		return nil, err
	}
	return merged, nil
}

// cursorLockTimeout matches the TS cursor lock's 35s acquisition window.
const cursorLockTimeout = 35 * time.Second

// readLocalDBUsage resolves the read window and calls the reader (or its
// injected replacement), threading the scan state through so anchors persist.
func readLocalDBUsage(
	options Options,
	cursor *sessioncursor.State,
	rangeValue antigravityscan.CollectionRange,
	timezone string,
	scanState *antigravityscan.FileScanState,
) (antigravityhistory.Result, error) {
	lastSeen := LastSeenCLIDbRowIndexByCascadeHash(*cursor, rangeValue.HistoryScope)
	unanchored := UnanchoredCLIDbRowCursorHashes(*cursor, rangeValue.HistoryScope)
	budget := resolveReadBudget(options.MaxDbFiles, rangeValue)

	readOptions := antigravityhistory.Options{
		ConversationDir:               options.ConversationDir,
		SQLiteBin:                     options.SQLiteBin,
		ReadSQLite:                    options.ReadSQLite,
		LastSeenRowIndexByCascadeHash: lastSeen,
		MaxDbFiles:                    budget.MaxDbFiles,
		UnboundedDbFiles:              budget.Unbounded,
		StatFile:                      options.StatFile,
		ListFiles:                     options.ListFiles,
		ScanState:                     scanState,
		SinceDate:                     rangeValue.SinceDate,
		Timezone:                      timezone,
		DetectRowCursorReset:          len(lastSeen) > 0,
		// An unbounded run reads every database by definition, so it insists
		// the scan was complete; a bounded one may legitimately stop short,
		// which assertBoundedHistoryScanComplete covers instead.
		RequireCompleteDirectoryScan: rangeValue.FullHistory || budget.Unbounded,
		SourceLabel:                  sourceLabel,
	}
	if readOptions.ConversationDir == "" {
		readOptions.ConversationDir = defaultConversationDir(options)
	}
	if len(unanchored) > 0 {
		readOptions.ForceFullScanCascadeHashes = unanchored
	}
	if options.ReadUsageEvents != nil {
		return options.ReadUsageEvents(readOptions)
	}
	return antigravityhistory.ReadUsageEvents(readOptions)
}

// assertFullHistoryCanReadEveryDatabase refuses a full-history run that also
// caps the database count: the two together cannot see every database.
func assertFullHistoryCanReadEveryDatabase(rangeValue antigravityscan.CollectionRange, maxDbFiles *int) error {
	if rangeValue.FullHistory && maxDbFiles != nil {
		return fmt.Errorf("%s --since all requires an unbounded SQLite database scan", sourceLabel)
	}
	return nil
}

func assertFullHistoryDirectoryScanComplete(rangeValue antigravityscan.CollectionRange, usage antigravityhistory.Result) error {
	if rangeValue.FullHistory && !usage.CompleteDirectoryScan {
		return fmt.Errorf("%s --since all requires a complete SQLite directory scan", sourceLabel)
	}
	return nil
}

// assertBoundedHistoryScanComplete refuses to complete a partial directory
// scan under a bounded window: the run cannot tell which databases it missed,
// so it must ask for the full scan instead of silently under-reporting.
func assertBoundedHistoryScanComplete(
	cursor sessioncursor.State,
	usage antigravityhistory.Result,
	rangeValue antigravityscan.CollectionRange,
) error {
	if rangeValue.FullHistory || cursorHistoryComplete(cursor) || usage.CompleteDirectoryScan {
		return nil
	}
	return fmt.Errorf(
		"%s requires --since all before a bounded scan can complete an incomplete SQLite directory scan",
		sourceLabel)
}

// readBudget is the resolved per-run database budget, mirroring the TS
// `number | null | undefined` exactly: exactly one of the two fields carries.
type readBudget struct {
	// MaxDbFiles is the bounded budget, nil when the caller left it unset and
	// the reader applies its own default.
	MaxDbFiles *int
	// Unbounded reads every database; only a full-history run may ask for it.
	Unbounded bool
}

// resolveReadBudget mirrors the TS resolveMaxDbFiles: an explicit value wins,
// an unset value under a full-history run reads everything, and an unset value
// under a bounded run keeps the reader's own bounded default.
func resolveReadBudget(value *int, rangeValue antigravityscan.CollectionRange) readBudget {
	if value != nil {
		return readBudget{MaxDbFiles: value}
	}
	if rangeValue.FullHistory {
		return readBudget{Unbounded: true}
	}
	return readBudget{}
}

func defaultConversationDir(options Options) string {
	home := homeDir(options)
	return filepath.Join(home, ".gemini", "antigravity-cli", "conversations")
}

func homeDir(options Options) string {
	if options.HomeDir != "" {
		return options.HomeDir
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return home
}

// sincePointer distinguishes an omitted --since (fall back to the environment)
// from an explicitly empty one.
func sincePointer(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

// cloneState deep-copies the cursor so a failed migration or read leaves the
// persisted file untouched.
func cloneState(cursor sessioncursor.State) sessioncursor.State {
	cloned := sessioncursor.NewState(cursor.Source)
	cloned.Version = cursor.Version
	for key, value := range cursor.Extra() {
		_ = cloned.SetExtra(key, json.RawMessage(value))
	}
	for key, entry := range cursor.Files {
		copied := entry
		copied.Snapshots = append([]sessioncursor.Snapshot{}, entry.Snapshots...)
		cloned.Files[key] = copied
	}
	return cloned
}
