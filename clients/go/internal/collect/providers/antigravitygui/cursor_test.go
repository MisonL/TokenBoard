package antigravitygui

import (
	"strings"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravitymeta"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessioncursor"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

const guiTimezone = "UTC"
const guiCollectedAt = "2026-07-20T10:00:00.000Z"

func guiEventFixture(cascadeHash, eventHash string, input int64) antigravitymeta.UsageEvent {
	return antigravitymeta.UsageEvent{
		CascadeHash: cascadeHash,
		EventHash:   eventHash,
		CreatedAt:   "2026-07-20T10:00:00.000Z",
		Model:       "gemini-3-flash-a",
		InputTokens: input,
	}
}

func TestKeepsDistinctHistoryEventsWithIdenticalTokenCountsAndOneSession(t *testing.T) {
	cursor := sessioncursor.NewState("antigravity")
	var snapshots []contract.Snapshot
	emittedKeys := map[string]bool{}
	pushGuiEvent(t, &cursor, &snapshots, emittedKeys, OriginDatabase,
		guiEventFixture(strings.Repeat("a", 64), strings.Repeat("b", 64), 10))
	pushGuiEvent(t, &cursor, &snapshots, emittedKeys, OriginDatabase,
		guiEventFixture(strings.Repeat("a", 64), strings.Repeat("c", 64), 10))

	merged := sessioncursor.MergeSnapshots(snapshots)
	if len(merged) != 1 {
		t.Fatalf("merged = %d rows, want 1", len(merged))
	}
	if merged[0].InputTokens != 20 || merged[0].TotalTokens != 20 || merged[0].SessionCount != 1 {
		t.Fatalf("merged = %+v, want 20/20/1", merged[0])
	}
	// Both events share the cascade, so the session marker exists once.
	sessions := 0
	for key := range cursor.Files {
		if strings.HasPrefix(key, "session\x00") {
			sessions++
		}
	}
	if sessions != 1 {
		t.Fatalf("session markers = %d, want 1", sessions)
	}
}

func TestCountsOneSessionPerCascadeAcrossConversations(t *testing.T) {
	cursor := sessioncursor.NewState("antigravity")
	var snapshots []contract.Snapshot
	emittedKeys := map[string]bool{}
	pushGuiEvent(t, &cursor, &snapshots, emittedKeys, OriginDatabase,
		guiEventFixture(strings.Repeat("a", 64), strings.Repeat("b", 64), 10))
	pushGuiEvent(t, &cursor, &snapshots, emittedKeys, OriginDatabase,
		guiEventFixture(strings.Repeat("d", 64), strings.Repeat("b", 64), 10))

	merged := sessioncursor.MergeSnapshots(snapshots)
	if len(merged) != 1 {
		t.Fatalf("merged = %d rows, want 1", len(merged))
	}
	if merged[0].SessionCount != 2 {
		t.Fatalf("session count = %d, want 2 (one per cascade)", merged[0].SessionCount)
	}
}

func TestReemitsPendingEventWithoutCreatingAnotherIdentity(t *testing.T) {
	cursor := sessioncursor.NewState("antigravity")
	event := guiEventFixture(strings.Repeat("a", 64), strings.Repeat("b", 64), 10)

	var first []contract.Snapshot
	pushGuiEvent(t, &cursor, &first, map[string]bool{}, OriginDatabase, event)

	var retry []contract.Snapshot
	PushGuiUsageEvent(PushGuiUsageEventInput{
		Event: event, Origin: OriginDatabase, Cursor: &cursor,
		Snapshots: &retry, EmittedKeys: map[string]bool{},
		Timezone: guiTimezone, CollectedAt: "2026-07-20T10:01:00.000Z", Source: "antigravity",
	})

	if len(retry) != 1 || retry[0].InputTokens != 10 {
		t.Fatalf("retry = %+v, want the stored snapshot once", retry)
	}
	events := 0
	for key := range cursor.Files {
		if IsGuiUsageEventKey(key) {
			events++
		}
	}
	if events != 1 {
		t.Fatalf("event identities = %d, want 1", events)
	}
}

func TestOriginIsRecordedOnEventAndSessionEntries(t *testing.T) {
	cursor := sessioncursor.NewState("antigravity")
	var snapshots []contract.Snapshot
	pushGuiEvent(t, &cursor, &snapshots, map[string]bool{}, OriginLanguageServer,
		guiEventFixture(strings.Repeat("a", 64), strings.Repeat("b", 64), 10))

	for key, entry := range cursor.Files {
		if entry.AntigravityOrigin != string(OriginLanguageServer) {
			t.Fatalf("entry %q origin = %q, want language-server", key, entry.AntigravityOrigin)
		}
	}
}

func TestCompleteReemissionCoversDirtyGroupOnly(t *testing.T) {
	cursor := sessioncursor.NewState("antigravity")
	var snapshots []contract.Snapshot
	emittedKeys := map[string]bool{}
	pushGuiEvent(t, &cursor, &snapshots, emittedKeys, OriginDatabase,
		guiEventFixture(strings.Repeat("a", 64), strings.Repeat("b", 64), 10))
	pushGuiEvent(t, &cursor, &snapshots, emittedKeys, OriginDatabase,
		guiEventFixture(strings.Repeat("d", 64), strings.Repeat("c", 64), 40))

	complete := []contract.Snapshot{}
	PushCompleteGuiCursorSnapshots(&complete, &cursor, guiCollectedAt, map[string]bool{}, nil)

	merged := sessioncursor.MergeSnapshots(complete)
	if len(merged) != 1 {
		t.Fatalf("merged = %d rows, want the single daily group", len(merged))
	}
	if merged[0].InputTokens != 50 {
		t.Fatalf("merged input = %d, want 50", merged[0].InputTokens)
	}
}

func TestShouldRequestCascadeDistinguishesFileStates(t *testing.T) {
	cursor := sessioncursor.NewState("antigravity")
	MarkCascadeProcessed(&cursor, "antigravity", "cascade-1", 100, 5, "all", guiCollectedAt)

	if !ShouldRequestCascade(cursor, "antigravity", "cascade-2", 100, 5, "all") {
		t.Fatal("an unseen cascade must be requested")
	}
	if ShouldRequestCascade(cursor, "antigravity", "cascade-1", 100, 5, "all") {
		t.Fatal("an unchanged processed cascade must not be requested")
	}
	if !ShouldRequestCascade(cursor, "antigravity", "cascade-1", 101, 5, "all") {
		t.Fatal("a changed mtime must trigger a new request")
	}
	if !ShouldRequestCascade(cursor, "antigravity", "cascade-1", 100, 6, "all") {
		t.Fatal("a changed size must trigger a new request")
	}
}

func TestEmptyCascadeFrontierSkipsUnchangedCascades(t *testing.T) {
	cursor := sessioncursor.NewState("antigravity")
	MarkEmptyCascadeAttempted(&cursor, "antigravity", "cascade-1", 100, 5, "all", guiCollectedAt)

	frontier, ok := ReadEmptyCascadeFrontier(cursor, "antigravity", "all")
	if !ok {
		t.Fatal("expected the frontier to be recorded")
	}
	if frontier.MtimeMs != 100 || frontier.CascadeHash != antigravitymeta.Hash("cascade-1") {
		t.Fatalf("frontier = %+v", frontier)
	}
}

func TestDbRowCursorScopeIsolationAndReuse(t *testing.T) {
	cursor := sessioncursor.NewState("antigravity")
	MarkDbCascadeRowsProcessed(MarkDbCascadeRowsProcessedInput{
		Cursor:                    &cursor,
		Source:                    "antigravity",
		LastReadRowIndexByCascade: map[string]int64{"cascade-a": 4},
		HistoryScope:              "all",
		CollectedAt:               guiCollectedAt,
	})
	boundedScope := scopeFor(t, "20260624")
	MarkDbCascadeRowsProcessed(MarkDbCascadeRowsProcessedInput{
		Cursor:                    &cursor,
		Source:                    "antigravity",
		LastReadRowIndexByCascade: map[string]int64{"cascade-a": 7},
		HistoryScope:              boundedScope,
		CollectedAt:               guiCollectedAt,
	})

	if got := LastSeenDbRowIndexByCascadeHash(cursor, "antigravity", boundedScope); len(got) != 1 || got[hashOf("cascade-a")] != 7 {
		t.Fatalf("bounded scope rows = %v, want the bounded cursor only", got)
	}
	if got := LastSeenDbRowIndexByCascadeHash(cursor, "antigravity", "all"); len(got) != 1 || got[hashOf("cascade-a")] != 4 {
		t.Fatalf("all scope rows = %v, want the all cursor only", got)
	}
}

func TestUnanchoredRowCursorDetection(t *testing.T) {
	cursor := sessioncursor.NewState("antigravity")
	MarkDbCascadeRowsProcessed(MarkDbCascadeRowsProcessedInput{
		Cursor:                    &cursor,
		Source:                    "antigravity",
		LastReadRowIndexByCascade: map[string]int64{"cascade-a": 4},
		HistoryScope:              "all",
		CollectedAt:               guiCollectedAt,
	})

	if !HasUnanchoredDbRowCursor(cursor, "antigravity", "all") {
		t.Fatal("a row cursor with no scan state is unanchored")
	}
	scan := cursorDBFileScan(cursor)
	entry := scan.Files[hashOf("cascade-a")]
	rowIndex := int64(4)
	rowHash := strings.Repeat("a", 64)
	entry.MetadataCursorRowIndex = &rowIndex
	entry.MetadataCursorRowSHA256 = &rowHash
	scan.Files[hashOf("cascade-a")] = entry
	if err := setCursorDBFileScan(&cursor, scan); err != nil {
		t.Fatal(err)
	}
	if HasUnanchoredDbRowCursor(cursor, "antigravity", "all") {
		t.Fatal("an anchored cursor is accepted")
	}
	// Re-read the scan state: the setter round-trips through JSON, so mutating
	// the old copy afterwards would not touch the cursor.
	scan = cursorDBFileScan(cursor)
	entry = scan.Files[hashOf("cascade-a")]
	rowIndex = 3
	entry.MetadataCursorRowIndex = &rowIndex
	scan.Files[hashOf("cascade-a")] = entry
	if err := setCursorDBFileScan(&cursor, scan); err != nil {
		t.Fatal(err)
	}
	if !HasUnanchoredDbRowCursor(cursor, "antigravity", "all") {
		t.Fatal("a mismatched anchor is unanchored")
	}
}

func TestResetRefusesPendingDatabaseUsage(t *testing.T) {
	cursor := sessioncursor.NewState("antigravity")
	var snapshots []contract.Snapshot
	pushGuiEvent(t, &cursor, &snapshots, map[string]bool{}, OriginDatabase,
		guiEventFixture(strings.Repeat("a", 64), strings.Repeat("b", 64), 10))

	if _, err := ResetGuiDbCursorState(&cursor, "antigravity"); err == nil {
		t.Fatal("a reset with pending database usage must be refused")
	}
}

func TestResetDropsDatabaseUsageAndQueuesCorrections(t *testing.T) {
	cursor := sessioncursor.NewState("antigravity")
	var snapshots []contract.Snapshot
	pushGuiEvent(t, &cursor, &snapshots, map[string]bool{}, OriginDatabase,
		guiEventFixture(strings.Repeat("a", 64), strings.Repeat("b", 64), 10))
	// Acknowledge the event so the reset may proceed, then reset.
	for key := range cursor.Files {
		entry := cursor.Files[key]
		pendingFalse := false
		entry.PendingUpload = &pendingFalse
		cursor.Files[key] = entry
	}

	corrections, err := ResetGuiDbCursorState(&cursor, "antigravity")
	if err != nil {
		t.Fatalf("reset: %v", err)
	}
	if len(corrections) != 1 {
		t.Fatalf("corrections = %d, want 1", len(corrections))
	}
	if corrections[0].Model != "gemini-3-flash-a" || corrections[0].InputTokens != 0 {
		t.Fatalf("correction = %+v, want the zeroed group", corrections[0])
	}
	// Language-server usage must survive; database usage must go.
	var languageServer []contract.Snapshot
	pushGuiEvent(t, &cursor, &languageServer, map[string]bool{}, OriginLanguageServer,
		guiEventFixture(strings.Repeat("a", 64), strings.Repeat("e", 64), 5))
	keptDatabase, keptLanguageServer := 0, 0
	for key, entry := range cursor.Files {
		if IsGuiUsageEventKey(key) {
			if entry.AntigravityOrigin == string(OriginDatabase) {
				keptDatabase++
			}
			if entry.AntigravityOrigin == string(OriginLanguageServer) {
				keptLanguageServer++
			}
		}
	}
	if keptDatabase != 0 {
		t.Fatalf("database events survived the reset: %d", keptDatabase)
	}
	if keptLanguageServer != 1 {
		t.Fatalf("language-server events = %d, want 1", keptLanguageServer)
	}

	QueueGuiDbResetCorrections(&cursor, corrections, guiCollectedAt)
	correctionCount := 0
	for key := range cursor.Files {
		if IsGuiDbResetCorrectionKey(key) {
			correctionCount++
		}
	}
	if correctionCount != 1 {
		t.Fatalf("queued corrections = %d, want 1", correctionCount)
	}
}

// --- helpers -------------------------------------------------------------

func pushGuiEvent(
	t *testing.T,
	cursor *sessioncursor.State,
	snapshots *[]contract.Snapshot,
	emittedKeys map[string]bool,
	origin Origin,
	event antigravitymeta.UsageEvent,
) {
	t.Helper()
	PushGuiUsageEvent(PushGuiUsageEventInput{
		Event: event, Origin: origin, Cursor: cursor,
		Snapshots: snapshots, EmittedKeys: emittedKeys,
		Timezone: guiTimezone, CollectedAt: guiCollectedAt, Source: "antigravity",
	})
}

func scopeFor(t *testing.T, since string) string {
	t.Helper()
	value := since
	// The GUI package resolves the scope the same way the CLI does; build it
	// directly to avoid importing the whole scan option set here.
	return value[0:4] + "-" + value[4:6] + "-" + value[6:8] + "@UTC"
}

func hashOf(value string) string {
	return antigravitymeta.Hash(value)
}
