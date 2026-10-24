package sessioncursor

import (
	"encoding/json"
	"sort"
)

// DefaultPendingCursorRetryGroupLimit bounds how many stale daily groups one
// bounded run re-emits, matching the TS default.
const DefaultPendingCursorRetryGroupLimit = 30

// pendingRetryCursorKey is the top-level field recording the last group a
// bounded retry rotation reached.
const pendingRetryCursorKey = "pendingSnapshotRetryCursor"

// CursorSnapshotGroupKey groups snapshots the way the aggregate keys do: one
// group per source/day/timezone/model.
func CursorSnapshotGroupKey(snapshot Snapshot) string {
	return snapshot.Source + "\x00" + snapshot.UsageDate + "\x00" + snapshot.Timezone + "\x00" + snapshot.Model
}

// pendingRetryCursor reads the persisted rotation cursor. The second result
// distinguishes "absent" from an empty string.
func pendingRetryCursor(state State) (string, bool) {
	raw, ok := state.ExtraValue(pendingRetryCursorKey)
	if !ok {
		return "", false
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", false
	}
	return value, true
}

// SelectPendingCursorSnapshotGroups chooses which stale pending groups a
// bounded run should re-emit.
//
// Groups older than the window are normally skipped, but a pending upload
// means the server never acknowledged them: dropping them silently would lose
// usage. They are retried a bounded number at a time, rotating through a
// persisted cursor so one failing group cannot starve the others.
//
// A nil sinceDate (an unbounded run) clears the rotation: every group is in
// range, so there is nothing to retry selectively.
func SelectPendingCursorSnapshotGroups(state *State, sinceDate string, limit *int) map[string]bool {
	if sinceDate == "" {
		state.DeleteExtra(pendingRetryCursorKey)
		return map[string]bool{}
	}
	groups := map[string]bool{}
	for _, key := range sortedEntryKeys(state.Files) {
		entry := state.Files[key]
		if entry.PendingUpload == nil || !*entry.PendingUpload {
			continue
		}
		for _, snapshot := range entry.Snapshots {
			if snapshot.UsageDate >= sinceDate {
				continue
			}
			groups[CursorSnapshotGroupKey(snapshot)] = true
		}
	}
	sortedGroups := make([]string, 0, len(groups))
	for group := range groups {
		sortedGroups = append(sortedGroups, group)
	}
	// Byte order, matching the TS `[...groups].sort()` for the ASCII keys these
	// groups are built from.
	sort.Strings(sortedGroups)
	if len(sortedGroups) == 0 {
		state.DeleteExtra(pendingRetryCursorKey)
		return map[string]bool{}
	}

	effectiveLimit := DefaultPendingCursorRetryGroupLimit
	if limit != nil {
		effectiveLimit = *limit
	}
	if effectiveLimit < 0 {
		effectiveLimit = 0
	}
	if effectiveLimit == 0 {
		state.DeleteExtra(pendingRetryCursorKey)
		return map[string]bool{}
	}
	if len(sortedGroups) <= effectiveLimit {
		state.DeleteExtra(pendingRetryCursorKey)
		selected := make(map[string]bool, len(sortedGroups))
		for _, group := range sortedGroups {
			selected[group] = true
		}
		return selected
	}

	start := 0
	if previous, ok := pendingRetryCursor(*state); ok {
		// Resume after the last group the previous rotation emitted; a cursor
		// past the end wraps to the start.
		if index := sort.SearchStrings(sortedGroups, previous); index < len(sortedGroups) && sortedGroups[index] == previous {
			start = index + 1
		} else if index < len(sortedGroups) {
			start = index
		} else {
			start = 0
		}
	}
	selectedGroups := append([]string{}, sortedGroups[start:]...)
	if len(selectedGroups) > effectiveLimit {
		selectedGroups = selectedGroups[:effectiveLimit]
	}
	if len(selectedGroups) < effectiveLimit {
		selectedGroups = append(selectedGroups, sortedGroups[:effectiveLimit-len(selectedGroups)]...)
	}
	if err := state.SetExtra(pendingRetryCursorKey, selectedGroups[len(selectedGroups)-1]); err != nil {
		// SetExtra only fails on an unmarshalable value, and a string never is.
		panic("sessioncursor: set pending retry cursor: " + err.Error())
	}
	selected := make(map[string]bool, len(selectedGroups))
	for _, group := range selectedGroups {
		selected[group] = true
	}
	return selected
}

// ShouldIncludeCursorSnapshot decides whether a carried snapshot belongs in
// this run's output: inside the window, or explicitly selected for retry.
func ShouldIncludeCursorSnapshot(snapshot Snapshot, sinceDate string, pendingGroups map[string]bool) bool {
	if sinceDate == "" {
		return true
	}
	return snapshot.UsageDate >= sinceDate || pendingGroups[CursorSnapshotGroupKey(snapshot)]
}

// sortedEntryKeys returns the file map's keys in order, so group selection
// never depends on Go's randomized map iteration.
func sortedEntryKeys(files map[string]Entry) []string {
	keys := make([]string, 0, len(files))
	for key := range files {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
