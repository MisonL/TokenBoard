package antigravitygui

import (
	"testing"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessioncursor"
)

// guiAckNow is the clock the acknowledgement stamps entries with in these
// tests.
func guiAckNow() time.Time {
	return time.Date(2026, 7, 20, 12, 0, 0, 0, time.UTC)
}

func guiAckInput(cursor *sessioncursor.State, groups map[string]bool) AcknowledgeInput {
	return AcknowledgeInput{
		Cursor:             cursor,
		AcknowledgedGroups: groups,
		Timezone:           guiTimezone,
		Now:                guiAckNow(),
		CollectedAt:        guiCollectedAt,
	}
}

// guiPendingEventEntry stores one pending event identity with its snapshot.
func guiPendingEventEntry(
	t *testing.T,
	cursor *sessioncursor.State,
	cascadeHash, eventHash string,
	usageDate, model string,
	inputTokens int64,
	mtimeMs float64,
	origin Origin,
) {
	t.Helper()
	key := UsageEventKey(guiEventFixture(cascadeHash, eventHash, inputTokens))
	snapshot := sessioncursor.Snapshot{
		Source:      string(cursor.Source),
		UsageDate:   usageDate,
		Timezone:    guiTimezone,
		Model:       model,
		InputTokens: float64(inputTokens),
		TotalTokens: float64(inputTokens),
	}
	pending := true
	cursor.Files[key] = sessioncursor.Entry{
		MtimeMs:           mtimeMs,
		SHA256:            hashOf(key),
		Snapshots:         []sessioncursor.Snapshot{snapshot},
		MissingCost:       true,
		PendingUpload:     &pending,
		AntigravityOrigin: string(origin),
		UpdatedAt:         guiCollectedAt,
	}
}

func guiGroup(model, usageDate string) string {
	return sessioncursor.CursorSnapshotGroupKey(sessioncursor.Snapshot{
		Source: "antigravity", UsageDate: usageDate, Timezone: guiTimezone, Model: model,
	})
}

func TestAcknowledgeGuiCursorFoldsOnlyAcknowledgedGroups(t *testing.T) {
	cursor := sessioncursor.NewState("antigravity")
	recentMs := float64(guiAckNow().Add(-time.Hour).UnixMilli())
	guiPendingEventEntry(t, &cursor, hashOf("cascade-a"), hashOf("event-1"),
		"2026-07-20", "gemini-3-flash-a", 10, recentMs, OriginDatabase)
	guiPendingEventEntry(t, &cursor, hashOf("cascade-a"), hashOf("event-2"),
		"2026-07-20", "gemini-3-flash-b", 20, recentMs, OriginDatabase)

	acknowledged := map[string]bool{guiGroup("gemini-3-flash-a", "2026-07-20"): true}
	if err := ClearPendingUploadCursors(guiAckInput(&cursor, acknowledged)); err != nil {
		t.Fatalf("acknowledge: %v", err)
	}

	// The acknowledged identity is folded: its snapshots move into a daily
	// aggregate and the identity itself stays as a compacted marker.
	foldedKeys := 0
	pendingKeys := 0
	for key, entry := range cursor.Files {
		if !IsGuiUsageEventKey(key) {
			continue
		}
		if len(entry.Snapshots) == 0 {
			foldedKeys++
			if entry.CompactedIdentity == nil || !*entry.CompactedIdentity {
				t.Fatalf("entry %q lost its snapshots without a compacted marker", key)
			}
			if entry.PendingUpload == nil || *entry.PendingUpload {
				t.Fatalf("entry %q is compacted but still pending", key)
			}
			continue
		}
		pendingKeys++
		if entry.PendingUpload == nil || !*entry.PendingUpload {
			t.Fatalf("entry %q (flash-b) was acknowledged without its group", key)
		}
	}
	if foldedKeys != 1 {
		t.Fatalf("folded identities = %d, want 1 (flash-a)", foldedKeys)
	}
	if pendingKeys != 1 {
		t.Fatalf("still-pending identities = %d, want 1 (flash-b)", pendingKeys)
	}

	aggregates := 0
	for key, entry := range cursor.Files {
		if !IsGuiAggregateEntry(key) {
			continue
		}
		aggregates++
		if len(entry.Snapshots) != 1 || entry.Snapshots[0].InputTokens != 10 {
			t.Fatalf("aggregate %q = %+v, want the flash-a total of 10", key, entry.Snapshots)
		}
	}
	if aggregates != 1 {
		t.Fatalf("aggregates = %d, want 1", aggregates)
	}
}

func TestAcknowledgeGuiCursorKeepsCompactedMarkerAsReplayGuard(t *testing.T) {
	// The marker is what stops a replayed event from double-counting, so a
	// second acknowledgement must not drop it.
	cursor := sessioncursor.NewState("antigravity")
	recentMs := float64(guiAckNow().Add(-time.Hour).UnixMilli())
	guiPendingEventEntry(t, &cursor, hashOf("cascade-a"), hashOf("event-1"),
		"2026-07-20", "gemini-3-flash-a", 10, recentMs, OriginDatabase)
	groups := map[string]bool{guiGroup("gemini-3-flash-a", "2026-07-20"): true}

	for round := 0; round < 2; round++ {
		if err := ClearPendingUploadCursors(guiAckInput(&cursor, groups)); err != nil {
			t.Fatalf("acknowledge round %d: %v", round, err)
		}
		markers := 0
		for key, entry := range cursor.Files {
			if IsGuiUsageEventKey(key) && entry.CompactedIdentity != nil && *entry.CompactedIdentity {
				markers++
			}
		}
		if markers != 1 {
			t.Fatalf("round %d: compacted markers = %d, want 1", round, markers)
		}
	}
}

