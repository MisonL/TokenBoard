package codex

import (
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/ccusage"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// The provider hands the subagent correction the command runner's decoded
// rows, which are ordered objects rather than Go maps. A projection that only
// knew map[string]any found no rows at all, so the correction never ran on the
// real path while every map-based unit test still passed.
func TestProjectsRunnerOrderedSessionRowsIntoTheSubagentCorrection(t *testing.T) {
	codexHome := t.TempDir()
	const sessionID = "33333333-3333-4333-8333-333333333333"
	writeHookJSONL(t, filepath.Join(codexHome, "sessions", "2026", "10", "18",
		"rollout-2026-10-18T08-00-00-"+sessionID+".jsonl"),
		`{"type":"session_meta","timestamp":"2026-10-18T08:00:00.000Z","payload":{"id":"`+sessionID+
			`","timestamp":"2026-10-18T08:00:00.000Z","source":{"subagent":{"parent_thread_id":"p1"}}}}`,
		`{"type":"event_msg","timestamp":"2026-10-18T08:00:10.000Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":5000,"cached_input_tokens":4000,"output_tokens":200,"total_tokens":5200},"last_token_usage":{"input_tokens":300,"cached_input_tokens":200,"output_tokens":40,"total_tokens":340}}}}`,
		`{"type":"event_msg","timestamp":"2026-10-18T08:01:10.000Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":5600,"cached_input_tokens":4400,"output_tokens":260,"total_tokens":5860},"last_token_usage":{"input_tokens":600,"cached_input_tokens":400,"output_tokens":60,"total_tokens":660}}}}`,
	)

	// ccusage reports the child's inherited cumulative counter as the row's
	// usage; only the file's per-request counter is the child's own charge.
	sessionsJSON, err := json.Marshal(map[string]any{"sessions": []any{
		map[string]any{
			"sessionId":       "2026/10/18/rollout-2026-10-18T08-00-00-" + sessionID,
			"lastActivity":    "2026-10-18T08:01:10.000Z",
			"inputTokens":     float64(5600),
			"outputTokens":    float64(260),
			"cacheReadTokens": float64(4400),
			"models": map[string]any{
				"gpt-5.6-sol": map[string]any{
					"inputTokens":     float64(5600),
					"outputTokens":    float64(260),
					"cacheReadTokens": float64(4400),
					"totalTokens":     float64(5860),
				},
			},
		},
	}})
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := ccusage.DecodeOrderedJSON(sessionsJSON)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := decoded.(ccusage.OrderedObject); !ok {
		t.Fatalf("decoded = %T, want an ordered object", decoded)
	}

	corrected, err := ApplyCodexSubagentUsageCorrections(SubagentCorrectionInput{
		Snapshots: []contract.Snapshot{{
			Source:       contract.SourceCodex,
			UsageDate:    "2026-10-18",
			Timezone:     "Asia/Shanghai",
			CollectedAt:  "2026-10-18T09:00:00.000Z",
			Model:        "gpt-5.6-sol",
			InputTokens:  5600,
			OutputTokens: 260,
			CacheRead:    4400,
			TotalTokens:  5860,
			SessionCount: 1,
		}},
		Sessions:   decoded,
		CodexHomes: []string{codexHome},
		Timezone:   "Asia/Shanghai",
		Stderr:     func(string) {},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(corrected) != 1 {
		t.Fatalf("corrected = %d snapshots, want 1", len(corrected))
	}
	// The child's per-request usage is 300 fresh input, 600 cache reads and
	// 100 output.
	got := corrected[0]
	if got.InputTokens != 300 || got.CacheRead != 600 || got.OutputTokens != 100 || got.TotalTokens != 1000 {
		t.Errorf("corrected = %+v, want input 300 cacheRead 600 output 100 total 1000", got)
	}
}

// The per-home tag is applied to runner rows, which are ordered objects. A
// clone that only understood Go maps left the tag off and every row then
// resolved against every home, so a duplicate relative path picked the wrong
// source file.
func TestTagsRunnerOrderedSessionRowsWithTheirHomeIndex(t *testing.T) {
	decoded, err := ccusage.DecodeOrderedJSON([]byte(
		`{"sessions":[{"directory":"2026/10/18","sessionFile":"s","lastActivity":"2026-10-18T01:00:00.000Z"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	rows := ccusage.SessionRows(decoded)
	if len(rows) != 1 {
		t.Fatalf("rows = %d, want 1", len(rows))
	}
	tagged := tagSessionRow(rows[0], 1)
	if got := rowHomeIndex(tagged); got != 1 {
		t.Fatalf("rowHomeIndex = %d, want 1", got)
	}
	if _, ok := tagged.(ccusage.OrderedObject); !ok {
		t.Fatalf("tagged row = %T, want an ordered object", tagged)
	}
}
