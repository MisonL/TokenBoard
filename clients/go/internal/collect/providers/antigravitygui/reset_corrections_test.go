package antigravitygui

import (
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravityhistory"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravitymeta"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// End-to-end db-reset corrections: a recreated database removes an
// acknowledged daily model, and the reset has to replace it with an explicit
// zero (or rebuild it from surviving language-server state) rather than leave
// the server holding stale usage. These mirror
// antigravity-gui-db-reset-corrections.test.ts.

const resetTestTimezone = "Asia/Shanghai"

func resetDbEvent(hash, model string, inputTokens int64) antigravitymeta.UsageEvent {
	return antigravitymeta.UsageEvent{
		CascadeHash:  hashOf("conversation-db"),
		EventHash:    hashOf(hash),
		CreatedAt:    "2026-06-24T00:00:00.000Z",
		Model:        model,
		InputTokens:  inputTokens,
		OutputTokens: 2,
	}
}

func acknowledgeGroup(t *testing.T, stateDir string, snapshots []contract.Snapshot) {
	t.Helper()
	groups := map[string]bool{}
	for _, snapshot := range snapshots {
		groups[snapshot.AckGroupKey()] = true
	}
	if err := AcknowledgeSourceCursor(AcknowledgeSourceInput{
		StateDir: stateDir, Source: contract.SourceAntigravity,
		AcknowledgedGroups: groups, Timezone: resetTestTimezone,
	}); err != nil {
		t.Fatalf("acknowledge: %v", err)
	}
}

func TestResetReplacesAnAcknowledgedDailyModelWithAnExplicitZero(t *testing.T) {
	// Round one uploads gemini-removed=10 and acknowledges it. The database is
	// then recreated without that model: the reset must emit a zero row so the
	// server stops counting the old usage, and the zero row must be retried
	// until it is acknowledged itself.
	options, stateDir := guiTestOptions(t, "antigravity", nil)
	options.Since = "all"
	options.Timezone = resetTestTimezone
	options.ListCascadeIDs = func() ([]string, error) { return nil, nil }

	reads := 0
	options.ReadDbUsageEvents = func(antigravityhistory.Options) (antigravityhistory.Result, error) {
		reads++
		switch reads {
		case 1:
			return antigravityhistory.Result{
				CascadeIDs:                map[string]bool{"conversation-db": true},
				Events:                    []antigravitymeta.UsageEvent{resetDbEvent("a", "gemini-removed", 10)},
				KnownCascadeIDs:           map[string]bool{"conversation-db": true},
				LastReadRowIndexByCascade: map[string]int64{"conversation-db": 41},
				CompleteDirectoryScan:     true,
			}, nil
		default:
			return antigravityhistory.Result{
				CascadeIDs:                map[string]bool{},
				Events:                    []antigravitymeta.UsageEvent{},
				KnownCascadeIDs:           map[string]bool{"conversation-db": true},
				LastReadRowIndexByCascade: map[string]int64{"conversation-db": -1},
				CompleteDirectoryScan:     true,
			}, nil
		}
	}

	first, err := Collect(options)
	if err != nil {
		t.Fatalf("first collect: %v", err)
	}
	if len(first) != 1 || first[0].Model != "gemini-removed" || first[0].InputTokens != 10 {
		t.Fatalf("first = %+v, want gemini-removed=10", first)
	}
	acknowledgeGroup(t, stateDir, first)

	// The database was recreated: its row cursor no longer matches.
	options.ReadDbUsageEvents = func(antigravityhistory.Options) (antigravityhistory.Result, error) {
		reads++
		if reads == 2 {
			return antigravityhistory.Result{}, &antigravityhistory.RowCursorResetError{DBFile: "recreated.db"}
		}
		return antigravityhistory.Result{
			CascadeIDs:                map[string]bool{},
			Events:                    []antigravitymeta.UsageEvent{},
			KnownCascadeIDs:           map[string]bool{"conversation-db": true},
			LastReadRowIndexByCascade: map[string]int64{"conversation-db": -1},
			CompleteDirectoryScan:     true,
		}, nil
	}
	options.CollectedAt = "2026-06-24T02:00:00.000Z"

	replacement, err := Collect(options)
	if err != nil {
		t.Fatalf("replacement collect: %v", err)
	}
	if len(replacement) != 1 {
		t.Fatalf("replacement = %+v, want exactly the zero row", replacement)
	}
	zero := replacement[0]
	if zero.Model != "gemini-removed" || zero.InputTokens != 0 || zero.OutputTokens != 0 ||
		zero.TotalTokens != 0 || zero.SessionCount != 0 {
		t.Fatalf("replacement = %+v, want an explicit zero row for gemini-removed", zero)
	}

	// A rerun before acknowledgement repeats the same zero row.
	options.CollectedAt = "2026-06-24T02:05:00.000Z"
	retry, err := Collect(options)
	if err != nil {
		t.Fatalf("retry collect: %v", err)
	}
	if len(retry) != 1 || retry[0].Model != "gemini-removed" || retry[0].InputTokens != 0 {
		t.Fatalf("retry = %+v, want the zero row replayed", retry)
	}
}

func TestResetKeepsLanguageServerUsageForTheSameModel(t *testing.T) {
	// The language server also reported gemini-shared; the recreated database
	// no longer has it. The reset must not erase the language-server origin's
	// usage for that day.
	options, stateDir := guiTestOptions(t, "antigravity", nil)
	options.Since = "all"
	options.Timezone = resetTestTimezone

	reads := 0
	options.ListCascades = func() ([]CascadeRef, error) {
		return []CascadeRef{{
			ID: "conversation-language-server", MtimeMs: 1_782_250_800_000, Size: 20,
		}}, nil
	}
	options.ReadDbUsageEvents = func(antigravityhistory.Options) (antigravityhistory.Result, error) {
		reads++
		if reads == 1 {
			return antigravityhistory.Result{
				CascadeIDs:                map[string]bool{"conversation-db": true},
				Events:                    []antigravitymeta.UsageEvent{resetDbEvent("a", "gemini-shared", 10)},
				KnownCascadeIDs:           map[string]bool{"conversation-db": true},
				LastReadRowIndexByCascade: map[string]int64{"conversation-db": 41},
				CompleteDirectoryScan:     true,
			}, nil
		}
		if reads == 2 {
			return antigravityhistory.Result{}, &antigravityhistory.RowCursorResetError{DBFile: "recreated.db"}
		}
		return antigravityhistory.Result{
			CascadeIDs:                map[string]bool{},
			Events:                    []antigravitymeta.UsageEvent{},
			KnownCascadeIDs:           map[string]bool{"conversation-db": true},
			LastReadRowIndexByCascade: map[string]int64{"conversation-db": -1},
			CompleteDirectoryScan:     true,
		}, nil
	}
	options.RequestGeneratorMetadata = func(GeneratorMetadataRequest) (any, error) {
		return map[string]any{"generatorMetadata": []any{
			map[string]any{
				"executionId": "response-ls",
				"stepIndices": []any{int64(3)},
				"chatModel": map[string]any{
					"model":             "gemini-shared",
					"chatStartMetadata": map[string]any{"createdAt": "2026-06-24T00:00:00.000Z"},
					"usage": map[string]any{
						"model":           "gemini-shared",
						"inputTokens":     "30",
						"outputTokens":    "2",
						"cacheReadTokens": "0",
						"responseId":      "response-ls",
					},
				},
			},
		}}, nil
	}

	first, err := Collect(options)
	if err != nil {
		t.Fatalf("first collect: %v", err)
	}
	var firstShared int64
	for _, snapshot := range first {
		if snapshot.Model == "gemini-shared" {
			firstShared += snapshot.InputTokens
		}
	}
	if firstShared != 40 {
		t.Fatalf("first gemini-shared input = %d, want 10 (db) + 30 (language server)", firstShared)
	}
	acknowledgeGroup(t, stateDir, first)

	options.CollectedAt = "2026-06-24T02:00:00.000Z"
	rebuilt, err := Collect(options)
	if err != nil {
		t.Fatalf("rebuilt collect: %v", err)
	}
	var rebuiltShared int64
	for _, snapshot := range rebuilt {
		if snapshot.Model == "gemini-shared" {
			rebuiltShared += snapshot.InputTokens
		}
	}
	if rebuiltShared < 30 {
		t.Fatalf("rebuilt gemini-shared input = %d, want the language-server 30 retained after the reset", rebuiltShared)
	}
}

func TestResetRebuildsADailyModelFromRecreatedDatabaseAndLanguageServerState(t *testing.T) {
	// The recreated database contributes a new event for the same model, and
	// the language-server origin's usage survives the reset: the rebuilt day
	// is their sum, with the reset's zero correction folded away rather than
	// uploading a spurious zero.
	options, stateDir := guiTestOptions(t, "antigravity", nil)
	options.Since = "all"
	options.Timezone = resetTestTimezone
	options.ListCascades = func() ([]CascadeRef, error) {
		return []CascadeRef{{
			ID: "conversation-language-server", MtimeMs: 1_782_250_800_000, Size: 20,
		}}, nil
	}
	reads := 0
	options.ReadDbUsageEvents = func(antigravityhistory.Options) (antigravityhistory.Result, error) {
		reads++
		switch {
		case reads == 1:
			return antigravityhistory.Result{
				CascadeIDs:                map[string]bool{"conversation-db": true},
				Events:                    []antigravitymeta.UsageEvent{resetDbEvent("a", "gemini-shared", 10)},
				KnownCascadeIDs:           map[string]bool{"conversation-db": true},
				LastReadRowIndexByCascade: map[string]int64{"conversation-db": 41},
				CompleteDirectoryScan:     true,
			}, nil
		case reads == 2:
			return antigravityhistory.Result{}, &antigravityhistory.RowCursorResetError{DBFile: "recreated.db"}
		default:
			return antigravityhistory.Result{
				CascadeIDs:                map[string]bool{"conversation-db": true},
				Events:                    []antigravitymeta.UsageEvent{resetDbEvent("c", "gemini-shared", 20)},
				KnownCascadeIDs:           map[string]bool{"conversation-db": true},
				LastReadRowIndexByCascade: map[string]int64{"conversation-db": 2},
				CompleteDirectoryScan:     true,
			}, nil
		}
	}
	options.RequestGeneratorMetadata = func(GeneratorMetadataRequest) (any, error) {
		return map[string]any{"generatorMetadata": []any{
			map[string]any{
				"executionId": "response-ls",
				"stepIndices": []any{int64(3)},
				"chatModel": map[string]any{
					"model":             "gemini-shared",
					"chatStartMetadata": map[string]any{"createdAt": "2026-06-24T00:00:00.000Z"},
					"usage": map[string]any{
						"model":           "gemini-shared",
						"inputTokens":     "30",
						"outputTokens":    "2",
						"cacheReadTokens": "0",
						"responseId":      "response-ls",
					},
				},
			},
		}}, nil
	}

	first, err := Collect(options)
	if err != nil {
		t.Fatalf("first collect: %v", err)
	}
	acknowledgeGroup(t, stateDir, first)

	options.CollectedAt = "2026-06-24T02:00:00.000Z"
	rebuilt, err := Collect(options)
	if err != nil {
		t.Fatalf("rebuilt collect: %v", err)
	}
	var rebuiltShared int64
	var rebuiltSessions int64
	for _, snapshot := range rebuilt {
		if snapshot.Model == "gemini-shared" {
			rebuiltShared += snapshot.InputTokens
			rebuiltSessions += snapshot.SessionCount
		}
	}
	if rebuiltShared != 50 {
		t.Fatalf("rebuilt gemini-shared input = %d, want 20 (recreated db) + 30 (language server)", rebuiltShared)
	}
	if rebuiltSessions != 2 {
		t.Fatalf("rebuilt gemini-shared sessionCount = %d, want 2", rebuiltSessions)
	}
	if reads != 3 {
		t.Fatalf("db reads = %d, want 3 (original, reset, rebuild)", reads)
	}
}
