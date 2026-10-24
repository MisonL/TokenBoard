package antigravitycli

import (
	"math"
	"strings"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravitymeta"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessioncursor"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessionusage"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// The three synthetic cursor-key families the Antigravity CLI history keeps.
const (
	historyEventPrefix     = "history-event\x00"
	historySessionPrefix   = "session\x00antigravity-cli\x00"
	historyAggregatePrefix = "aggregate\x00"
)

// CLIHistoryEventKey names one user-visible history event: the event itself is
// the identity, so a re-read of an already-emitted row is recognised by key
// alone even if the token counts changed.
func CLIHistoryEventKey(event antigravitymeta.UsageEvent) string {
	return historyEventPrefix + event.CascadeHash + "\x00" + event.EventHash
}

// CLIHistorySessionKey names one conversation-day-model triple: the session
// marker exists so a compaction can tell which daily groups a cascade
// contributed to.
func CLIHistorySessionKey(cascadeHash, usageDate, model string) string {
	return historySessionPrefix + usageDate + "\x00" + model + "\x00" + cascadeHash
}

// CLIHistorySnapshotGroupKey is the grouping the aggregate keys and the
// pending-retry bookkeeping share.
func CLIHistorySnapshotGroupKey(snapshot sessioncursor.Snapshot) string {
	return strings.Join([]string{snapshot.Source, snapshot.UsageDate, snapshot.Timezone, snapshot.Model}, "\x00")
}

// CLIHistorySnapshotGroupFromEvent derives the group a freshly parsed event
// belongs to, so it can be matched against the cursor's aggregate entries.
func CLIHistorySnapshotGroupFromEvent(event antigravitymeta.UsageEvent, timezone string) string {
	usageDate := sessionusage.FormatDate(parseIsoTime(event.CreatedAt), timezone)
	return strings.Join([]string{string(contract.SourceAntigravityCLI), usageDate, timezone, event.Model}, "\x00")
}

// CLIHistoryAggregateKey is where a compacted group's retained totals live.
func CLIHistoryAggregateKey(groupKey string) string {
	return historyAggregatePrefix + hashString(groupKey)
}

func IsCLIHistoryEventKey(key string) bool {
	return strings.HasPrefix(key, historyEventPrefix)
}

func IsCLIHistorySessionKey(key string) bool {
	return strings.HasPrefix(key, historySessionPrefix)
}

func IsCLIHistoryAggregateKey(key string) bool {
	return strings.HasPrefix(key, historyAggregatePrefix)
}

// IsCLIHistoryStateKey reports whether the key is one of the three families the
// history cursor owns, as opposed to a database row cursor or a path entry.
func IsCLIHistoryStateKey(key string) bool {
	return IsCLIHistoryEventKey(key) || IsCLIHistorySessionKey(key) || IsCLIHistoryAggregateKey(key)
}

// CLIHistorySessionKeysForEntry names the session markers the entry's snapshots
// imply, so a rebuild can carry exactly those forward.
func CLIHistorySessionKeysForEntry(key string, entry sessioncursor.Entry) []string {
	cascadeHash, ok := cliHistoryCascadeHash(key)
	if !ok {
		return nil
	}
	keys := make([]string, 0, len(entry.Snapshots))
	for _, snapshot := range entry.Snapshots {
		keys = append(keys, CLIHistorySessionKey(cascadeHash, snapshot.UsageDate, snapshot.Model))
	}
	return keys
}

// cliHistoryCascadeHash parses an event key back into its cascade hash.
func cliHistoryCascadeHash(key string) (string, bool) {
	if !IsCLIHistoryEventKey(key) {
		return "", false
	}
	parts := strings.Split(key[len(historyEventPrefix):], "\x00")
	if len(parts) != 2 {
		return "", false
	}
	if !sha256HexPattern.MatchString(parts[0]) || !sha256HexPattern.MatchString(parts[1]) {
		return "", false
	}
	return parts[0], true
}

// PushCLIHistoryUsageEventInput carries one event through the history cursor.
type PushCLIHistoryUsageEventInput struct {
	Event       antigravitymeta.UsageEvent
	Cursor      *sessioncursor.State
	Snapshots   *[]contract.Snapshot
	EmittedKeys map[string]bool
	Timezone    string
	CollectedAt string
}

// PushCLIHistoryUsageEvent records one history event and appends its snapshot.
//
// The event key is the identity: an event already in the cursor is either
// re-emitted from its stored snapshot (while its upload is still pending) or
// ignored, never re-counted, so a database re-read cannot inflate usage.
func PushCLIHistoryUsageEvent(input PushCLIHistoryUsageEventInput) {
	eventKey := CLIHistoryEventKey(input.Event)
	if existing, ok := input.Cursor.Files[eventKey]; ok {
		if existing.PendingUpload != nil && *existing.PendingUpload {
			pushCachedSnapshots(input.Snapshots, existing, input.CollectedAt, input.EmittedKeys, eventKey, nil)
		}
		return
	}

	snapshot := buildHistorySnapshot(input)
	capturedAtMs := parseIsoMillis(input.Event.CreatedAt)
	pending := true
	input.Cursor.Files[eventKey] = sessioncursor.Entry{
		Size:          0,
		MtimeMs:       finiteOrZero(capturedAtMs),
		SHA256:        hashString(eventKey),
		Snapshots:     []sessioncursor.Snapshot{stripCollectedAt(snapshot)},
		MissingCost:   true,
		PendingUpload: &pending,
		UpdatedAt:     input.CollectedAt,
	}
	*input.Snapshots = append(*input.Snapshots, snapshot)
	input.EmittedKeys[eventKey] = true
}

// buildHistorySnapshot projects the event into a usage snapshot, creating or
// touching the session marker on the way.
func buildHistorySnapshot(input PushCLIHistoryUsageEventInput) contract.Snapshot {
	usageDate := sessionusage.FormatDate(parseIsoTime(input.Event.CreatedAt), input.Timezone)
	sessionKey := CLIHistorySessionKey(input.Event.CascadeHash, usageDate, input.Event.Model)
	capturedAtMs := parseIsoMillis(input.Event.CreatedAt)
	sessionEntry, exists := input.Cursor.Files[sessionKey]
	if !exists {
		pending := true
		input.Cursor.Files[sessionKey] = sessioncursor.Entry{
			Size:          0,
			MtimeMs:       finiteOrZero(capturedAtMs),
			SHA256:        hashString(sessionKey),
			Snapshots:     []sessioncursor.Snapshot{},
			MissingCost:   true,
			PendingUpload: &pending,
			UpdatedAt:     input.CollectedAt,
		}
	} else if capturedAtMs > sessionEntry.MtimeMs {
		sessionEntry.MtimeMs = capturedAtMs
		sessionEntry.UpdatedAt = input.CollectedAt
		input.Cursor.Files[sessionKey] = sessionEntry
	}

	sessionCount := int64(0)
	if !exists {
		sessionCount = 1
	}
	total := input.Event.InputTokens + input.Event.OutputTokens +
		input.Event.CacheCreationTokens + input.Event.CacheReadTokens
	return contract.Snapshot{
		Source:        contract.SourceAntigravityCLI,
		UsageDate:     usageDate,
		Timezone:      input.Timezone,
		Model:         input.Event.Model,
		InputTokens:   input.Event.InputTokens,
		OutputTokens:  input.Event.OutputTokens,
		CacheCreation: input.Event.CacheCreationTokens,
		CacheRead:     input.Event.CacheReadTokens,
		TotalTokens:   total,
		CostUSD:       0,
		SessionCount:  sessionCount,
		CollectedAt:   input.CollectedAt,
	}
}

// PushCompleteCLICursorSnapshots re-emits the pending cursor entries whose
// daily group this run touched.
//
// A run that could not read a database must still upload what it already
// holds for the affected groups: matching on the group key, rather than on the
// event, keeps a partially-acked daily model from silently losing the tokens
// an earlier run recorded.
func PushCompleteCLICursorSnapshots(
	snapshots *[]contract.Snapshot,
	cursor *sessioncursor.State,
	collectedAt string,
	emittedKeys map[string]bool,
	includeSnapshot func(sessioncursor.Snapshot) bool,
) {
	dirtyGroups := map[string]bool{}
	for _, key := range sortedCursorKeys(cursor.Files) {
		entry := cursor.Files[key]
		if entry.PendingUpload == nil || !*entry.PendingUpload || len(entry.Snapshots) == 0 {
			continue
		}
		for _, snapshot := range entry.Snapshots {
			if includeSnapshot != nil && !includeSnapshot(snapshot) {
				continue
			}
			dirtyGroups[CLIHistorySnapshotGroupKey(snapshot)] = true
		}
	}
	for _, snapshot := range *snapshots {
		dirtyGroups[CLIHistorySnapshotGroupKey(stripCollectedAt(snapshot))] = true
	}

	for _, eventKey := range sortedCursorKeys(cursor.Files) {
		entry := cursor.Files[eventKey]
		if len(entry.Snapshots) == 0 {
			continue
		}
		matches := false
		for _, snapshot := range entry.Snapshots {
			if dirtyGroups[CLIHistorySnapshotGroupKey(snapshot)] {
				matches = true
				break
			}
		}
		if !matches {
			continue
		}
		pushCachedSnapshots(snapshots, entry, collectedAt, emittedKeys, eventKey, includeSnapshot)
	}
}

// AssertCLIHistoryEventsCanApplyIncrementally fails when an event that is not
// in the cursor belongs to a day the cursor already compacted: its session
// identity was folded into an aggregate, so applying it incrementally would
// double-count it.
func AssertCLIHistoryEventsCanApplyIncrementally(
	cursor sessioncursor.State,
	events []antigravitymeta.UsageEvent,
	timezone string,
) error {
	compactedThroughDate := cursorHistoryCompactedThroughDate(cursor)
	for _, event := range events {
		if _, ok := cursor.Files[CLIHistoryEventKey(event)]; ok {
			continue
		}
		if compactedThroughDate == "" ||
			sessionusage.FormatDate(parseIsoTime(event.CreatedAt), timezone) > compactedThroughDate {
			continue
		}
		return &HistoryNotReconcilableError{}
	}
	return nil
}

// HistoryNotReconcilableError reports an event whose compacted session identity
// cannot be reconciled incrementally; the CLI maps it to the "rerun with
// --since all" guidance the TypeScript collector prints.
type HistoryNotReconcilableError struct{}

func (e *HistoryNotReconcilableError) Error() string {
	return "Antigravity CLI history contains an event whose compacted session identity cannot be reconciled incrementally; rerun with --since all"
}

// pushCachedSnapshots re-appends one entry's stored snapshots with a fresh
// collectedAt, once per run.
func pushCachedSnapshots(
	snapshots *[]contract.Snapshot,
	entry sessioncursor.Entry,
	collectedAt string,
	emittedKeys map[string]bool,
	eventKey string,
	includeSnapshot func(sessioncursor.Snapshot) bool,
) {
	if emittedKeys[eventKey] {
		return
	}
	for _, snapshot := range entry.Snapshots {
		if includeSnapshot != nil && !includeSnapshot(snapshot) {
			continue
		}
		*snapshots = append(*snapshots, snapshotWithCollectedAt(snapshot, collectedAt))
	}
	emittedKeys[eventKey] = true
}

// stripCollectedAt projects a snapshot into the cursor form, which carries no
// collectedAt: the timestamp belongs to one run, not to the usage.
func stripCollectedAt(snapshot contract.Snapshot) sessioncursor.Snapshot {
	return sessioncursor.Snapshot{
		Source:              string(snapshot.Source),
		UsageDate:           snapshot.UsageDate,
		Timezone:            snapshot.Timezone,
		Model:               snapshot.Model,
		InputTokens:         float64(snapshot.InputTokens),
		OutputTokens:        float64(snapshot.OutputTokens),
		CacheCreationTokens: float64(snapshot.CacheCreation),
		CacheReadTokens:     float64(snapshot.CacheRead),
		TotalTokens:         float64(snapshot.TotalTokens),
		CostUSD:             snapshot.CostUSD,
		SessionCount:        float64(snapshot.SessionCount),
	}
}

func snapshotWithCollectedAt(snapshot sessioncursor.Snapshot, collectedAt string) contract.Snapshot {
	return contract.Snapshot{
		Source:        contract.Source(snapshot.Source),
		UsageDate:     snapshot.UsageDate,
		Timezone:      snapshot.Timezone,
		Model:         snapshot.Model,
		InputTokens:   int64(snapshot.InputTokens),
		OutputTokens:  int64(snapshot.OutputTokens),
		CacheCreation: int64(snapshot.CacheCreationTokens),
		CacheRead:     int64(snapshot.CacheReadTokens),
		TotalTokens:   int64(snapshot.TotalTokens),
		CostUSD:       snapshot.CostUSD,
		SessionCount:  int64(snapshot.SessionCount),
		CollectedAt:   collectedAt,
	}
}

// parseIsoTime parses an ISO timestamp the way Date.parse would. An
// unparseable value is the zero time, which formats as epoch rather than
// crashing: the callers get a stable date instead of an error, matching the
// TypeScript behaviour where Date(NaN).toISOString() throws but the parser
// only ever feeds valid timestamps from the history reader.
func parseIsoTime(value string) time.Time {
	parsed, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(value))
	if err != nil {
		return time.Time{}
	}
	return parsed
}

// parseIsoMillis turns an ISO timestamp into epoch milliseconds, mirroring
// Date.parse: an unparseable value yields NaN, which the callers treat as "no
// timestamp".
func parseIsoMillis(value string) float64 {
	parsed, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(value))
	if err != nil {
		return math.NaN()
	}
	return float64(parsed.UnixMilli())
}

func finiteOrZero(value float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0
	}
	return value
}
