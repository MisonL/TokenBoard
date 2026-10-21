package antigravitycli

import (
	"sort"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessioncursor"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessionusage"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// antigravityUsageCursorRetentionMs is how long an acknowledged history
// identity is kept before it is compacted into a daily aggregate.
const antigravityUsageCursorRetentionMs = int64(90) * 24 * 60 * 60 * 1000

// AcknowledgeInput is one post-upload cursor acknowledgement.
type AcknowledgeInput struct {
	Cursor *sessioncursor.State
	// AcknowledgedGroups are the daily snapshot groups the server accepted.
	// Nil means "acknowledge everything in range", which is what a run with no
	// per-group feedback does.
	AcknowledgedGroups map[string]bool
	Since              string
	Timezone           string
	// Now is the clock the retention window is measured from; zero uses the
	// wall clock.
	Now time.Time
	// CollectedAt stamps rewritten entries; empty uses the wall clock.
	CollectedAt string
}

// ClearPendingUploadCursors marks the acknowledged entries as uploaded and
// compacts what has aged out of the retention window.
//
// This is the step that makes a run's output stop being re-emitted: until an
// entry is acknowledged, every later run keeps replaying it. A pending entry
// outside the window is still eligible (the retry rotation selects it), so the
// acknowledgement never depends on the event's age.
func ClearPendingUploadCursors(input AcknowledgeInput) error {
	if input.Cursor == nil {
		return nil
	}
	if input.Timezone == "" {
		return &AcknowledgeError{Message: "Antigravity cursor acknowledgement requires an explicit timezone"}
	}
	now := input.Now
	if now.IsZero() {
		now = time.Now()
	}
	collectedAt := input.CollectedAt
	if collectedAt == "" {
		collectedAt = now.UTC().Format("2006-01-02T15:04:05.000Z")
	}
	cursor := input.Cursor

	for _, key := range sortedCursorKeys(cursor.Files) {
		entry := cursor.Files[key]
		if entry.PendingUpload == nil || !*entry.PendingUpload {
			continue
		}
		acknowledged := input.AcknowledgedGroups == nil ||
			cursorEntryHasAcknowledgedGroup(key, entry, input.AcknowledgedGroups, input.Timezone)
		if input.AcknowledgedGroups != nil && cursorEntryRequiresAcknowledgedGroup(key, entry, input.Timezone) && !acknowledged {
			continue
		}
		if input.Since != "" && !acknowledged &&
			!cursorEntryIsInRange(entry, input.Since, input.Timezone) {
			continue
		}
		pendingFalse := false
		entry.PendingUpload = &pendingFalse
		entry.UpdatedAt = collectedAt
		cursor.Files[key] = entry
	}

	if err := compactAcknowledgedHistory(cursor, input.Timezone, now, collectedAt); err != nil {
		return err
	}
	return nil
}

// AcknowledgeError reports an acknowledgement that cannot be applied.
type AcknowledgeError struct{ Message string }

func (e *AcknowledgeError) Error() string { return e.Message }

// cursorEntryHasAcknowledgedGroup reports whether every snapshot in the entry
// is in an acknowledged group. A snapshotless entry falls back to its session
// marker, whose group the acknowledgement names when the daily model was
// uploaded on the marker's behalf.
func cursorEntryHasAcknowledgedGroup(key string, entry sessioncursor.Entry, groups map[string]bool, timezone string) bool {
	if len(entry.Snapshots) > 0 {
		for _, snapshot := range entry.Snapshots {
			if !groups[sessioncursor.CursorSnapshotGroupKey(snapshot)] {
				return false
			}
		}
		return true
	}
	group, ok := sessionMarkerSnapshotGroup(key, timezone)
	return ok && groups[group]
}

// cursorEntryRequiresAcknowledgedGroup reports whether the entry must be
// matched by group before it can be acknowledged. A database row cursor or an
// aggregate has nothing to match, so it is acknowledged by range alone.
func cursorEntryRequiresAcknowledgedGroup(key string, entry sessioncursor.Entry, timezone string) bool {
	if len(entry.Snapshots) > 0 {
		return true
	}
	_, ok := sessionMarkerSnapshotGroup(key, timezone)
	return ok
}

// sessionMarkerSnapshotGroup derives the group a session marker stands for.
func sessionMarkerSnapshotGroup(key, timezone string) (string, bool) {
	if !hasPrefix(key, historySessionPrefix) {
		return "", false
	}
	parts := splitNul(key)
	// session\0antigravity-cli\0<usageDate>\0<model>\0<cascadeHash>
	if len(parts) != 5 || parts[0] != "session" || parts[1] != string(contract.SourceAntigravityCLI) {
		return "", false
	}
	usageDate, model := parts[2], parts[3]
	if timezone == "" || !isUsageDate(usageDate) || model == "" {
		return "", false
	}
	return joinNul([]string{string(contract.SourceAntigravityCLI), usageDate, timezone, model}), true
}

func isUsageDate(value string) bool {
	if len(value) != 10 || value[4] != '-' || value[7] != '-' {
		return false
	}
	for index, char := range value {
		if index == 4 || index == 7 {
			continue
		}
		if char < '0' || char > '9' {
			return false
		}
	}
	return true
}

// cursorEntryIsInRange reports whether the entry belongs to the window. A
// snapshotless entry with no usable timestamp is always in range: it carries no
// date to exclude it by, and dropping it would lose an upload the server may
// still need.
func cursorEntryIsInRange(entry sessioncursor.Entry, sinceDate, timezone string) bool {
	if sinceDate == "" {
		return true
	}
	if len(entry.Snapshots) > 0 {
		for _, snapshot := range entry.Snapshots {
			if snapshot.UsageDate >= sinceDate {
				return true
			}
		}
		return false
	}
	if entry.MtimeMs <= 0 {
		return true
	}
	return sessionDateOf(entry.MtimeMs, timezone) >= sinceDate
}

// sessionDateOf renders an epoch-millisecond stamp's date in the configured
// timezone. TS resolves the same predicate through `formatDate(value,
// timezone)` (includesTimestamp in antigravity-since.ts), so an entry whose
// mtime falls in the hours where UTC and local disagree lands on the local
// day on both sides.
func sessionDateOf(mtimeMs float64, timezone string) string {
	location, err := contract.LoadLocation(timezone)
	if err != nil {
		return time.UnixMilli(int64(mtimeMs)).UTC().Format("2006-01-02")
	}
	return time.UnixMilli(int64(mtimeMs)).In(location).Format("2006-01-02")
}

// compactAcknowledgedHistory folds aged-out acknowledged identities into daily
// aggregates, so an unbounded history does not grow the cursor forever.
//
// The aggregate is what a later full rebuild compares against: a group the
// SQLite history no longer produces gets a zero correction, which is only
// possible while the baseline is retained.
func compactAcknowledgedHistory(
	cursor *sessioncursor.State,
	timezone string,
	now time.Time,
	collectedAt string,
) error {
	version, seen := cursorMeteringVersion(*cursor)
	if !seen || version != HistoryMeteringVersion {
		// A pre-authority cursor is migrated before it is compacted; folding
		// it here would aggregate state the migration still needs to reset.
		return nil
	}
	cutoffMs := float64(now.UnixMilli() - antigravityUsageCursorRetentionMs)
	cutoffDate := sessionusage.FormatDate(time.UnixMilli(int64(cutoffMs)), timezone)
	compactedThroughDate := nextCalendarDate(cutoffDate)

	aggregateInputs := map[string]aggregateInput{}
	changed := false
	prunedHistoryIdentity := false

	for _, key := range sortedCursorKeys(cursor.Files) {
		entry := cursor.Files[key]
		if entry.PendingUpload != nil && *entry.PendingUpload {
			continue
		}
		if IsHistoryCorrectionKey(key) {
			delete(cursor.Files, key)
			changed = true
			continue
		}
		if !IsCLIHistoryAggregateKey(key) {
			continue
		}
		retained := snapshotsAtOrAfter(entry.Snapshots, cutoffDate)
		if len(retained) == 0 {
			// Keep one compact baseline for groups outside the retention
			// window: a later full rebuild may need it to emit a zero
			// correction for a group the SQLite history has dropped.
			if len(entry.Snapshots) > 1 {
				entry.Snapshots = []sessioncursor.Snapshot{mergeSnapshotGroup(entry.Snapshots)}
				entry.UpdatedAt = collectedAt
				cursor.Files[key] = entry
				changed = true
			}
			continue
		}
		if len(retained) != len(entry.Snapshots) || len(retained) > 1 {
			entry.Snapshots = []sessioncursor.Snapshot{mergeSnapshotGroup(retained)}
			entry.UpdatedAt = collectedAt
			cursor.Files[key] = entry
			changed = true
		}
	}

	for _, key := range sortedCursorKeys(cursor.Files) {
		entry := cursor.Files[key]
		if entry.PendingUpload != nil && *entry.PendingUpload {
			continue
		}
		if !IsCLIHistoryEventKey(key) {
			continue
		}
		if len(entry.Snapshots) == 0 {
			if entry.MtimeMs < cutoffMs {
				delete(cursor.Files, key)
				changed = true
				prunedHistoryIdentity = true
			}
			continue
		}
		retained := snapshotsAtOrAfter(entry.Snapshots, cutoffDate)
		for _, snapshot := range entry.Snapshots {
			groupKey := sessioncursor.CursorSnapshotGroupKey(snapshot)
			group := aggregateInputs[groupKey]
			if entry.MtimeMs > group.mtimeMs {
				group.mtimeMs = entry.MtimeMs
			}
			group.snapshots = append(group.snapshots, snapshot)
			aggregateInputs[groupKey] = group
		}
		if len(retained) == 0 || entry.MtimeMs < cutoffMs {
			delete(cursor.Files, key)
			prunedHistoryIdentity = true
		} else {
			compacted := true
			entry.Snapshots = []sessioncursor.Snapshot{}
			pendingFalse := false
			entry.PendingUpload = &pendingFalse
			entry.CompactedIdentity = &compacted
			entry.UpdatedAt = collectedAt
			cursor.Files[key] = entry
		}
		changed = true
	}

	for _, key := range sortedCursorKeys(cursor.Files) {
		entry := cursor.Files[key]
		if entry.PendingUpload != nil && *entry.PendingUpload {
			continue
		}
		if !IsCLIHistorySessionKey(key) || entry.MtimeMs >= cutoffMs {
			continue
		}
		delete(cursor.Files, key)
		changed = true
		prunedHistoryIdentity = true
	}

	groupKeys := make([]string, 0, len(aggregateInputs))
	for groupKey := range aggregateInputs {
		groupKeys = append(groupKeys, groupKey)
	}
	sort.Strings(groupKeys)
	for _, groupKey := range groupKeys {
		input := aggregateInputs[groupKey]
		key := CLIHistoryAggregateKey(groupKey)
		existing := cursor.Files[key]
		combined := append([]sessioncursor.Snapshot{}, existing.Snapshots...)
		combined = append(combined, input.snapshots...)
		mtimeMs := input.mtimeMs
		if existing.MtimeMs > mtimeMs {
			mtimeMs = existing.MtimeMs
		}
		pendingFalse := false
		cursor.Files[key] = sessioncursor.Entry{
			MtimeMs:       mtimeMs,
			SHA256:        hashString(key),
			Snapshots:     []sessioncursor.Snapshot{mergeSnapshotGroup(combined)},
			MissingCost:   true,
			PendingUpload: &pendingFalse,
			UpdatedAt:     collectedAt,
		}
		changed = true
	}

	if prunedHistoryIdentity {
		compacted := true
		if err := cursor.SetExtra(cursorKeyHistoryCompacted, compacted); err != nil {
			return err
		}
		through := cursorHistoryCompactedThroughDate(*cursor)
		if through > compactedThroughDate {
			compactedThroughDate = through
		}
		if err := setCursorHistoryCompactedThroughDate(cursor, compactedThroughDate); err != nil {
			return err
		}
	}
	_ = changed
	return nil
}

type aggregateInput struct {
	mtimeMs   float64
	snapshots []sessioncursor.Snapshot
}

func snapshotsAtOrAfter(snapshots []sessioncursor.Snapshot, date string) []sessioncursor.Snapshot {
	kept := make([]sessioncursor.Snapshot, 0, len(snapshots))
	for _, snapshot := range snapshots {
		if snapshot.UsageDate >= date {
			kept = append(kept, snapshot)
		}
	}
	return kept
}

// mergeSnapshotGroup sums a group's snapshots into one, keeping the first's
// identity. An empty group cannot be compacted and yields a zero snapshot.
func mergeSnapshotGroup(snapshots []sessioncursor.Snapshot) sessioncursor.Snapshot {
	if len(snapshots) == 0 {
		return sessioncursor.Snapshot{}
	}
	merged := snapshots[0]
	for _, snapshot := range snapshots[1:] {
		merged.InputTokens += snapshot.InputTokens
		merged.OutputTokens += snapshot.OutputTokens
		merged.CacheCreationTokens += snapshot.CacheCreationTokens
		merged.CacheReadTokens += snapshot.CacheReadTokens
		merged.TotalTokens += snapshot.TotalTokens
		merged.CostUSD += snapshot.CostUSD
		merged.SessionCount += snapshot.SessionCount
	}
	return merged
}

// nextCalendarDate is the day after value, which is what makes the compacted
// frontier inclusive of the whole cutoff day.
func nextCalendarDate(value string) string {
	parsed, err := time.Parse("2006-01-02", value)
	if err != nil {
		return value
	}
	return parsed.AddDate(0, 0, 1).Format("2006-01-02")
}

func splitNul(value string) []string {
	parts := []string{}
	start := 0
	for index := 0; index < len(value); index++ {
		if value[index] == 0 {
			parts = append(parts, value[start:index])
			start = index + 1
		}
	}
	return append(parts, value[start:])
}

func joinNul(parts []string) string {
	joined := ""
	for index, part := range parts {
		if index > 0 {
			joined += "\x00"
		}
		joined += part
	}
	return joined
}
