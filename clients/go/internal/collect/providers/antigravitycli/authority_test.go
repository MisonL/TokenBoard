package antigravitycli

import (
	"strings"
	"testing"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessioncursor"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

func TestPlanMigrationNeedsNothingForCurrentVersion(t *testing.T) {
	cursor := sessioncursor.NewState("antigravity-cli")
	if err := setCursorMeteringVersion(&cursor, HistoryMeteringVersion); err != nil {
		t.Fatalf("set version: %v", err)
	}
	plan, err := PlanHistoryAuthorityMigration(cursor, false)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if plan.Required {
		t.Fatal("expected no migration for the current metering version")
	}
}

func TestPlanMigrationSkipsOtherSources(t *testing.T) {
	cursor := sessioncursor.NewState("codex")
	plan, err := PlanHistoryAuthorityMigration(cursor, false)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if plan.Required {
		t.Fatal("expected no migration for another source's cursor")
	}
}

func TestPlanMigrationRequiresFullHistoryForLegacyState(t *testing.T) {
	cursor := legacyCursorFixture(t, "")

	_, err := PlanHistoryAuthorityMigration(cursor, false)
	if err == nil || !strings.Contains(err.Error(), "requires --since all") {
		t.Fatalf("error = %v, want the --since all guidance", err)
	}
}

func TestPlanMigrationDerivesCorrectionsFromLegacySnapshots(t *testing.T) {
	cursor := legacyCursorFixture(t, "Gemini 3.5 Flash (Medium)")

	plan, err := PlanHistoryAuthorityMigration(cursor, true)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if !plan.Required || !plan.RequiresFullHistory || !plan.Reset {
		t.Fatalf("plan = %+v, want required+full+reset", plan)
	}
	if len(plan.Corrections) != 1 {
		t.Fatalf("corrections = %d, want 1", len(plan.Corrections))
	}
	correction := plan.Corrections[0]
	if correction.Source != string(contract.SourceAntigravityCLI) ||
		correction.Model != "Gemini 3.5 Flash (Medium)" ||
		correction.UsageDate != "2026-07-20" ||
		correction.InputTokens != 0 || correction.TotalTokens != 0 || correction.SessionCount != 0 {
		t.Fatalf("correction = %+v, want a zeroed legacy group", correction)
	}
}

func TestApplyMigrationResetsAndStampsVersion(t *testing.T) {
	cursor := legacyCursorFixture(t, "Gemini 3.5 Flash (Medium)")
	collectedAt := "2026-07-20T10:00:00.000Z"

	plan, err := PlanHistoryAuthorityMigration(cursor, true)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if err := ApplyHistoryAuthorityMigration(&cursor, collectedAt, plan.Corrections, plan.Reset); err != nil {
		t.Fatalf("apply: %v", err)
	}

	version, seen := cursorMeteringVersion(cursor)
	if !seen || version != HistoryMeteringVersion {
		t.Fatalf("metering version = %d (seen %v), want %d", version, seen, HistoryMeteringVersion)
	}
	for _, key := range legacyCliMeteringFields {
		if _, ok := cursor.ExtraValue(key); ok {
			t.Fatalf("legacy field %q survived the reset", key)
		}
	}
	if len(cursor.Files) != 1 {
		t.Fatalf("files = %d, want only the correction entry", len(cursor.Files))
	}
	for key, entry := range cursor.Files {
		if !IsHistoryCorrectionKey(key) {
			t.Fatalf("unexpected surviving key %q", key)
		}
		if entry.PendingUpload == nil || !*entry.PendingUpload {
			t.Fatal("correction must be pending")
		}
	}
}

func TestPrepareFullRebuildRetainsContentAndClearsState(t *testing.T) {
	cursor := legacyCursorFixture(t, "Gemini 3.5 Flash (Medium)")
	// A db-row cursor with no snapshots must be dropped without being retained.
	cursor.Files[cursorPrefixCLIDbCascade+strings.Repeat("1", 64)] = sessioncursor.Entry{
		Snapshots: []sessioncursor.Snapshot{},
	}

	retained, err := PrepareHistoryFullRebuild(&cursor)
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	retainedKeys := map[string]bool{}
	for _, item := range retained {
		retainedKeys[item.Key] = true
	}
	// Only the aggregate carries snapshots: the empty db-row cursor is dropped,
	// and the statusline-event key belongs to no history family, so the TS
	// rebuild neither retains nor deletes it — it stays untouched.
	if len(retained) != 1 {
		t.Fatalf("retained = %d (%v), want 1", len(retained), retainedKeys)
	}
	if _, ok := cursor.Files["statusline-event\x00"+strings.Repeat("e", 64)]; !ok {
		t.Fatal("expected the statusline-event entry to be left untouched")
	}
	// The statusline-event entry is outside every history family and survives.
	if len(cursor.Files) != 1 {
		t.Fatalf("cursor kept %d entries, want only the statusline-event one", len(cursor.Files))
	}
	// The TS rebuild does not touch legacy scan fields here: the reset in the
	// migration (not the rebuild) owns those, and hasLegacyCliMeteringState
	// keeps detecting them until it runs.
	if _, ok := cursor.ExtraValue("lastScanOffsetBytes"); !ok {
		t.Fatal("expected lastScanOffsetBytes to be left to the migration reset")
	}
}

func TestRestoreEntriesOutsideFullRebuildWritesZeroCorrections(t *testing.T) {
	cursor := sessioncursor.NewState("antigravity-cli")
	retained := []RetainedEntry{}
	legacyEntry := sessioncursor.Entry{
		SHA256: strings.Repeat("c", 64),
		Snapshots: []sessioncursor.Snapshot{{
			Source:       string(contract.SourceAntigravityCLI),
			UsageDate:    "2026-07-20",
			Timezone:     "UTC",
			Model:        "gemini-3-flash-a",
			InputTokens:  900,
			TotalTokens:  900,
			SessionCount: 1,
		}},
	}
	retained = append(retained, RetainedEntry{
		Key:   historyEventPrefix + strings.Repeat("a", 64) + "\x00" + strings.Repeat("b", 64),
		Entry: legacyEntry,
	})

	// The rebuild re-derived a different group, so the legacy group vanished.
	RestoreHistoryEntriesOutsideFullRebuild(&cursor, retained, map[string]bool{"other": true}, testCollectedAt)

	corrections := 0
	for key, entry := range cursor.Files {
		if !IsHistoryCorrectionKey(key) {
			t.Fatalf("unexpected key %q after restore", key)
		}
		corrections++
		if len(entry.Snapshots) != 1 {
			t.Fatalf("correction snapshots = %d, want 1", len(entry.Snapshots))
		}
		snapshot := entry.Snapshots[0]
		if snapshot.InputTokens != 0 || snapshot.TotalTokens != 0 || snapshot.SessionCount != 0 {
			t.Fatalf("correction = %+v, want zeroed", snapshot)
		}
		if snapshot.Model != "gemini-3-flash-a" {
			t.Fatalf("correction model = %q", snapshot.Model)
		}
	}
	if corrections != 1 {
		t.Fatalf("corrections = %d, want 1", corrections)
	}
}

func TestRestoreKeepsSnapshotsOutsideRebuiltGroupsPending(t *testing.T) {
	cursor := sessioncursor.NewState("antigravity-cli")
	pending := true
	groupKey := "antigravity-cli\x002026-07-20\x00UTC\x00gemini-3-flash-a"
	retained := []RetainedEntry{{
		Key: historyEventPrefix + strings.Repeat("a", 64) + "\x00" + strings.Repeat("b", 64),
		Entry: sessioncursor.Entry{
			SHA256:        strings.Repeat("c", 64),
			Snapshots:     []sessioncursor.Snapshot{{Source: string(contract.SourceAntigravityCLI), UsageDate: "2026-07-20", Timezone: "UTC", Model: "gemini-3-flash-a", InputTokens: 5, TotalTokens: 5}},
			PendingUpload: &pending,
		},
	}}

	// The rebuild produced groups the pending entry is not part of, so its
	// snapshot must survive restoration with its pending flag intact.
	RestoreHistoryEntriesOutsideFullRebuild(&cursor, retained, map[string]bool{}, testCollectedAt)

	found := false
	for key, entry := range cursor.Files {
		if IsHistoryCorrectionKey(key) {
			t.Fatal("a pending group must not also get a zero correction")
		}
		if entry.PendingUpload != nil && *entry.PendingUpload && len(entry.Snapshots) == 1 {
			found = true
			_ = groupKey
		}
	}
	if !found {
		t.Fatal("expected the pending snapshot to be restored")
	}
}

// --- helpers -------------------------------------------------------------

// legacyCursorFixture builds the cursor shape the TS tests use: statusline
// replay state plus a statusline event entry, an aggregate entry carrying the
// legacy snapshot, and one empty db-row cursor.
func legacyCursorFixture(t *testing.T, model string) sessioncursor.State {
	t.Helper()
	if model == "" {
		model = "Gemini 3.5 Flash (Medium)"
	}
	cursor := sessioncursor.NewState("antigravity-cli")
	if err := cursor.SetExtra("lastScanOffsetBytes", 100); err != nil {
		t.Fatal(err)
	}
	if err := cursor.SetExtra("lastScanGeneration", strings.Repeat("d", 32)); err != nil {
		t.Fatal(err)
	}
	if err := cursor.SetExtra("antigravityStatuslineReplayReady", true); err != nil {
		t.Fatal(err)
	}
	snapshot := sessioncursor.Snapshot{
		Source:       string(contract.SourceAntigravityCLI),
		UsageDate:    "2026-07-20",
		Timezone:     "UTC",
		Model:        model,
		InputTokens:  900,
		OutputTokens: 300,
		TotalTokens:  1200,
		SessionCount: 1,
	}
	entry := sessioncursor.Entry{
		MtimeMs:     float64(time.Date(2026, 7, 20, 10, 0, 0, 0, time.UTC).UnixMilli()),
		SHA256:      strings.Repeat("c", 64),
		Snapshots:   []sessioncursor.Snapshot{snapshot},
		MissingCost: true,
		UpdatedAt:   "2026-07-20T10:00:00.000Z",
	}
	pendingFalse := false
	entry.PendingUpload = &pendingFalse
	cursor.Files["statusline-event\x00"+strings.Repeat("e", 64)] = entry
	cursor.Files[historyAggregatePrefix+strings.Repeat("f", 64)] = entry
	cursor.Files[cursorPrefixCLIDbCascade+strings.Repeat("0", 64)] = sessioncursor.Entry{
		Snapshots:   []sessioncursor.Snapshot{},
		MissingCost: true,
		UpdatedAt:   "2026-07-20T10:00:00.000Z",
	}
	return cursor
}
