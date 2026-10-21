package antigravitygui

import (
	"sort"
	"strings"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravitymeta"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessioncursor"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// AcknowledgeInput is one post-upload cursor acknowledgement for a GUI/IDE
// source.
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
// compacts what has aged out of the retention window, folding each group's
// snapshots into one per-origin daily aggregate. The aggregate — not the
// identity — is what a later rebuild compares against, so the compacted
// identity itself is retained as a replay guard.
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

	for _, key := range sortedKeys(cursor.Files) {
		entry := cursor.Files[key]
		if entry.PendingUpload == nil || !*entry.PendingUpload {
			continue
		}
		acknowledged := input.AcknowledgedGroups == nil ||
			guiCursorEntryHasAcknowledgedGroup(Source(cursor.Source), key, entry, input.AcknowledgedGroups, input.Timezone)
		if input.AcknowledgedGroups != nil &&
			guiCursorEntryRequiresAcknowledgedGroup(Source(cursor.Source), key, entry, input.Timezone) && !acknowledged {
			continue
		}
		if input.Since != "" && !acknowledged && !guiCursorEntryIsInRange(entry, input.Since, input.Timezone) {
			continue
		}
		pendingFalse := false
		entry.PendingUpload = &pendingFalse
		entry.UpdatedAt = collectedAt
		cursor.Files[key] = entry
	}

	if err := compactAcknowledgedGuiUsage(cursor, now, collectedAt); err != nil {
		return err
	}
	return nil
}

// AcknowledgeError reports an acknowledgement that cannot be applied.
type AcknowledgeError struct{ Message string }

func (e *AcknowledgeError) Error() string { return e.Message }

func guiCursorEntryHasAcknowledgedGroup(
	source Source,
	key string,
	entry sessioncursor.Entry,
	groups map[string]bool,
	timezone string,
) bool {
	if len(entry.Snapshots) > 0 {
		for _, snapshot := range entry.Snapshots {
			if !groups[sessioncursor.CursorSnapshotGroupKey(snapshot)] {
				return false
			}
		}
		return true
	}
	group, ok := guiSessionMarkerGroup(source, key, timezone)
	return ok && groups[group]
}

func guiCursorEntryRequiresAcknowledgedGroup(source Source, key string, entry sessioncursor.Entry, timezone string) bool {
	if len(entry.Snapshots) > 0 {
		return true
	}
	_, ok := guiSessionMarkerGroup(source, key, timezone)
	return ok
}

// guiSessionMarkerGroup derives the group a session marker stands for:
// session\0<source>\0<usageDate>\0<model>\0<cascadeHash>.
func guiSessionMarkerGroup(source Source, key, timezone string) (string, bool) {
	parts := splitNul(key)
	if len(parts) != 5 || parts[0] != "session" || parts[1] != string(source) {
		return "", false
	}
	usageDate, model := parts[2], parts[3]
	if timezone == "" || !isUsageDate(usageDate) || model == "" {
		return "", false
	}
	return joinNul([]string{string(source), usageDate, timezone, model}), true
}

// guiCursorEntryIsInRange reports whether the entry belongs to the window. A
// snapshotless entry with no usable timestamp is always in range: it carries no
// date to exclude it by, and dropping it would lose an upload the server may
// still need.
func guiCursorEntryIsInRange(entry sessioncursor.Entry, sinceDate, timezone string) bool {
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
	// TS resolves this through `formatDate(value, timezone)`: the local day,
	// not the UTC one, decides whether a snapshotless entry is still in range.
	location, err := contract.LoadLocation(timezone)
	if err != nil {
		return time.UnixMilli(int64(entry.MtimeMs)).UTC().Format("2006-01-02") >= sinceDate
	}
	return time.UnixMilli(int64(entry.MtimeMs)).In(location).Format("2006-01-02") >= sinceDate
}

// guiAggregateInput accumulates one origin's daily group during compaction.
type guiAggregateInput struct {
	mtimeMs   float64
	snapshots []sessioncursor.Snapshot
	origin    string
}

