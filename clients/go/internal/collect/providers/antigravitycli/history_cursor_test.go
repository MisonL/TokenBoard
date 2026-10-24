package antigravitycli

import (
	"strings"
	"testing"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravitymeta"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessioncursor"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

const (
	testCascadeHash     = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	testFirstEventHash  = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	testSecondEventHash = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
	testTimezone        = "UTC"
	testCollectedAt     = "2026-07-20T10:00:00.000Z"
	testEventCreatedAt  = "2026-07-20T10:00:00.000Z"
)

func TestKeepsDistinctHistoryEventsWithIdenticalTokenCountsAndOneSession(t *testing.T) {
	cursor := emptyHistoryCursor(t)
	var snapshots []contract.Snapshot
	emittedKeys := map[string]bool{}
	first := historyEventFixture(testFirstEventHash, testEventCreatedAt)
	second := historyEventFixture(testSecondEventHash, testEventCreatedAt)

	pushHistoryEvent(t, &cursor, &snapshots, emittedKeys, first)
	pushHistoryEvent(t, &cursor, &snapshots, emittedKeys, second)

	merged := sessioncursor.MergeSnapshots(snapshots)
	if len(merged) != 1 {
		t.Fatalf("merged = %d rows, want 1", len(merged))
	}
	if merged[0].InputTokens != 20 || merged[0].TotalTokens != 20 || merged[0].SessionCount != 1 {
		t.Fatalf("merged row = %+v, want 20 input / 20 total / 1 session", merged[0])
	}
	for _, event := range []antigravitymeta.UsageEvent{first, second} {
		if _, ok := cursor.Files[CLIHistoryEventKey(event)]; !ok {
			t.Fatalf("missing event key %q", CLIHistoryEventKey(event))
		}
	}
	if _, ok := cursor.Files[CLIHistorySessionKey(testCascadeHash, "2026-07-20", "gemini-3-flash-a")]; !ok {
		t.Fatal("missing session key")
	}
}

func TestReemitsPendingEventWithoutCreatingAnotherIdentity(t *testing.T) {
	cursor := emptyHistoryCursor(t)
	event := historyEventFixture(testFirstEventHash, testEventCreatedAt)

	var firstSnapshots []contract.Snapshot
	pushHistoryEvent(t, &cursor, &firstSnapshots, map[string]bool{}, event)

	var retrySnapshots []contract.Snapshot
	PushCLIHistoryUsageEvent(PushCLIHistoryUsageEventInput{
		Event:       event,
		Cursor:      &cursor,
		Snapshots:   &retrySnapshots,
		EmittedKeys: map[string]bool{},
		Timezone:    testTimezone,
		CollectedAt: "2026-07-20T10:01:00.000Z",
	})

	if len(retrySnapshots) != 1 {
		t.Fatalf("retry snapshots = %d, want 1", len(retrySnapshots))
	}
	if retrySnapshots[0].InputTokens != 10 || retrySnapshots[0].TotalTokens != 10 ||
		retrySnapshots[0].SessionCount != 1 || retrySnapshots[0].CollectedAt != "2026-07-20T10:01:00.000Z" {
		t.Fatalf("retry snapshot = %+v", retrySnapshots[0])
	}
	eventKeys := 0
	for key := range cursor.Files {
		if strings.HasPrefix(key, historyEventPrefix) {
			eventKeys++
		}
	}
	if eventKeys != 1 {
		t.Fatalf("history event keys = %d, want 1", eventKeys)
	}
}

func TestMergesAllPendingEntriesForDirtyDailyModelGroup(t *testing.T) {
	cursor := emptyHistoryCursor(t)
	var snapshots []contract.Snapshot
	emittedKeys := map[string]bool{}
	pushHistoryEvent(t, &cursor, &snapshots, emittedKeys, historyEventFixture(testFirstEventHash, testEventCreatedAt))
	pushHistoryEvent(t, &cursor, &snapshots, emittedKeys, historyEventFixture(testSecondEventHash, testEventCreatedAt))
	snapshots = nil

	PushCompleteCLICursorSnapshots(&snapshots, &cursor, testCollectedAt, map[string]bool{}, nil)

	merged := sessioncursor.MergeSnapshots(snapshots)
	if len(merged) != 1 {
		t.Fatalf("merged = %d rows, want 1", len(merged))
	}
	if merged[0].InputTokens != 20 || merged[0].TotalTokens != 20 || merged[0].SessionCount != 1 {
		t.Fatalf("merged row = %+v, want 20 input / 20 total / 1 session", merged[0])
	}
}

func TestRequiresFullRebuildForExpiredUnknownSessionInCompactedDailyModel(t *testing.T) {
	cursor := emptyHistoryCursor(t)
	event := historyEventFixture(testFirstEventHash, "2025-01-01T10:00:00.000Z")
	group := CLIHistorySnapshotGroupFromEvent(event, testTimezone)
	cursor.Files[CLIHistoryAggregateKey(group)] = aggregateEntryFixture()
	if err := setCursorHistoryCompactedThroughDate(&cursor, "2026-04-21"); err != nil {
		t.Fatalf("set compacted through date: %v", err)
	}

	err := AssertCLIHistoryEventsCanApplyIncrementally(cursor, []antigravitymeta.UsageEvent{event}, testTimezone)
	if err == nil {
		t.Fatal("expected the compacted-frontier assertion to fail")
	}
	if !strings.Contains(err.Error(), "rerun with --since all") {
		t.Fatalf("error = %q, want the --since all guidance", err.Error())
	}
}

func TestUsesPersistedCompactedFrontierForUnknownEvents(t *testing.T) {
	cursor := emptyHistoryCursor(t)
	createdAt := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	event := historyEventFixture(testFirstEventHash, createdAt)
	// The frontier is the persisted one, not today's clock: an event dated
	// "today" is inside a frontier that was compacted through today.
	if err := setCursorHistoryCompactedThroughDate(&cursor, createdAt[:10]); err != nil {
		t.Fatalf("set compacted through date: %v", err)
	}

	err := AssertCLIHistoryEventsCanApplyIncrementally(cursor, []antigravitymeta.UsageEvent{event}, testTimezone)
	if err == nil || !strings.Contains(err.Error(), "rerun with --since all") {
		t.Fatalf("error = %v, want the --since all guidance", err)
	}
}

func TestRequiresFullRebuildWhenOldUnknownEventSharesRetainedSessionMarker(t *testing.T) {
	cursor := emptyHistoryCursor(t)
	event := historyEventFixture(testFirstEventHash, "2025-01-01T10:00:00.000Z")
	if err := setCursorHistoryCompactedThroughDate(&cursor, "2026-04-21"); err != nil {
		t.Fatalf("set compacted through date: %v", err)
	}
	cursor.Files[CLIHistorySessionKey(testCascadeHash, "2025-01-01", "gemini-3-flash-a")] = aggregateEntryFixture()

	err := AssertCLIHistoryEventsCanApplyIncrementally(cursor, []antigravitymeta.UsageEvent{event}, testTimezone)
	if err == nil || !strings.Contains(err.Error(), "rerun with --since all") {
		t.Fatalf("error = %v, want the --since all guidance", err)
	}
}

func TestAllowsRecentNewSessionToExtendCompactedDailyModel(t *testing.T) {
	cursor := emptyHistoryCursor(t)
	createdAt := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	event := historyEventFixture(testFirstEventHash, createdAt)
	group := CLIHistorySnapshotGroupFromEvent(event, testTimezone)
	cursor.Files[CLIHistoryAggregateKey(group)] = aggregateEntryFixture()
	// No persisted frontier: an event newer than every compacted day may always
	// extend the daily model, aggregate or not.

	if err := AssertCLIHistoryEventsCanApplyIncrementally(cursor, []antigravitymeta.UsageEvent{event}, testTimezone); err != nil {
		t.Fatalf("expected the recent session to apply incrementally, got %v", err)
	}
}

// --- helpers -------------------------------------------------------------

func emptyHistoryCursor(t *testing.T) sessioncursor.State {
	t.Helper()
	cursor := sessioncursor.NewState("antigravity-cli")
	if err := setCursorMeteringVersion(&cursor, 3); err != nil {
		t.Fatalf("set metering version: %v", err)
	}
	return cursor
}

func historyEventFixture(eventHash, createdAt string) antigravitymeta.UsageEvent {
	return antigravitymeta.UsageEvent{
		CascadeHash: testCascadeHash,
		EventHash:   eventHash,
		CreatedAt:   createdAt,
		Model:       "gemini-3-flash-a",
		InputTokens: 10,
	}
}

func pushHistoryEvent(
	t *testing.T,
	cursor *sessioncursor.State,
	snapshots *[]contract.Snapshot,
	emittedKeys map[string]bool,
	event antigravitymeta.UsageEvent,
) {
	t.Helper()
	PushCLIHistoryUsageEvent(PushCLIHistoryUsageEventInput{
		Event:       event,
		Cursor:      cursor,
		Snapshots:   snapshots,
		EmittedKeys: emittedKeys,
		Timezone:    testTimezone,
		CollectedAt: testCollectedAt,
	})
}

func aggregateEntryFixture() sessioncursor.Entry {
	pendingFalse := false
	return sessioncursor.Entry{
		MtimeMs:       float64(time.Now().UnixMilli()),
		SHA256:        strings.Repeat("d", 64),
		Snapshots:     []sessioncursor.Snapshot{},
		MissingCost:   true,
		PendingUpload: &pendingFalse,
		UpdatedAt:     testCollectedAt,
	}
}
