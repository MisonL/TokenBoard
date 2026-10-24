package antigravitycli

import (
	"sort"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravityscan"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessioncursor"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// HistoryMeteringVersion is the metering version whose authority is the SQLite
// history; a cursor carrying it needs no migration.
const HistoryMeteringVersion = int64(3)

// historyCorrectionPrefix keys the zero corrections the authority migration
// writes, so a statusline-derived group the authoritative history no longer
// produces is still cancelled out.
const historyCorrectionPrefix = "history-authority-correction\x00"

// HistoryAuthorityMigrationPlan is what one migration step has to do.
type HistoryAuthorityMigrationPlan struct {
	Required            bool
	RequiresFullHistory bool
	Reset               bool
	Corrections         []sessioncursor.Snapshot
}

// HistoryAuthorityMigrationError reports a legacy cursor that cannot be
// migrated under the current window.
type HistoryAuthorityMigrationError struct{ Message string }

func (e *HistoryAuthorityMigrationError) Error() string { return e.Message }

// PlanHistoryAuthorityMigration mirrors planAntigravityCliHistoryAuthorityMigration:
// a cursor already at the current metering version, or one belonging to another
// source, needs nothing; a legacy cursor must be rebuilt from SQLite before it
// is trusted, which needs --since all so the rebuild sees every database.
func PlanHistoryAuthorityMigration(cursor sessioncursor.State, fullHistory bool) (HistoryAuthorityMigrationPlan, error) {
	if cursor.Source != string(contract.SourceAntigravityCLI) {
		return HistoryAuthorityMigrationPlan{}, nil
	}
	if version, seen := cursorMeteringVersion(cursor); seen && version == HistoryMeteringVersion {
		return HistoryAuthorityMigrationPlan{}, nil
	}

	reset := hasLegacyCliMeteringState(cursor)
	plan := HistoryAuthorityMigrationPlan{
		Required:            true,
		RequiresFullHistory: reset,
		Reset:               reset,
	}
	if !reset {
		return plan, nil
	}
	if !fullHistory {
		return HistoryAuthorityMigrationPlan{}, &HistoryAuthorityMigrationError{
			Message: "Antigravity CLI usage state requires --since all to migrate statusline-derived totals",
		}
	}
	plan.Corrections = correctionSnapshots(cursor)
	return plan, nil
}

// ApplyHistoryAuthorityMigration stamps the migration onto the working copy of
// the cursor: a reset drops the legacy state first, then the zero corrections
// are recorded so the statusline groups are not silently forgotten.
func ApplyHistoryAuthorityMigration(
	cursor *sessioncursor.State,
	collectedAt string,
	corrections []sessioncursor.Snapshot,
	reset bool,
) error {
	if reset {
		resetLegacyCliMeteringState(cursor)
	}
	for _, snapshot := range corrections {
		key := historyCorrectionKey(snapshot)
		cursor.Files[key] = newCorrectionEntry(key, snapshot, collectedAt)
	}
	return setCursorMeteringVersion(cursor, HistoryMeteringVersion)
}

// IsHistoryCorrectionKey reports whether the key is a migration correction.
func IsHistoryCorrectionKey(key string) bool {
	return hasPrefix(key, historyCorrectionPrefix)
}

// ShouldRebuildHistoryFromFullScan is `--since all` itself: the flag is the
// signal to rebuild, never the cursor's own content.
func ShouldRebuildHistoryFromFullScan(fullHistory bool) bool {
	return fullHistory
}

// RetainedEntry is one cursor entry the rebuild deliberately kept.
type RetainedEntry struct {
	Key   string
	Entry sessioncursor.Entry
}

// PrepareHistoryFullRebuild removes everything a rebuild will re-derive (the
// history identities, corrections and database row cursors, plus the scan
// state), returning the entries worth restoring afterwards: corrections, and
// event snapshots that still hold content. A rebuild that fails halfway then
// loses nothing it cannot recover, and one that succeeds can tell which groups
// vanished.
func PrepareHistoryFullRebuild(cursor *sessioncursor.State) ([]RetainedEntry, error) {
	retained := []RetainedEntry{}
	for _, key := range sortedCursorKeys(cursor.Files) {
		entry := cursor.Files[key]
		if (IsCLIHistoryStateKey(key) || IsHistoryCorrectionKey(key)) &&
			(len(entry.Snapshots) > 0 || IsCLIHistorySessionKey(key)) {
			retained = append(retained, RetainedEntry{Key: key, Entry: cloneEntry(entry)})
		}
		if IsCLIHistoryStateKey(key) || IsHistoryCorrectionKey(key) ||
			hasPrefix(key, cursorPrefixCLIDbCascade) {
			delete(cursor.Files, key)
		}
	}
	if err := setCursorDBFileScan(cursor, antigravityscan.NewFileScanState()); err != nil {
		return nil, err
	}
	cursor.DeleteExtra(cursorKeyHistoryCompacted)
	cursor.DeleteExtra(cursorKeyHistoryCompactedThrough)
	cursor.DeleteExtra(cursorKeyHistoryComplete)
	return retained, nil
}

// RestoreHistoryEntriesOutsideFullRebuild puts back what the rebuild did not
// re-derive, and writes a zero correction for each acknowledged group the new
// history no longer produces — otherwise totals the previous cursor already
// reported would silently disappear.
func RestoreHistoryEntriesOutsideFullRebuild(
	cursor *sessioncursor.State,
	retained []RetainedEntry,
	rebuiltSnapshotGroups map[string]bool,
	collectedAt string,
) error {
	if collectedAt == "" {
		collectedAt = nowISO()
	}

	retainedCorrectionGroups := map[string]bool{}
	// Per group: whether any retained entry still owes an upload, and the
	// first acknowledged snapshot seen. A group is only corrected when it has
	// no pending snapshot — a pending one is already going to be uploaded, and
	// adding a zero correction for it would cancel that value.
	hasPending := map[string]bool{}
	acknowledged := map[string]sessioncursor.Snapshot{}
	for _, retainedEntry := range retained {
		if IsHistoryCorrectionKey(retainedEntry.Key) {
			for _, snapshot := range retainedEntry.Entry.Snapshots {
				retainedCorrectionGroups[CLIHistorySnapshotGroupKey(snapshot)] = true
			}
			continue
		}
		if IsCLIHistorySessionKey(retainedEntry.Key) {
			continue
		}
		for _, snapshot := range retainedEntry.Entry.Snapshots {
			groupKey := CLIHistorySnapshotGroupKey(snapshot)
			if rebuiltSnapshotGroups[groupKey] {
				continue
			}
			if retainedEntry.Entry.PendingUpload != nil && *retainedEntry.Entry.PendingUpload {
				hasPending[groupKey] = true
				continue
			}
			if _, seen := acknowledged[groupKey]; !seen {
				acknowledged[groupKey] = snapshot
			}
		}
	}
	missingAcknowledgedSnapshots := map[string]sessioncursor.Snapshot{}
	for groupKey, snapshot := range acknowledged {
		if !hasPending[groupKey] {
			missingAcknowledgedSnapshots[groupKey] = snapshot
		}
	}

	retainedSessionKeys := map[string]bool{}
	for _, retainedEntry := range retained {
		key := retainedEntry.Key
		entry := retainedEntry.Entry
		if IsHistoryCorrectionKey(key) {
			cursor.Files[key] = entry
			continue
		}
		if IsCLIHistorySessionKey(key) {
			continue
		}
		kept := []sessioncursor.Snapshot{}
		for _, snapshot := range entry.Snapshots {
			groupKey := CLIHistorySnapshotGroupKey(snapshot)
			_, awaitingCorrection := missingAcknowledgedSnapshots[groupKey]
			if rebuiltSnapshotGroups[groupKey] || awaitingCorrection {
				continue
			}
			kept = append(kept, snapshot)
		}
		if len(kept) == 0 {
			continue
		}
		entry.Snapshots = kept
		cursor.Files[key] = entry
		for _, sessionKey := range CLIHistorySessionKeysForEntry(key, entry) {
			retainedSessionKeys[sessionKey] = true
		}
	}
	for _, retainedEntry := range retained {
		if !IsCLIHistorySessionKey(retainedEntry.Key) || !retainedSessionKeys[retainedEntry.Key] {
			continue
		}
		cursor.Files[retainedEntry.Key] = retainedEntry.Entry
	}

	groupKeys := make([]string, 0, len(missingAcknowledgedSnapshots))
	for groupKey := range missingAcknowledgedSnapshots {
		groupKeys = append(groupKeys, groupKey)
	}
	sort.Strings(groupKeys)
	for _, groupKey := range groupKeys {
		if retainedCorrectionGroups[groupKey] {
			continue
		}
		key := historyCorrectionKey(missingAcknowledgedSnapshots[groupKey])
		if _, ok := cursor.Files[key]; ok {
			continue
		}
		cursor.Files[key] = newCorrectionEntry(
			key, zeroCorrectionSnapshot(missingAcknowledgedSnapshots[groupKey]), collectedAt)
	}
	return nil
}

// MarkHistoryFullScanComplete records that a complete directory scan has been
// ingested, which later bounded runs require before completing a partial one.
func MarkHistoryFullScanComplete(cursor *sessioncursor.State) error {
	return setCursorHistoryComplete(cursor)
}

// correctionSnapshots derives one zero snapshot per daily group the legacy
// cursor reported, so the migration can cancel groups the SQLite history no
// longer produces.
func correctionSnapshots(cursor sessioncursor.State) []sessioncursor.Snapshot {
	byGroup := map[string]sessioncursor.Snapshot{}
	for _, key := range sortedCursorKeys(cursor.Files) {
		for _, snapshot := range cursor.Files[key].Snapshots {
			if snapshot.Source != string(contract.SourceAntigravityCLI) {
				continue
			}
			byGroup[CLIHistorySnapshotGroupKey(snapshot)] = sessioncursor.Snapshot{
				Source:    snapshot.Source,
				UsageDate: snapshot.UsageDate,
				Timezone:  snapshot.Timezone,
				Model:     snapshot.Model,
			}
		}
	}
	groupKeys := make([]string, 0, len(byGroup))
	for groupKey := range byGroup {
		groupKeys = append(groupKeys, groupKey)
	}
	sort.Strings(groupKeys)
	ordered := make([]sessioncursor.Snapshot, 0, len(groupKeys))
	for _, groupKey := range groupKeys {
		ordered = append(ordered, byGroup[groupKey])
	}
	return ordered
}

func historyCorrectionKey(snapshot sessioncursor.Snapshot) string {
	return historyCorrectionPrefix + hashString(CLIHistorySnapshotGroupKey(snapshot))
}

func newCorrectionEntry(key string, snapshot sessioncursor.Snapshot, collectedAt string) sessioncursor.Entry {
	pending := true
	return sessioncursor.Entry{
		Size:          0,
		MtimeMs:       finiteOrZero(parseIsoMillis(collectedAt)),
		SHA256:        hashString(key),
		Snapshots:     []sessioncursor.Snapshot{snapshot},
		MissingCost:   true,
		PendingUpload: &pending,
		UpdatedAt:     collectedAt,
	}
}

func zeroCorrectionSnapshot(snapshot sessioncursor.Snapshot) sessioncursor.Snapshot {
	return sessioncursor.Snapshot{
		Source:    snapshot.Source,
		UsageDate: snapshot.UsageDate,
		Timezone:  snapshot.Timezone,
		Model:     snapshot.Model,
	}
}

// cloneEntry copies an entry so a retained copy cannot be mutated through the
// cursor it was taken from.
func cloneEntry(entry sessioncursor.Entry) sessioncursor.Entry {
	cloned := entry
	cloned.Snapshots = append([]sessioncursor.Snapshot{}, entry.Snapshots...)
	return cloned
}