func TestAcknowledgeGuiCursorDropsResetCorrectionOnceCleared(t *testing.T) {
	cursor := sessioncursor.NewState("antigravity")
	QueueGuiDbResetCorrections(&cursor, []sessioncursor.Snapshot{{
		Source: "antigravity", UsageDate: "2026-07-20", Timezone: guiTimezone, Model: "gemini-3-flash-a",
	}}, guiCollectedAt)
	if err := ClearPendingUploadCursors(guiAckInput(&cursor, map[string]bool{
		guiGroup("gemini-3-flash-a", "2026-07-20"): true,
	})); err != nil {
		t.Fatalf("acknowledge: %v", err)
	}
	for key := range cursor.Files {
		if IsGuiDbResetCorrectionKey(key) {
			t.Fatalf("the cleared correction %q survived, want it dropped", key)
		}
	}
}

func TestAcknowledgeGuiCursorKeepsDistinctOriginsApart(t *testing.T) {
	// The aggregate keys by origin, so a database total and a language-server
	// total for the same day and model never merge into one baseline.
	cursor := sessioncursor.NewState("antigravity")
	recentMs := float64(guiAckNow().Add(-time.Hour).UnixMilli())
	guiPendingEventEntry(t, &cursor, hashOf("cascade-a"), hashOf("event-db"),
		"2026-07-20", "gemini-3-flash-a", 10, recentMs, OriginDatabase)
	guiPendingEventEntry(t, &cursor, hashOf("cascade-a"), hashOf("event-ls"),
		"2026-07-20", "gemini-3-flash-a", 20, recentMs, OriginLanguageServer)

	if err := ClearPendingUploadCursors(guiAckInput(&cursor, map[string]bool{
		guiGroup("gemini-3-flash-a", "2026-07-20"): true,
	})); err != nil {
		t.Fatalf("acknowledge: %v", err)
	}
	origins := map[string]bool{}
	for key, entry := range cursor.Files {
		if IsGuiAggregateEntry(key) {
			origins[entry.AntigravityOrigin] = true
		}
	}
	if !origins[string(OriginDatabase)] || !origins[string(OriginLanguageServer)] {
		t.Fatalf("aggregate origins = %v, want one database and one language-server baseline", origins)
	}
}

func TestAcknowledgeGuiCursorLeavesUnrelatedKeysUntouched(t *testing.T) {
	// A cursor key outside the usage-state families (the cascade cursor, the
	// empty frontier) carries no usage and must survive compaction untouched.
	cursor := sessioncursor.NewState("antigravity")
	recentMs := float64(guiAckNow().Add(-time.Hour).UnixMilli())
	guiPendingEventEntry(t, &cursor, hashOf("cascade-a"), hashOf("event-1"),
		"2026-07-20", "gemini-3-flash-a", 10, recentMs, OriginDatabase)
	MarkCascadeProcessed(&cursor, "antigravity", "cascade-a", recentMs, 5, "all", guiCollectedAt)
	before := cursor.Files[CascadeCursorKey("antigravity", "cascade-a", "all")]

	if err := ClearPendingUploadCursors(guiAckInput(&cursor, map[string]bool{
		guiGroup("gemini-3-flash-a", "2026-07-20"): true,
	})); err != nil {
		t.Fatalf("acknowledge: %v", err)
	}
	after, ok := cursor.Files[CascadeCursorKey("antigravity", "cascade-a", "all")]
	if !ok {
		t.Fatal("the cascade cursor was dropped by compaction")
	}
	if after.MtimeMs != before.MtimeMs || after.Size != before.Size ||
		len(after.Snapshots) != len(before.Snapshots) || after.UpdatedAt != before.UpdatedAt {
		t.Fatalf("cascade cursor = %+v, want it untouched at %+v", after, before)
	}
}

func TestAcknowledgeGuiCursorRequiresTimezone(t *testing.T) {
	cursor := sessioncursor.NewState("antigravity")
	input := guiAckInput(&cursor, nil)
	input.Timezone = ""
	if err := ClearPendingUploadCursors(input); err == nil {
		t.Fatal("expected an acknowledgement without a timezone to be refused")
	}
}

func TestAcknowledgeGuiCursorMergesIntoExistingAggregate(t *testing.T) {
	// A second round for the same group must add to the existing baseline
	// rather than replace it: ingest upserts daily totals, so the baseline has
	// to stay the sum of everything acknowledged.
	cursor := sessioncursor.NewState("antigravity")
	recentMs := float64(guiAckNow().Add(-time.Hour).UnixMilli())
	groups := map[string]bool{guiGroup("gemini-3-flash-a", "2026-07-20"): true}

	guiPendingEventEntry(t, &cursor, hashOf("cascade-a"), hashOf("event-1"),
		"2026-07-20", "gemini-3-flash-a", 10, recentMs, OriginDatabase)
	if err := ClearPendingUploadCursors(guiAckInput(&cursor, groups)); err != nil {
		t.Fatalf("first acknowledge: %v", err)
	}
	guiPendingEventEntry(t, &cursor, hashOf("cascade-a"), hashOf("event-2"),
		"2026-07-20", "gemini-3-flash-a", 25, recentMs, OriginDatabase)
	if err := ClearPendingUploadCursors(guiAckInput(&cursor, groups)); err != nil {
		t.Fatalf("second acknowledge: %v", err)
	}

	for key, entry := range cursor.Files {
		if !IsGuiAggregateEntry(key) {
			continue
		}
		if len(entry.Snapshots) != 1 || entry.Snapshots[0].InputTokens != 35 {
			t.Fatalf("aggregate %q = %+v, want the combined 35", key, entry.Snapshots)
		}
	}
}
