package antigravitygui

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravityhistory"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravitymeta"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessioncursor"
)

// Bounded-scope migration and the coverage it must reopen. Mirrors
// antigravity-gui-since.test.ts.

func TestMigratesResidualBoundedScopesAndKeepsTheFurthestRow(t *testing.T) {
	// Two residual bounded scopes for the same conversation migrate onto the
	// current scope; the merged cursor must keep the furthest row progress, or
	// the next bounded read would re-read rows the earlier window covered.
	cursor := sessioncursor.NewState("antigravity")
	cascadeHash := hashOf("conversation-a")
	earlier := scopeFor(t, "20260601")
	residual := scopeFor(t, "20260620")
	current := scopeFor(t, "20260624")

	for scope, row := range map[string]float64{earlier: 7, residual: 5} {
		cursor.Files["db\x00antigravity\x00since:"+scope+"\x00"+cascadeHash] = rowAnchorEntry(row)
	}

	PrepareGuiHistoryScope(&cursor, "antigravity", current)

	rows := LastSeenDbRowIndexByCascadeHash(cursor, "antigravity", current)
	if len(rows) != 1 || rows[cascadeHash] != 7 {
		t.Fatalf("migrated rows = %v, want the furthest 7", rows)
	}
	for key := range cursor.Files {
		if key != "db\x00antigravity\x00since:"+current+"\x00"+cascadeHash {
			t.Fatalf("leftover key %q after migration", key)
		}
	}
}

func TestReopensDatabaseCoverageAfterAReset(t *testing.T) {
	// A reset discards the database-covered markers, so a conversation the
	// database used to cover has to be asked about again: its history was
	// rebuilt and the language server may hold what the new database lacks.
	options, stateDir := guiTestOptions(t, "antigravity", nil)
	options.Since = "all"
	cascadeID := "conversation-db"
	options.ListCascadeIDs = nil
	options.ListCascades = func() ([]CascadeRef, error) {
		return []CascadeRef{{ID: cascadeID, MtimeMs: 1_782_250_800_000, Size: 20}}, nil
	}
	reads := 0
	options.ReadDbUsageEvents = func(antigravityhistory.Options) (antigravityhistory.Result, error) {
		reads++
		switch {
		case reads == 1:
			return antigravityhistory.Result{
				CascadeIDs:                map[string]bool{cascadeID: true},
				Events:                    []antigravitymeta.UsageEvent{resetDbEvent("a", "gemini-retained", 10)},
				KnownCascadeIDs:           map[string]bool{cascadeID: true},
				LastReadRowIndexByCascade: map[string]int64{cascadeID: 41},
				CompleteDirectoryScan:     true,
			}, nil
		case reads == 2:
			return antigravityhistory.Result{}, &antigravityhistory.RowCursorResetError{DBFile: "recreated.db"}
		default:
			return antigravityhistory.Result{
				CascadeIDs:                map[string]bool{},
				Events:                    []antigravitymeta.UsageEvent{},
				KnownCascadeIDs:           map[string]bool{cascadeID: true},
				LastReadRowIndexByCascade: map[string]int64{cascadeID: -1},
				CompleteDirectoryScan:     true,
			}, nil
		}
	}
	var requests []string
	options.RequestGeneratorMetadata = func(request GeneratorMetadataRequest) (any, error) {
		requests = append(requests, request.CascadeID)
		return guiMetadataResponse("antigravity"), nil
	}

	first, err := Collect(options)
	if err != nil {
		t.Fatalf("first collect: %v", err)
	}
	if len(requests) != 0 {
		t.Fatalf("requests = %v, want none while the database covers the conversation", requests)
	}
	acknowledgeAll(t, stateDir, first)

	options.CollectedAt = "2026-06-24T02:00:00.000Z"
	if _, err := Collect(options); err != nil {
		t.Fatalf("reset collect: %v", err)
	}
	if len(requests) != 1 || requests[0] != cascadeID {
		t.Fatalf("requests = %v, want the reset to reopen the conversation", requests)
	}
}

// rowAnchorEntry is a database row cursor whose progress lives in mtimeMs, the
// way MarkDbCascadeRowsProcessed writes it.
func rowAnchorEntry(rowIndex float64) sessioncursor.Entry {
	pending := false
	return sessioncursor.Entry{
		MtimeMs:       rowIndex,
		SHA256:        hashOf("anchor"),
		PendingUpload: &pending,
		UpdatedAt:     guiTestCollectedAt,
	}
}

