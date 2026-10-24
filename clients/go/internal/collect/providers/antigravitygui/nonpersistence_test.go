package antigravitygui

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravityhistory"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravitymeta"
)

// The Antigravity sources carry raw conversation content (prompts, replies,
// file paths, workspace names) beside the token metadata the collector wants.
// Nothing that content touches may reach the event, the snapshot, the cursor,
// the diagnostics, or the upload payload. These tests drive real content
// through the whole GUI chain and assert its absence at every layer.

// rawContentSecrets are the strings a real conversation would leak.
var rawContentSecrets = []string{
	"a real prompt about the customer database",
	"the assistant reply quoting the schema",
	"/Users/someone/secret/project/src/main.ts",
	"someone@example.com",
}

// rawContentResponse is a language-server response whose metadata items also
// carry the content fields a real response has.
func rawContentResponse() map[string]any {
	leak := func() map[string]any {
		return map[string]any{
			"prompt":              rawContentSecrets[0],
			"completion":          rawContentSecrets[1],
			"promptSections":      []any{map[string]any{"content": rawContentSecrets[0]}},
			"conversationHistory": []any{map[string]any{"content": rawContentSecrets[1]}},
			"path":                rawContentSecrets[2],
			"email":               rawContentSecrets[3],
		}
	}
	item := func(executionID, responseID string, tokens map[string]any) map[string]any {
		usage := map[string]any{
			"model":           "Gemini 3.5 Flash (Medium)",
			"inputTokens":     "10",
			"outputTokens":    "2",
			"cacheReadTokens": "0",
			"responseId":      responseID,
		}
		for key, value := range tokens {
			usage[key] = value
		}
		record := map[string]any{
			"executionId": executionID,
			"stepIndices": []any{int64(3)},
			"chatModel": map[string]any{
				"model":             "Gemini 3.5 Flash (Medium)",
				"chatStartMetadata": map[string]any{"createdAt": "2026-06-23T16:30:00.000Z"},
				"usage":             usage,
			},
		}
		for key, value := range leak() {
			record[key] = value
		}
		return record
	}
	return map[string]any{
		"generatorMetadata": []any{
			item("execution-a", "response-a", map[string]any{"inputTokens": "100", "outputTokens": "20"}),
			item("execution-b", "response-b", map[string]any{"inputTokens": "20", "outputTokens": "4"}),
		},
	}
}

// assertNoRawContent fails if any secret appears in the serialized value.
func assertNoRawContent(t *testing.T, label string, value any) {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("%s: marshal: %v", label, err)
	}
	for _, secret := range rawContentSecrets {
		if bytes.Contains(encoded, []byte(secret)) {
			t.Fatalf("%s leaked %q", label, secret)
		}
	}
}

func TestRawContentNeverReachesSnapshotsCursorOrLogs(t *testing.T) {
	stateDir := t.TempDir()
	var diagnostics bytes.Buffer
	options := Options{
		Source:      "antigravity",
		StateDir:    stateDir,
		Timezone:    guiTimezone,
		CollectedAt: guiTestCollectedAt,
		Env:         func(string) string { return "" },
		ListCascadeIDs: func() ([]string, error) {
			return []string{"conversation-a"}, nil
		},
		RequestGeneratorMetadata: func(GeneratorMetadataRequest) (any, error) {
			return rawContentResponse(), nil
		},
		ReadDbUsageEvents: func(antigravityhistory.Options) (antigravityhistory.Result, error) {
			return antigravityhistory.Result{
				CascadeIDs:                map[string]bool{},
				Events:                    []antigravitymeta.UsageEvent{},
				KnownCascadeIDs:           map[string]bool{},
				LastReadRowIndexByCascade: map[string]int64{},
			}, nil
		},
		Stderr: func(line string) { diagnostics.WriteString(line + "\n") },
	}

	snapshots, err := Collect(options)
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	if len(snapshots) == 0 {
		t.Fatal("the raw-content response should still yield usage")
	}

	// The snapshots are what uploads: no content field may have been projected.
	assertNoRawContent(t, "snapshots", snapshots)

	// The cursor is the other file that persists: it must hold hashes only.
	raw, err := os.ReadFile(filepath.Join(stateDir, "antigravity-cursor.json"))
	if err != nil {
		t.Fatalf("read cursor: %v", err)
	}
	for _, secret := range rawContentSecrets {
		if bytes.Contains(raw, []byte(secret)) {
			t.Fatalf("the cursor leaked %q", secret)
		}
	}

	// Diagnostics go to the scheduled log, which is long-lived.
	if strings.Contains(diagnostics.String(), rawContentSecrets[0]) {
		t.Fatal("the diagnostics leaked the prompt")
	}

	// The upload payload is the serialized snapshots; assert on the bytes that
	// would actually be sent.
	payload, err := json.Marshal(map[string]any{"snapshots": snapshots})
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range rawContentSecrets {
		if bytes.Contains(payload, []byte(secret)) {
			t.Fatalf("the upload payload leaked %q", secret)
		}
	}
}

func TestRawContentNeverReachesTheEvent(t *testing.T) {
	// The parser is the projection boundary: a response carrying raw content
	// yields an event that holds only usage metadata.
	events, err := antigravitymeta.ParseGeneratorMetadata(rawContentResponse(), "conversation-a")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(events) == 0 {
		t.Fatal("no events parsed")
	}
	assertNoRawContent(t, "parsed events", events)
}
