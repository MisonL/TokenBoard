package antigravitycli

import (
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessioncursor"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// acknowledgeFixtureTime anchors the retention window to a fixed clock so the
// cutoff dates in the assertions are stable.
var acknowledgeFixtureTime = time.Date(2026, 7, 20, 10, 0, 0, 0, time.UTC)

func TestAcknowledgeMarksMatchingGroupsUploaded(t *testing.T) {
	cursor := pendingCursorFixture(t)

	err := ClearPendingUploadCursors(AcknowledgeInput{
		Cursor:   &cursor,
		Timezone: testTimezone,
		Now:      acknowledgeFixtureTime,
		AcknowledgedGroups: map[string]bool{
			"antigravity-cli\x002026-07-20\x00UTC\x00gemini-3-flash-a": true,
		},
	})
	if err != nil {
		t.Fatalf("acknowledge: %v", err)
	}
	for key, entry := range cursor.Files {
		if entry.PendingUpload != nil && *entry.PendingUpload {
			t.Fatalf("entry %q is still pending after acknowledging its group", key)
		}
	}
}

func TestAcknowledgeKeepsUnmatchedSnapshotEntriesPending(t *testing.T) {
	cursor := pendingCursorFixture(t)
	otherModel := "gemini-9"
	otherKey := historyEventPrefix + testCascadeHash + "\x00" + strings.Repeat("9", 64)
	otherEntry := sessioncursor.Entry{
		MtimeMs: 1,
		SHA256:  strings.Repeat("3", 64),
		Snapshots: []sessioncursor.Snapshot{{
			Source:       string(contract.SourceAntigravityCLI),
			UsageDate:    "2026-07-20",
			Timezone:     testTimezone,
			Model:        otherModel,
			TotalTokens:  5,
			SessionCount: 1,
		}},
		MissingCost: true,
		UpdatedAt:   testCollectedAt,
	}
	setPending(&otherEntry)
	cursor.Files[otherKey] = otherEntry

	err := ClearPendingUploadCursors(AcknowledgeInput{
		Cursor:   &cursor,
		Timezone: testTimezone,
		Now:      acknowledgeFixtureTime,
		AcknowledgedGroups: map[string]bool{
			"antigravity-cli\x002026-07-20\x00UTC\x00gemini-3-flash-a": true,
		},
	})
	if err != nil {
		t.Fatalf("acknowledge: %v", err)
	}
	found := false
	for key, entry := range cursor.Files {
		if strings.Contains(key, "gemini") {
			continue
		}
		if entry.PendingUpload != nil && *entry.PendingUpload && len(entry.Snapshots) > 0 &&
			entry.Snapshots[0].Model == otherModel {
			found = true
		}
	}
	if !found {
		t.Fatal("expected the unacknowledged group's entry to stay pending")
	}
}

func TestAcknowledgeRequiresTimezone(t *testing.T) {
	cursor := pendingCursorFixture(t)
	err := ClearPendingUploadCursors(AcknowledgeInput{Cursor: &cursor, Now: acknowledgeFixtureTime})
	if err == nil || !strings.Contains(err.Error(), "timezone") {
		t.Fatalf("error = %v, want the timezone requirement", err)
	}
}

func TestAcknowledgeCompactsAgedOutIdentitiesIntoAggregates(t *testing.T) {
	cursor := pendingCursorFixture(t)
	// Age the fixture event past the 90-day retention window.
	oldDay := acknowledgeFixtureTime.AddDate(0, 0, -95).Format("2006-01-02")
	for key, entry := range cursor.Files {
		if !IsCLIHistoryEventKey(key) {
			continue
		}
		entry.Snapshots[0].UsageDate = oldDay
		entry.MtimeMs = float64(acknowledgeFixtureTime.AddDate(0, 0, -95).UnixMilli())
		cursor.Files[key] = entry
	}
	// The compaction only runs at metering version 3.
	if err := setCursorMeteringVersion(&cursor, HistoryMeteringVersion); err != nil {
		t.Fatal(err)
	}

	err := ClearPendingUploadCursors(AcknowledgeInput{
		Cursor:   &cursor,
		Timezone: testTimezone,
		Now:      acknowledgeFixtureTime,
		AcknowledgedGroups: map[string]bool{
			"antigravity-cli\x00" + oldDay + "\x00UTC\x00gemini-3-flash-a": true,
		},
	})
	if err != nil {
		t.Fatalf("acknowledge: %v", err)
	}

	aggregates := 0
	events := 0
	for key, entry := range cursor.Files {
		if IsCLIHistoryAggregateKey(key) {
			aggregates++
			if len(entry.Snapshots) != 1 {
				t.Fatalf("aggregate snapshots = %d, want the single merged baseline", len(entry.Snapshots))
			}
			if entry.Snapshots[0].UsageDate != oldDay {
				t.Fatalf("aggregate date = %s, want %s", entry.Snapshots[0].UsageDate, oldDay)
			}
			if entry.Snapshots[0].TotalTokens != 10 {
				t.Fatalf("aggregate total = %v, want the merged 10", entry.Snapshots[0].TotalTokens)
			}
		}
		if IsCLIHistoryEventKey(key) && len(entry.Snapshots) > 0 {
			events++
		}
	}
	if aggregates != 1 {
		t.Fatalf("aggregates = %d, want 1", aggregates)
	}
	if events != 0 {
		t.Fatalf("aged-out events retained = %d, want 0", events)
	}
	if cursorHistoryCompactedThroughDate(cursor) == "" {
		t.Fatal("expected the compacted-through frontier to be recorded")
	}
}

func TestAcknowledgeKeepsRecentIdentitiesWithoutCompaction(t *testing.T) {
	cursor := pendingCursorFixture(t)
	if err := setCursorMeteringVersion(&cursor, HistoryMeteringVersion); err != nil {
		t.Fatal(err)
	}

	err := ClearPendingUploadCursors(AcknowledgeInput{
		Cursor:   &cursor,
		Timezone: testTimezone,
		Now:      acknowledgeFixtureTime,
		AcknowledgedGroups: map[string]bool{
			"antigravity-cli\x002026-07-20\x00UTC\x00gemini-3-flash-a": true,
		},
	})
	if err != nil {
		t.Fatalf("acknowledge: %v", err)
	}
	events := 0
	for key := range cursor.Files {
		if IsCLIHistoryEventKey(key) {
			events++
		}
	}
	if events != 1 {
		t.Fatalf("recent event identities = %d, want the identity kept", events)
	}
	if cursorHistoryCompactedThroughDate(cursor) != "" {
		t.Fatal("a recent acknowledgement must not move the compacted frontier")
	}
}

func TestAcknowledgeKeepsPreVersionCursorUncompacted(t *testing.T) {
	cursor := pendingCursorFixture(t)
	// No metering version: the migration has not run, so the compaction must
	// not touch the state the migration will reset.

	err := ClearPendingUploadCursors(AcknowledgeInput{
		Cursor:             &cursor,
		Timezone:           testTimezone,
		Now:                acknowledgeFixtureTime,
		AcknowledgedGroups: nil, // acknowledge everything
	})
	if err != nil {
		t.Fatalf("acknowledge: %v", err)
	}
	if cursorHistoryCompactedThroughDate(cursor) != "" {
		t.Fatal("a pre-migration cursor must not be compacted")
	}
}

// --- helpers -------------------------------------------------------------

func pendingCursorFixture(t *testing.T) sessioncursor.State {
	t.Helper()
	cursor := sessioncursor.NewState("antigravity-cli")
	pending := true
	eventKey := historyEventPrefix + testCascadeHash + "\x00" + testFirstEventHash
	cursor.Files[eventKey] = sessioncursor.Entry{
		MtimeMs: float64(acknowledgeFixtureTime.UnixMilli()),
		SHA256:  hashString(eventKey),
		Snapshots: []sessioncursor.Snapshot{{
			Source:       string(contract.SourceAntigravityCLI),
			UsageDate:    "2026-07-20",
			Timezone:     testTimezone,
			Model:        "gemini-3-flash-a",
			InputTokens:  7,
			TotalTokens:  10,
			SessionCount: 1,
		}},
		MissingCost:   true,
		PendingUpload: &pending,
		UpdatedAt:     testCollectedAt,
	}
	sessionKey := CLIHistorySessionKey(testCascadeHash, "2026-07-20", "gemini-3-flash-a")
	cursor.Files[sessionKey] = sessioncursor.Entry{
		MtimeMs:     float64(acknowledgeFixtureTime.UnixMilli()),
		SHA256:      hashString(sessionKey),
		Snapshots:   []sessioncursor.Snapshot{},
		MissingCost: true,
		UpdatedAt:   testCollectedAt,
	}
	return cursor
}

func setPending(entry *sessioncursor.Entry) {
	pending := true
	entry.PendingUpload = &pending
}

var _ = filepath.Join
