package antigravitygui

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravityhistory"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravitymeta"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

const guiTestCollectedAt = "2026-06-24T02:00:00.000Z"

// guiTestOptions is a collection with an injected cascade list and metadata
// source, so no language server is spawned.
func guiTestOptions(t *testing.T, source string, mutate func(*Options)) (Options, string) {
	t.Helper()
	stateDir := t.TempDir()
	options := Options{
		Source:      source,
		StateDir:    stateDir,
		Timezone:    guiTimezone,
		CollectedAt: guiTestCollectedAt,
		Env:         func(string) string { return "" },
		ListCascadeIDs: func() ([]string, error) {
			return []string{"conversation-a"}, nil
		},
		RequestGeneratorMetadata: func(GeneratorMetadataRequest) (any, error) {
			return guiMetadataResponse(source), nil
		},
	}
	if mutate != nil {
		mutate(&options)
	}
	return options, stateDir
}

func guiMetadataResponse(source string) any {
	// Three items: the first two share a responseId (so they fold into one
	// session), the third is a distinct one. Token counts match the TS fixture.
	item := func(executionID string, step int, usage map[string]any) map[string]any {
		chatUsage := map[string]any{
			"model":           "Gemini 3.5 Flash (Medium)",
			"inputTokens":     "10",
			"outputTokens":    "2",
			"cacheReadTokens": "0",
			"responseId":      "response-a",
		}
		for key, value := range usage {
			chatUsage[key] = value
		}
		return map[string]any{
			"executionId": executionID,
			"stepIndices": []any{int64(step)},
			"chatModel": map[string]any{
				"model":             "Gemini 3.5 Flash (Medium)",
				"chatStartMetadata": map[string]any{"createdAt": "2026-06-23T16:30:00.000Z"},
				"usage":             chatUsage,
			},
		}
	}
	return map[string]any{
		"generatorMetadata": []any{
			item("execution-a", 3, map[string]any{
				"model":                "Gemini 3.5 Flash (Medium)",
				"inputTokens":          "100",
				"outputTokens":         "20",
				"thinkingOutputTokens": "15",
				"responseOutputTokens": "5",
				"cacheReadTokens":      "30",
				"responseHeader":       map[string]any{"sessionID": "session-a"},
			}),
			item("execution-a", 3, map[string]any{
				"inputTokens":     "100",
				"outputTokens":    "20",
				"cacheReadTokens": "30",
				"responseHeader":  map[string]any{"sessionID": "session-a"},
			}),
			item("execution-b", 4, map[string]any{
				"inputTokens":     "20",
				"outputTokens":    "4",
				"cacheReadTokens": "0",
				"responseId":      "response-b",
			}),
		},
	}
}

func TestCollectGuiUsesLanguageServerMetadata(t *testing.T) {
	options, _ := guiTestOptions(t, "antigravity", nil)
	snapshots, err := Collect(options)
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	if len(snapshots) == 0 {
		t.Fatal("no snapshots collected")
	}
	for _, snapshot := range snapshots {
		if snapshot.Source != contract.SourceAntigravity {
			t.Fatalf("source = %q, want antigravity", snapshot.Source)
		}
		if snapshot.CostUSD != 0 {
			t.Fatalf("costUsd = %v, want 0 (Antigravity cost is unavailable)", snapshot.CostUSD)
		}
	}
}