// compactAcknowledgedGuiUsage folds acknowledged usage identities into
// per-origin daily aggregates. It mirrors the TS compactAcknowledgedAntigravityUsage:
// every acknowledged identity is folded (the aggregate is the baseline), the
// identity itself is kept as a snapshotless compacted marker so a replayed
// event cannot silently double-count, and an already-compacted marker stays.
func compactAcknowledgedGuiUsage(cursor *sessioncursor.State, now time.Time, collectedAt string) error {
	compactedAt := collectedAt

	aggregateInputs := map[string]guiAggregateInput{}
	for _, key := range sortedKeys(cursor.Files) {
		entry := cursor.Files[key]
		if IsGuiDbResetCorrectionKey(key) {
			if entry.PendingUpload == nil || !*entry.PendingUpload {
				delete(cursor.Files, key)
			}
			continue
		}
		if entry.PendingUpload != nil && *entry.PendingUpload {
			continue
		}
		retainedAtMs := parseIsoMillis(entry.UpdatedAt)
		if isNan(retainedAtMs) || !isGuiCompactionStateKey(key) {
			continue
		}
		if len(entry.Snapshots) == 0 {
			// Already folded; keep the compacted marker as the replay guard.
			compacted := true
			entry.CompactedIdentity = &compacted
			entry.UpdatedAt = compactedAt
			cursor.Files[key] = entry
			continue
		}
		for _, snapshot := range entry.Snapshots {
			groupKey := sessioncursor.CursorSnapshotGroupKey(snapshot)
			aggregateKey := guiAggregateInputKey(groupKey, entry.AntigravityOrigin)
			group := aggregateInputs[aggregateKey]
			if entry.MtimeMs > group.mtimeMs {
				group.mtimeMs = entry.MtimeMs
			}
			group.snapshots = append(group.snapshots, snapshot)
			group.origin = entry.AntigravityOrigin
			aggregateInputs[aggregateKey] = group
		}
		// The identity is the last thing proving this history was seen, so it
		// survives as a snapshotless compacted marker: a duplicate row arriving
		// later meets the marker instead of re-counting.
		compacted := true
		entry.Size = 0
		entry.Snapshots = []sessioncursor.Snapshot{}
		entry.MissingCost = true
		pendingFalse := false
		entry.PendingUpload = &pendingFalse
		entry.CompactedIdentity = &compacted
		entry.UpdatedAt = compactedAt
		cursor.Files[key] = entry
	}

	groupKeys := make([]string, 0, len(aggregateInputs))
	for groupKey := range aggregateInputs {
		groupKeys = append(groupKeys, groupKey)
	}
	sortStrings(groupKeys)
	for _, groupKey := range groupKeys {
		input := aggregateInputs[groupKey]
		key := GuiAggregateCursorKey(groupKey, input.origin)
		existing := cursor.Files[key]
		combined := append([]sessioncursor.Snapshot{}, existing.Snapshots...)
		combined = append(combined, input.snapshots...)
		mtimeMs := input.mtimeMs
		if existing.MtimeMs > mtimeMs {
			mtimeMs = existing.MtimeMs
		}
		pendingFalse := false
		cursor.Files[key] = sessioncursor.Entry{
			MtimeMs:           mtimeMs,
			SHA256:            hashOf(key),
			Snapshots:         []sessioncursor.Snapshot{mergeGuiSnapshotGroup(combined)},
			MissingCost:       true,
			PendingUpload:     &pendingFalse,
			AntigravityOrigin: input.origin,
			UpdatedAt:         compactedAt,
		}
	}
	return nil
}

// isGuiCompactionStateKey is the TS `isAntigravityUsageStateKey`: the
// per-event and per-session identities only. The cursor package's
// isGuiUsageStateKey is a different predicate that also counts aggregates —
// confusingly similar names for different questions, so the two stay separate
// here as they are there. An aggregate is already a folded baseline and must
// not be folded again.
func isGuiCompactionStateKey(key string) bool {
	return strings.HasPrefix(key, "event\x00") || strings.HasPrefix(key, "session\x00")
}

func guiAggregateInputKey(groupKey, origin string) string {
	if origin != "" {
		return origin + "\x00" + groupKey
	}
	return groupKey
}

// GuiAggregateCursorKey names the compacted daily aggregate for one origin.
func GuiAggregateCursorKey(groupKey, origin string) string {
	if origin != "" {
		return "aggregate\x00" + origin + "\x00" + hashOf(groupKey)
	}
	return "aggregate\x00" + hashOf(groupKey)
}

// mergeGuiSnapshotGroup sums a group's snapshots into one, keeping the first's
// identity.
func mergeGuiSnapshotGroup(snapshots []sessioncursor.Snapshot) sessioncursor.Snapshot {
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

func isNan(value float64) bool {
	return value != value
}

func hashOf(value string) string {
	return antigravitymeta.Hash(value)
}

func splitNul(value string) []string {
	return strings.Split(value, "\x00")
}

func joinNul(parts []string) string {
	return strings.Join(parts, "\x00")
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

func sortStrings(values []string) {
	sort.Strings(values)
}
