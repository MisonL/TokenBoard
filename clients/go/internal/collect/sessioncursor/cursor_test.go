package sessioncursor

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

// A realistic cursor produced by the TS collector (shape taken from a live
// antigravity-cli cursor; content trimmed). Go must parse it, re-serialize
// it, and lose nothing the TS validator would have kept.
const tsCursorFixture = `{
  "version": 1,
  "source": "antigravity-cli",
  "antigravityCliMeteringVersion": 3,
  "antigravityCliHistoryComplete": true,
  "antigravityCliHistoryCompacted": true,
  "antigravityCliHistoryCompactedThroughDate": "2026-06-20",
  "antigravityDbFileScan": {"cursor": {"db": 5}, "completed": true},
  "files": {
    "aggregate 3c57847bb04f5600b4dadb22ffc57f564ca44b8f1c6b901969": {
      "size": 1234,
      "mtimeMs": 1751430000000.5,
      "sha256": "3c57847bb04f5600b4dadb22ffc57f564ca44b8f1c6b90196900112233445566",
      "snapshots": [
        {
          "source": "antigravity-cli",
          "usageDate": "2026-07-02",
          "timezone": "Asia/Shanghai",
          "model": "claude-sonnet-4-6",
          "inputTokens": 266941,
          "outputTokens": 29026,
          "cacheCreationTokens": 0,
          "cacheReadTokens": 1694106,
          "totalTokens": 1990073,
          "costUsd": 0,
          "sessionCount": 4
        }
      ],
      "missingCost": false,
      "pendingUpload": true,
      "updatedAt": "2026-07-02T10:00:00.000Z"
    },
    "statusline-scan since:2026-07-22@Asia%2FShanghai": {
      "size": 10,
      "mtimeMs": 1753200000000,
      "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "contentHashAlgo": "v2-lines",
      "snapshots": [],
      "missingCost": true,
      "statuslineClaimed": true,
      "updatedAt": "2026-07-22T00:00:00.000Z"
    }
  }
}`

func writeTemp(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "cursor.json")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestReadTSCursorFixture(t *testing.T) {
	path := writeTemp(t, tsCursorFixture)
	state, err := Read(path, "antigravity-cli")
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if state.Version != 1 || state.Source != "antigravity-cli" || len(state.Files) != 2 {
		t.Fatalf("unexpected state: %+v", state)
	}
	aggregate := state.Files["aggregate 3c57847bb04f5600b4dadb22ffc57f564ca44b8f1c6b901969"]
	if len(aggregate.Snapshots) != 1 || aggregate.Snapshots[0].TotalTokens != 1990073 {
		t.Fatalf("snapshot not carried: %+v", aggregate)
	}
	if aggregate.PendingUpload == nil || !*aggregate.PendingUpload {
		t.Error("pendingUpload lost")
	}
	scan := state.Files["statusline-scan since:2026-07-22@Asia%2FShanghai"]
	if scan.StatuslineClaimed == nil || !*scan.StatuslineClaimed {
		t.Error("statuslineClaimed lost")
	}
	if scan.ContentHashAlgo != "v2-lines" {
		t.Error("contentHashAlgo lost")
	}
}

func TestRoundTripPreservesUnknownAndValidatedFields(t *testing.T) {
	path := writeTemp(t, tsCursorFixture)
	state, err := Read(path, "antigravity-cli")
	if err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(t.TempDir(), "rewritten.json")
	if err := Write(out, state); err != nil {
		t.Fatal(err)
	}

	orig := mustJSON(t, tsCursorFixture)
	rewritten := mustFileJSON(t, out)
	// Semantic compare on the parsed object: whitespace/ordering may differ,
	// values may not.
	if !reflect.DeepEqual(stripNewline(orig), rewritten) {
		t.Errorf("round-trip lost data\norig:  %v\nre:    %v", orig, rewritten)
	}
}