func TestOutOfRangeSqliteRowsDoNotHideCurrentLanguageServerEvents(t *testing.T) {
	// A database row dated before the window must not mark the conversation as
	// covered: the language server still has to be asked, and its in-range
	// event uploads.
	options, _ := guiTestOptions(t, "antigravity", nil)
	options.Since = "20260624"
	options.Timezone = "Asia/Shanghai"
	cascadeID := "conversation-shared"
	options.ListCascadeIDs = nil
	options.ListCascades = func() ([]CascadeRef, error) {
		return []CascadeRef{{ID: cascadeID, MtimeMs: 1_782_250_800_000, Size: 20}}, nil
	}
	options.ReadDbUsageEvents = func(antigravityhistory.Options) (antigravityhistory.Result, error) {
		return antigravityhistory.Result{
			CascadeIDs: map[string]bool{cascadeID: true},
			Events: []antigravitymeta.UsageEvent{{
				CascadeHash:  hashOf(cascadeID),
				EventHash:    hashOf("b"),
				CreatedAt:    "2026-06-23T15:59:59.000Z",
				Model:        "gemini-old",
				InputTokens:  10,
				OutputTokens: 2,
			}},
			KnownCascadeIDs:           map[string]bool{cascadeID: true},
			LastReadRowIndexByCascade: map[string]int64{cascadeID: 1},
		}, nil
	}
	requests := 0
	options.RequestGeneratorMetadata = func(GeneratorMetadataRequest) (any, error) {
		requests++
		return map[string]any{"generatorMetadata": []any{
			map[string]any{
				"executionId": "response-current",
				"stepIndices": []any{int64(3)},
				"chatModel": map[string]any{
					"model":             "gemini-current",
					"chatStartMetadata": map[string]any{"createdAt": "2026-06-23T16:00:00.000Z"},
					"usage": map[string]any{
						"model":           "gemini-current",
						"inputTokens":     "40",
						"outputTokens":    "2",
						"cacheReadTokens": "0",
						"responseId":      "response-current",
					},
				},
			},
		}}, nil
	}

	snapshots, err := Collect(options)
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	if requests != 1 {
		t.Fatalf("requests = %d, want the out-of-range DB row not to hide the language server", requests)
	}
	if len(snapshots) != 1 || snapshots[0].Model != "gemini-current" || snapshots[0].InputTokens != 40 {
		t.Fatalf("snapshots = %+v, want the in-range language-server event only", snapshots)
	}
}

func TestBoundedScanSurfacesARowCursorResetInsteadOfRecovering(t *testing.T) {
	// Recovery is a full-history-only operation: a bounded run must not throw
	// away its window just because the database was recreated.
	options, stateDir := guiTestOptions(t, "antigravity", nil)
	options.Since = "20260624"
	options.ListCascadeIDs = func() ([]string, error) { return nil, nil }
	reads := 0
	options.ReadDbUsageEvents = func(antigravityhistory.Options) (antigravityhistory.Result, error) {
		reads++
		if reads == 1 {
			return antigravityhistory.Result{
				CascadeIDs:                map[string]bool{},
				Events:                    []antigravitymeta.UsageEvent{},
				KnownCascadeIDs:           map[string]bool{},
				LastReadRowIndexByCascade: map[string]int64{"conversation-db": 41},
			}, nil
		}
		return antigravityhistory.Result{}, &antigravityhistory.RowCursorResetError{DBFile: "recreated.db"}
	}

	if _, err := Collect(options); err != nil {
		t.Fatalf("first collect: %v", err)
	}
	_, err := Collect(options)
	if err == nil {
		t.Fatal("a bounded run must surface the reset instead of rebuilding")
	}
	if !strings.Contains(err.Error(), "cursor reset detected") {
		t.Fatalf("err = %v, want the reset error", err)
	}
	if reads != 2 {
		t.Fatalf("db reads = %d, want no recovery retry in a bounded run", reads)
	}
	if _, statErr := os.Stat(filepath.Join(stateDir, "antigravity-cursor.json")); statErr != nil {
		t.Fatalf("the cursor must still exist after the bounded failure: %v", statErr)
	}
}

func TestIncompleteFullHistoryScanIsRejectedBeforeTheCursorIsCommitted(t *testing.T) {
	options, stateDir := guiTestOptions(t, "antigravity", nil)
	options.Since = "all"
	options.ListCascadeIDs = func() ([]string, error) { return nil, nil }
	var required *bool
	options.ReadDbUsageEvents = func(readOptions antigravityhistory.Options) (antigravityhistory.Result, error) {
		value := readOptions.RequireCompleteDirectoryScan
		required = &value
		return antigravityhistory.Result{
			CascadeIDs:                map[string]bool{"conversation-db": true},
			Events:                    []antigravitymeta.UsageEvent{resetDbEvent("a", "gemini-incomplete", 10)},
			KnownCascadeIDs:           map[string]bool{"conversation-db": true},
			LastReadRowIndexByCascade: map[string]int64{"conversation-db": 41},
			CompleteDirectoryScan:     false,
		}, nil
	}

	_, err := Collect(options)
	if err == nil || !strings.Contains(err.Error(), "requires a complete SQLite directory scan") {
		t.Fatalf("err = %v, want the incomplete-scan rejection", err)
	}
	if required == nil || !*required {
		t.Fatal("the full-history read must require a complete directory scan")
	}
	if _, statErr := os.Stat(filepath.Join(stateDir, "antigravity-cursor.json")); !os.IsNotExist(statErr) {
		t.Fatalf("cursor exists after a rejected scan: %v", statErr)
	}
}