func TestCollectGuiNeverPersistsRawIdentifiers(t *testing.T) {
	options, stateDir := guiTestOptions(t, "antigravity", nil)
	if _, err := Collect(options); err != nil {
		t.Fatalf("collect: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(stateDir, "antigravity-cursor.json"))
	if err != nil {
		t.Fatalf("read cursor: %v", err)
	}
	for _, forbidden := range []string{"conversation-a", "response-a", "response-b", "execution-a", "execution-b", "session-a"} {
		if strings.Contains(string(raw), forbidden) {
			t.Fatalf("cursor contains the raw identifier %q", forbidden)
		}
	}
}

func TestCollectGuiPersistsHashedScanStateOnly(t *testing.T) {
	conversationDir := t.TempDir()
	cascadeID := "11111111-1111-1111-1111-111111111111"
	if err := os.WriteFile(filepath.Join(conversationDir, cascadeID+".pb"), []byte("cascade"), 0o600); err != nil {
		t.Fatal(err)
	}
	options, stateDir := guiTestOptions(t, "antigravity", func(options *Options) {
		options.ConversationDir = conversationDir
		options.ListCascadeIDs = nil
	})
	if _, err := Collect(options); err != nil {
		t.Fatalf("collect: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(stateDir, "antigravity-cursor.json"))
	if err != nil {
		t.Fatalf("read cursor: %v", err)
	}
	if strings.Contains(string(raw), cascadeID) {
		t.Fatal("the cursor persisted the raw cascade id")
	}
	if !strings.Contains(string(raw), "antigravityCascadeFileScan") {
		t.Fatal("the cascade file scan state was not persisted")
	}
}

func TestCollectGuiRetriesPendingSnapshotsUntilAcknowledged(t *testing.T) {
	options, stateDir := guiTestOptions(t, "antigravity-ide", nil)

	first, err := Collect(options)
	if err != nil {
		t.Fatalf("first collect: %v", err)
	}
	if len(first) == 0 {
		t.Fatal("the first run collected nothing")
	}

	options.CollectedAt = "2026-06-24T02:05:00.000Z"
	second, err := Collect(options)
	if err != nil {
		t.Fatalf("second collect: %v", err)
	}
	if len(second) != len(first) {
		t.Fatalf("second run = %d rows, want the pending %d replayed", len(second), len(first))
	}
	for index := range second {
		if second[index].CollectedAt != "2026-06-24T02:05:00.000Z" {
			t.Fatalf("replayed row %d collectedAt = %q, want the new run's stamp",
				index, second[index].CollectedAt)
		}
	}

	groups := map[string]bool{}
	for _, snapshot := range first {
		groups[snapshot.AckGroupKey()] = true
	}
	if err := AcknowledgeSourceCursor(AcknowledgeSourceInput{
		StateDir: stateDir, Source: contract.SourceAntigravityIDE,
		AcknowledgedGroups: groups, Timezone: guiTimezone,
	}); err != nil {
		t.Fatalf("acknowledge: %v", err)
	}

	options.CollectedAt = "2026-06-24T02:10:00.000Z"
	third, err := Collect(options)
	if err != nil {
		t.Fatalf("third collect: %v", err)
	}
	if len(third) != 0 {
		t.Fatalf("third run = %d rows, want none after acknowledgement", len(third))
	}
}

func TestCollectGuiIsolatesCursorsByServerScope(t *testing.T) {
	options, stateDir := guiTestOptions(t, "antigravity", nil)
	options.CursorScope = "https://prod.example.com"
	first, err := Collect(options)
	if err != nil {
		t.Fatalf("first collect: %v", err)
	}

	options.CursorScope = "https://private.example.com"
	options.CollectedAt = "2026-06-24T02:05:00.000Z"
	second, err := Collect(options)
	if err != nil {
		t.Fatalf("second collect: %v", err)
	}
	if len(second) != len(first) {
		t.Fatalf("the second server's run = %d rows, want its own %d (cursors must not be shared)",
			len(second), len(first))
	}

	entries, err := os.ReadDir(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	cursors := 0
	for _, entry := range entries {
		if strings.Contains(entry.Name(), "cursor") {
			cursors++
		}
	}
	if cursors != 2 {
		t.Fatalf("cursor files = %d, want one per server", cursors)
	}
}

func TestCollectGuiPartialErrorCarriesDbSnapshotsAndIsFatal(t *testing.T) {
	// A failure that names no known unavailable cause is a real collection
	// failure: the DB snapshots still ride along, but the run must report it.
	options, _ := guiTestOptions(t, "antigravity", func(options *Options) {
		options.ReadDbUsageEvents = func(antigravityhistory.Options) (antigravityhistory.Result, error) {
			return antigravityhistory.Result{
				CascadeIDs:                map[string]bool{},
				Events:                    []antigravitymeta.UsageEvent{guiDbEvent()},
				KnownCascadeIDs:           map[string]bool{},
				LastReadRowIndexByCascade: map[string]int64{},
			}, nil
		}
		options.RequestGeneratorMetadata = func(GeneratorMetadataRequest) (any, error) {
			return nil, errors.New("metadata unavailable")
		}
	})

	_, err := Collect(options)
	partial, ok := IsPartialUsageError(err)
	if !ok {
		t.Fatalf("err = %v, want a partial usage error", err)
	}
	if len(partial.Snapshots) == 0 {
		t.Fatal("the partial error carried no snapshots")
	}
	if !partial.Fatal {
		t.Fatal("an unrecognized metadata failure is not an unavailable language server, so the error must be fatal")
	}
	if !strings.Contains(partial.Message, "after DB history was collected") {
		t.Fatalf("message = %q, want it to name the DB history", partial.Message)
	}
}

func TestCollectGuiMetadataHTTPFailureIsUnavailable(t *testing.T) {
	// The TS classifier treats an HTTP-level metadata failure as "the language
	// server is not usable here", so the partial error stays non-fatal.
	options, _ := guiTestOptions(t, "antigravity", func(options *Options) {
		options.ReadDbUsageEvents = func(antigravityhistory.Options) (antigravityhistory.Result, error) {
			return antigravityhistory.Result{
				CascadeIDs:                map[string]bool{},
				Events:                    []antigravitymeta.UsageEvent{guiDbEvent()},
				KnownCascadeIDs:           map[string]bool{},
				LastReadRowIndexByCascade: map[string]int64{},
			}, nil
		}
		options.RequestGeneratorMetadata = func(GeneratorMetadataRequest) (any, error) {
			return nil, errors.New("Antigravity metadata request failed for antigravity: HTTP 500")
		}
	})

	_, err := Collect(options)
	partial, ok := IsPartialUsageError(err)
	if !ok {
		t.Fatalf("err = %v, want a partial usage error", err)
	}
	if partial.Fatal {
		t.Fatal("an HTTP metadata failure is classified as unavailable, so the partial error must not be fatal")
	}
}

func TestCollectGuiUnavailableLanguageServerIsNotFatal(t *testing.T) {
	options, _ := guiTestOptions(t, "antigravity", func(options *Options) {
		options.ReadDbUsageEvents = func(antigravityhistory.Options) (antigravityhistory.Result, error) {
			return antigravityhistory.Result{
				CascadeIDs:                map[string]bool{},
				Events:                    []antigravitymeta.UsageEvent{guiDbEvent()},
				KnownCascadeIDs:           map[string]bool{},
				LastReadRowIndexByCascade: map[string]int64{},
			}, nil
		}
		options.RequestGeneratorMetadata = func(GeneratorMetadataRequest) (any, error) {
			return nil, errors.New("Antigravity language server exited before it was ready")
		}
	})

	_, err := Collect(options)
	partial, ok := IsPartialUsageError(err)
	if !ok {
		t.Fatalf("err = %v, want a partial usage error", err)
	}
	if partial.Fatal {
		t.Fatal("an absent language server must not be fatal")
	}
	if !strings.Contains(partial.Message, "language server unavailable") {
		t.Fatalf("message = %q, want the unavailable classification", partial.Message)
	}
}

func TestCollectGuiSurfacesRealDbErrors(t *testing.T) {
	options, _ := guiTestOptions(t, "antigravity", func(options *Options) {
		options.ReadDbUsageEvents = func(antigravityhistory.Options) (antigravityhistory.Result, error) {
			return antigravityhistory.Result{}, errors.New("Antigravity SQLite metadata query failed")
		}
	})
	_, err := Collect(options)
	if err == nil {
		t.Fatal("a real SQLite failure must not be swallowed")
	}
	if _, ok := IsPartialUsageError(err); ok {
		t.Fatal("a real SQLite failure is not a partial-usage case")
	}
	if !strings.Contains(err.Error(), "SQLite metadata query failed") {
		t.Fatalf("err = %v, want the SQLite failure", err)
	}
}

func TestCollectGuiSkipsUnavailableDbAndUsesLanguageServer(t *testing.T) {
	options, _ := guiTestOptions(t, "antigravity", func(options *Options) {
		options.ReadDbUsageEvents = func(antigravityhistory.Options) (antigravityhistory.Result, error) {
			return antigravityhistory.Result{}, &unavailableError{}
		}
	})
	snapshots, err := Collect(options)
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	if len(snapshots) == 0 {
		t.Fatal("an unavailable SQLite reader must still leave the language-server route usable")
	}
}

func TestCollectGuiFullHistoryRequiresCompleteDirectoryScan(t *testing.T) {
	options, _ := guiTestOptions(t, "antigravity", func(options *Options) {
		options.Since = "all"
		options.ReadDbUsageEvents = func(antigravityhistory.Options) (antigravityhistory.Result, error) {
			return antigravityhistory.Result{
				CascadeIDs:                map[string]bool{},
				Events:                    []antigravitymeta.UsageEvent{},
				KnownCascadeIDs:           map[string]bool{},
				LastReadRowIndexByCascade: map[string]int64{},
				CompleteDirectoryScan:     false,
			}, nil
		}
	})
	_, err := Collect(options)
	if err == nil || !strings.Contains(err.Error(), "requires a complete SQLite directory scan") {
		t.Fatalf("err = %v, want the incomplete-scan refusal", err)
	}
}

func TestCollectGuiPersistsCursorProgressBeforeLaterCascadeFails(t *testing.T) {
	options, stateDir := guiTestOptions(t, "antigravity", func(options *Options) {
		options.ListCascadeIDs = func() ([]string, error) {
			return []string{"conversation-a", "conversation-b"}, nil
		}
		options.ReadDbUsageEvents = func(antigravityhistory.Options) (antigravityhistory.Result, error) {
			return antigravityhistory.Result{
				CascadeIDs:                map[string]bool{},
				Events:                    []antigravitymeta.UsageEvent{guiDbEvent()},
				KnownCascadeIDs:           map[string]bool{},
				LastReadRowIndexByCascade: map[string]int64{},
			}, nil
		}
		requests := 0
		options.RequestGeneratorMetadata = func(request GeneratorMetadataRequest) (any, error) {
			requests++
			if requests > 1 {
				return nil, errors.New("Antigravity metadata request failed for antigravity: HTTP 503")
			}
			return guiMetadataResponse("antigravity"), nil
		}
	})

	_, err := Collect(options)
	if _, ok := IsPartialUsageError(err); !ok {
		t.Fatalf("err = %v, want a partial usage error", err)
	}

	// The first cascade's progress was persisted before the second failed, so
	// the next run does not ask for it again.
	raw, readErr := os.ReadFile(filepath.Join(stateDir, "antigravity-cursor.json"))
	if readErr != nil {
		t.Fatalf("read cursor: %v", readErr)
	}
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("parse cursor: %v", err)
	}
	files, ok := parsed["files"].(map[string]any)
	if !ok {
		t.Fatal("the cursor has no files map")
	}
	cascadeEntries := 0
	for key := range files {
		if strings.HasPrefix(key, "cascade\x00") {
			cascadeEntries++
		}
	}
	if cascadeEntries != 1 {
		t.Fatalf("cascade cursor entries = %d, want the first cascade's progress persisted", cascadeEntries)
	}
}

func TestCollectGuiUsesDbHistoryAndSkipsLanguageServerWhenCovered(t *testing.T) {
	// A cascade the SQLite history already covered must not be requested from
	// the language server.
	requests := 0
	options, _ := guiTestOptions(t, "antigravity", func(options *Options) {
		options.ListCascadeIDs = func() ([]string, error) {
			return []string{"conversation-a"}, nil
		}
		options.ReadDbUsageEvents = func(antigravityhistory.Options) (antigravityhistory.Result, error) {
			return antigravityhistory.Result{
				CascadeIDs:                map[string]bool{"conversation-a": true},
				Events:                    []antigravitymeta.UsageEvent{guiDbEvent()},
				KnownCascadeIDs:           map[string]bool{"conversation-a": true},
				LastReadRowIndexByCascade: map[string]int64{"conversation-a": 3},
			}, nil
		}
		options.RequestGeneratorMetadata = func(GeneratorMetadataRequest) (any, error) {
			requests++
			return guiMetadataResponse("antigravity"), nil
		}
	})
	if _, err := Collect(options); err != nil {
		t.Fatalf("collect: %v", err)
	}
	if requests != 0 {
		t.Fatalf("language-server requests = %d, want 0 for a DB-covered cascade", requests)
	}
}

// guiDbEvent is one in-range SQLite history event.
func guiDbEvent() antigravitymeta.UsageEvent {
	return antigravitymeta.UsageEvent{
		CascadeHash: hashOf("conversation-db"),
		EventHash:   hashOf("db-event-1"),
		CreatedAt:   "2026-06-24T01:00:00.000Z",
		Model:       "Gemini 3.5 Flash (Medium)",
		InputTokens: 40,
	}
}