// The rewritten cursor must still validate under the TS collector's rules.
// This test encodes the critical invariants directly rather than running
// node: the fixture fields were chosen to exercise them.
func TestRewrittenCursorKeepsTSVisibleInvariants(t *testing.T) {
	path := writeTemp(t, tsCursorFixture)
	state, _ := Read(path, "antigravity-cli")
	out := filepath.Join(t.TempDir(), "rewritten.json")
	if err := Write(out, state); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	for _, invariant := range []string{
		`"version": 1`,
		`"antigravityCliMeteringVersion": 3`,
		`"codexContextPricingPending"`, // absent in fixture — absence preserved
	} {
		if strings.HasPrefix(invariant, `"codexContextPricingPending"`) {
			if strings.Contains(text, invariant) {
				t.Errorf("%s must not appear when unset", invariant)
			}
			continue
		}
		if !strings.Contains(text, invariant) {
			t.Errorf("rewritten cursor lost %s", invariant)
		}
	}
}

func TestReadMissingFileIsEmptyState(t *testing.T) {
	state, err := Read(filepath.Join(t.TempDir(), "absent.json"), "pi")
	if err != nil {
		t.Fatalf("missing cursor must be empty, got %v", err)
	}
	if state.Version != 1 || state.Source != "pi" || state.Files == nil || len(state.Files) != 0 {
		t.Errorf("empty state wrong: %+v", state)
	}
}

func TestRejectInvalidCursors(t *testing.T) {
	cases := map[string]string{
		"version 2":     `{"version":2,"source":"pi","files":{}}`,
		"source drift":  `{"version":1,"source":"codex","files":{}}`,
		"path escape":   `{"version":1,"source":"pi","files":{"a/../b":{"size":1,"mtimeMs":1,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","snapshots":[],"missingCost":false,"updatedAt":"x"}}}`,
		"absolute part": `{"version":1,"source":"pi","files":{"kind\u0000/db":{"size":1,"mtimeMs":1,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","snapshots":[],"missingCost":false,"updatedAt":"x"}}}`,
		// A "." segment is legal in the relative-path form (the TS rule only
		// rejects empty and ".." there); it is rejected inside a synthetic
		// key's parts, which the "absolute part" case below covers.
		"dot segment in synthetic part": `{"version":1,"source":"pi","files":{"kind\u0000a/../b":{"size":1,"mtimeMs":1,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","snapshots":[],"missingCost":false,"updatedAt":"x"}}}`,
		"bad sha":                       `{"version":1,"source":"pi","files":{"ok.json":{"size":1,"mtimeMs":1,"sha256":"xyz","snapshots":[],"missingCost":false,"updatedAt":"x"}}}`,
		"corrupt json":                  `{"version":1,`,
	}
	for name, content := range cases {
		t.Run(name, func(t *testing.T) {
			path := writeTemp(t, content)
			if _, err := Read(path, "pi"); err == nil {
				t.Errorf("%s: expected rejection", name)
			}
		})
	}
}

func TestValidSyntheticKeys(t *testing.T) {
	// These mirror real keys the TS collector writes; the validator must
	// accept all of them (trailing empty part is legal for db/db-covered).
	valid := []string{
		"db\x00db\x00",
		"db-covered\x00org/model\x00",
		"relative/path/session.jsonl",
		"statusline-scan since:2026-07-22@Asia%2FShanghai",
	}
	for _, key := range valid {
		if !isValidCursorKey(key) {
			t.Errorf("%q should be a valid key", key)
		}
	}
}

func mustJSON(t *testing.T, text string) map[string]any {
	t.Helper()
	var v map[string]any
	if err := json.Unmarshal([]byte(text), &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func mustFileJSON(t *testing.T, path string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var v map[string]any
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatalf("rewritten cursor is not valid JSON: %v", err)
	}
	return v
}

func stripNewline(v map[string]any) map[string]any {
	// normalize: sort keys via marshal-unmarshal is unnecessary for
	// DeepEqual on maps; this exists as a hook if key-order matters later.
	_ = sort.Strings
	return v
}
