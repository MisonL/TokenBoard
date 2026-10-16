package sessioncursor

import (
	"sort"
	"testing"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

var timeUTC = time.UTC

func pendingSnapshotFixture(t *testing.T, usageDate, model string) Snapshot {
	t.Helper()
	return Snapshot{
		Source:       string(contract.SourceAntigravityCLI),
		UsageDate:    usageDate,
		Timezone:     "UTC",
		Model:        model,
		InputTokens:  1,
		TotalTokens:  1,
		SessionCount: 1,
	}
}

func pendingEntryFixture(t *testing.T, snapshot Snapshot) Entry {
	t.Helper()
	pending := true
	return Entry{
		MtimeMs:       parseDayMs(t, snapshot.UsageDate),
		SHA256:        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		Snapshots:     []Snapshot{snapshot},
		MissingCost:   true,
		PendingUpload: &pending,
		UpdatedAt:     "2026-07-17T00:00:00.000Z",
	}
}

func parseDayMs(t *testing.T, day string) float64 {
	t.Helper()
	parsed, err := time.ParseInLocation("2006-01-02T15:04:05", day+"T10:00:00", timeUTC)
	if err != nil {
		t.Fatalf("parse %s: %v", day, err)
	}
	return float64(parsed.UnixMilli())
}

func TestBoundsStalePendingSnapshotGroupsSelectedForRetry(t *testing.T) {
	state := NewState("antigravity-cli")
	state.Files["first"] = pendingEntryFixture(t, pendingSnapshotFixture(t, "2026-06-21", "gemini-a"))
	state.Files["second"] = pendingEntryFixture(t, pendingSnapshotFixture(t, "2026-06-22", "gemini-b"))
	state.Files["current"] = pendingEntryFixture(t, pendingSnapshotFixture(t, "2026-06-24", "gemini-c"))

	one := 1
	selected := SelectPendingCursorSnapshotGroups(&state, "2026-06-24", &one)

	if len(selected) != 1 {
		t.Fatalf("selected = %d groups, want 1", len(selected))
	}
	// The single oldest group sorts first, so with a limit of one it is the one
	// chosen; the current-window group is not stale and must never appear.
	for group := range selected {
		want := CursorSnapshotGroupKey(Snapshot{
			Source: string(contract.SourceAntigravityCLI), UsageDate: "2026-06-21",
			Timezone: "UTC", Model: "gemini-a",
		})
		if group != want {
			t.Fatalf("selected group %q, want %q", group, want)
		}
	}
}

func TestRotatesBoundedPendingRetriesSoFailedGroupsCannotStarveLaterOnes(t *testing.T) {
	state := NewState("antigravity-cli")
	days := []string{"2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04"}
	for index, day := range days {
		state.Files["file-"+string(rune('a'+index))] = pendingEntryFixture(
			t, pendingSnapshotFixture(t, day, "gemini-"+string(rune('0'+index))))
	}

	two := 2
	first := SelectPendingCursorSnapshotGroups(&state, "2026-07-01", &two)
	second := SelectPendingCursorSnapshotGroups(&state, "2026-07-01", &two)

	if sameGroups(first, second) {
		t.Fatalf("two rotations selected the same groups: %v", groupsOf(first))
	}
	union := map[string]bool{}
	for group := range first {
		union[group] = true
	}
	for group := range second {
		union[group] = true
	}
	if len(union) != 4 {
		t.Fatalf("union = %d groups, want all 4 across the two rotations", len(union))
	}
}

// helpers

func sameGroups(left, right map[string]bool) bool {
	if len(left) != len(right) {
		return false
	}
	for group := range left {
		if !right[group] {
			return false
		}
	}
	return true
}

func groupsOf(selected map[string]bool) []string {
	groups := make([]string, 0, len(selected))
	for group := range selected {
		groups = append(groups, group)
	}
	sort.Strings(groups)
	return groups
}
