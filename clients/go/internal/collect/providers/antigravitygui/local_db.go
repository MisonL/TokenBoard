package antigravitygui

import (
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravityhistory"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravitymeta"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravityscan"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessioncursor"
)

// LocalDBRead is one SQLite history read: the usage, or the error it failed
// with. A failure is returned rather than raised because the caller decides
// whether it is fatal or merely means "this source is not installed here".
type LocalDBRead struct {
	Usage antigravityhistory.Result
	Error error
}

// ReadGuiLocalDbUsage reads this source's conversation databases, folding a
// failure into the result so the caller can carry on with the language-server
// route.
// The scan state is the caller's, not a copy: the reader records the row
// anchors in it, and the caller persists them into the cursor.
func ReadGuiLocalDbUsage(
	options Options,
	cursor sessioncursor.State,
	rangeValue antigravityscan.CollectionRange,
	timezone string,
	scanState *antigravityscan.FileScanState,
) LocalDBRead {
	usage, err := readGuiLocalDbUsageOrThrow(options, cursor, rangeValue, timezone, scanState)
	if err != nil {
		return LocalDBRead{
			Usage: antigravityhistory.Result{
				CascadeIDs:                map[string]bool{},
				Events:                    []antigravitymeta.UsageEvent{},
				KnownCascadeIDs:           map[string]bool{},
				LastReadRowIndexByCascade: map[string]int64{},
			},
			Error: err,
		}
	}
	return LocalDBRead{Usage: filterDBUsageByRange(usage, rangeValue)}
}

// filterDBUsageByRange narrows the read to the collection window. The cascade
// list is rebuilt from the surviving events, so a cascade whose only rows fell
// outside the window is not reported as covered.
func filterDBUsageByRange(usage antigravityhistory.Result, rangeValue antigravityscan.CollectionRange) antigravityhistory.Result {
	if rangeValue.SinceDate == "" {
		return usage
	}
	events := make([]antigravitymeta.UsageEvent, 0, len(usage.Events))
	coveredHashes := map[string]bool{}
	for _, event := range usage.Events {
		if !rangeValue.IncludesTimestamp(parseIsoTime(event.CreatedAt)) {
			continue
		}
		events = append(events, event)
		coveredHashes[event.CascadeHash] = true
		for _, alias := range event.CascadeHashAliases {
			coveredHashes[alias] = true
		}
	}
	cascadeIDs := map[string]bool{}
	for cascadeID := range usage.CascadeIDs {
		if coveredHashes[antigravitymeta.Hash(cascadeID)] {
			cascadeIDs[cascadeID] = true
		}
	}
	usage.Events = events
	usage.CascadeIDs = cascadeIDs
	return usage
}

func readGuiLocalDbUsageOrThrow(
	options Options,
	cursor sessioncursor.State,
	rangeValue antigravityscan.CollectionRange,
	timezone string,
	scanState *antigravityscan.FileScanState,
) (antigravityhistory.Result, error) {
	lastSeen := LastSeenDbRowIndexByCascadeHash(cursor, options.Source, rangeValue.HistoryScope)
	unanchored := UnanchoredDbRowCursorHashes(cursor, options.Source, rangeValue.HistoryScope)
	budget := resolveReadBudget(options.MaxDbFiles, rangeValue)

	// An injected reader (tests, the shadow harness) replaces the SQLite read
	// but keeps every derived option identical, so what it observes is what
	// the real read would have received.
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
		RequireCompleteDirectoryScan:  rangeValue.FullHistory || budget.Unbounded,
		SourceLabel:                   "Antigravity GUI",
	}
	if readOptions.ConversationDir == "" {
		readOptions.ConversationDir = defaultConversationDir(options)
	}
	if len(unanchored) > 0 {
		readOptions.ForceFullScanCascadeHashes = unanchored
	}
	if options.ReadDbUsageEvents != nil {
		return options.ReadDbUsageEvents(readOptions)
	}
	if options.RequestGeneratorMetadata != nil {
		// A caller that supplied a language-server route and no SQLite reader
		// is asking for the language-server-only collection.
		return antigravityhistory.Result{
			CascadeIDs:                map[string]bool{},
			Events:                    []antigravitymeta.UsageEvent{},
			KnownCascadeIDs:           map[string]bool{},
			LastReadRowIndexByCascade: map[string]int64{},
		}, nil
	}
	return antigravityhistory.ReadUsageEvents(readOptions)
}

// readBudget mirrors the CLI source's tri-state resolution.
type readBudget struct {
	MaxDbFiles *int
	Unbounded  bool
}

func resolveReadBudget(value *int, rangeValue antigravityscan.CollectionRange) readBudget {
	if value != nil {
		return readBudget{MaxDbFiles: value}
	}
	if rangeValue.FullHistory {
		return readBudget{Unbounded: true}
	}
	return readBudget{}
}
