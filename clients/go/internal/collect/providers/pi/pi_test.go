package pi

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// Entry types, the message.usage shape and the cost breakdown follow Pi's
// session JSONL: entries form an id/parentId tree, and usage rides on
// assistant messages, tool results, compactions and branch summaries.
const (
	timestamp = "2026-06-15T10:06:38.654Z"
	fixtureTZ = "Asia/Shanghai"
	fixtureAt = "2026-06-15T12:00:00.000Z"
)

func usage(overrides map[string]any) map[string]any {
	base := map[string]any{
		"input":      3272,
		"output":     383,
		"cacheRead":  52_480,
		"cacheWrite": 0,
		"cost": map[string]any{
			"input": 0.0009, "output": 0.0014, "cacheRead": 0.0001, "cacheWrite": 0, "total": 0.0024,
		},
	}
	for key, value := range overrides {
		base[key] = value
	}
	return base
}

// assistantEntry builds one assistant message entry. messageOverrides are
// merged over the message object; entryOverrides over the entry itself.
func assistantEntry(messageOverrides map[string]any, entryOverrides map[string]any) string {
	message := map[string]any{
		"role":     "assistant",
		"api":      "anthropic",
		"provider": "deepseek",
		"model":    "deepseek-v4-pro",
		"usage":    usage(nil),
	}
	for key, value := range messageOverrides {
		message[key] = value
	}
	entry := map[string]any{
		"type":      "message",
		"id":        "entry-1",
		"parentId":  "entry-0",
		"timestamp": timestamp,
		"message":   message,
	}
	for key, value := range entryOverrides {
		entry[key] = value
	}
	encoded, err := json.Marshal(entry)
	if err != nil {
		panic(err)
	}
	return string(encoded)
}

func piAgentDir(t *testing.T, files map[string][]string) string {
	t.Helper()
	agentDir := t.TempDir()
	for relative, lines := range files {
		filePath := filepath.Join(append([]string{agentDir, "sessions"}, strings.Split(relative, "/")...)...)
		if err := os.MkdirAll(filepath.Dir(filePath), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filePath, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return agentDir
}

func runCollect(t *testing.T, agentDir string, mutate func(*Options)) ([]contract.Snapshot, error) {
	t.Helper()
	options := Options{
		AgentDir:    agentDir,
		Timezone:    fixtureTZ,
		CollectedAt: fixtureAt,
		Since:       "all",
	}
	if mutate != nil {
		mutate(&options)
	}
	return Collect(options)
}

func mustCollect(t *testing.T, agentDir string, mutate func(*Options)) []contract.Snapshot {
	t.Helper()
	snapshots, err := runCollect(t, agentDir, mutate)
	if err != nil {
		t.Fatal(err)
	}
	return snapshots
}

func marshalJSON(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func TestNormalizesAssistantMessageIntoDailySnapshot(t *testing.T) {
	agentDir := piAgentDir(t, map[string][]string{
		"--C--Users-lenovo--/session-a.jsonl": {assistantEntry(nil, nil)},
	})

	snapshots := mustCollect(t, agentDir, nil)

	want := contract.Snapshot{
		Source:        contract.SourcePi,
		UsageDate:     "2026-06-15",
		Timezone:      fixtureTZ,
		Model:         "deepseek-v4-pro",
		InputTokens:   3272,
		OutputTokens:  383,
		CacheCreation: 0,
		CacheRead:     52_480,
		TotalTokens:   56_135,
		CostUSD:       0.0024,
		SessionCount:  1,
		CollectedAt:   fixtureAt,
	}
	if len(snapshots) != 1 || snapshots[0] != want {
		t.Errorf("snapshots = %+v, want %+v", snapshots, want)
	}
}

func TestCountsToolResultCompactionAndBranchSummaryUsage(t *testing.T) {
	agentDir := piAgentDir(t, map[string][]string{
		"project/session-a.jsonl": {
			marshalJSON(t, map[string]any{
				"type": "message", "id": "tool-1", "timestamp": timestamp,
				"message": map[string]any{
					"role": "toolResult", "model": "deepseek-v4-pro",
					"usage": usage(map[string]any{
						"input": 100, "output": 10, "cacheRead": 0, "cost": map[string]any{"total": 0.001},
					}),
				},
			}),
			marshalJSON(t, map[string]any{
				"type": "compaction", "id": "compact-1", "timestamp": timestamp,
				"usage": usage(map[string]any{
					"input": 200, "output": 20, "cacheRead": 0, "cost": map[string]any{"total": 0.002},
				}),
			}),
			marshalJSON(t, map[string]any{
				"type": "branch_summary", "id": "branch-1", "timestamp": timestamp,
				"usage": usage(map[string]any{
					"input": 300, "output": 30, "cacheRead": 0, "cost": map[string]any{"total": 0.003},
				}),
			}),
		},
	})

	snapshots := mustCollect(t, agentDir, nil)

	// The tool result names its model; compaction and branch-summary entries
	// carry no message, so their usage lands under the unknown-model row.
	if len(snapshots) != 2 || snapshots[0].Model != "deepseek-v4-pro" || snapshots[1].Model != "unknown" {
		t.Fatalf("snapshots = %+v", snapshots)
	}
	var input, output int64
	var cost float64
	for _, snapshot := range snapshots {
		input += snapshot.InputTokens
		output += snapshot.OutputTokens
		cost += snapshot.CostUSD
	}
	if input != 600 || output != 60 {
		t.Errorf("totals = %d/%d, want 600/60", input, output)
	}
	if cost < 0.006-1e-12 || cost > 0.006+1e-12 {
		t.Errorf("cost = %v, want 0.006", cost)
	}
}

func TestIgnoresUserMessagesAndEntriesWithoutUsage(t *testing.T) {
	agentDir := piAgentDir(t, map[string][]string{
		"project/session-a.jsonl": {
			marshalJSON(t, map[string]any{"type": "session", "id": "s", "timestamp": timestamp, "cwd": "/work"}),
			marshalJSON(t, map[string]any{"type": "model_change", "id": "m", "timestamp": timestamp, "provider": "google", "modelId": "gemini"}),
			marshalJSON(t, map[string]any{"type": "message", "id": "u", "timestamp": timestamp, "message": map[string]any{"role": "user"}}),
			marshalJSON(t, map[string]any{"type": "message", "id": "a", "timestamp": timestamp, "message": map[string]any{"role": "assistant", "model": "m"}}),
			assistantEntry(nil, nil),
		},
	})

	snapshots := mustCollect(t, agentDir, nil)
	if len(snapshots) != 1 || snapshots[0].InputTokens != 3272 {
		t.Errorf("snapshots = %+v, want one with 3272 input", snapshots)
	}
}

func TestCountsAForkedEntryIDOnlyOnce(t *testing.T) {
	// A fork copies shared history, so the same entry id can appear twice.
	agentDir := piAgentDir(t, map[string][]string{
		"project/session-a.jsonl": {assistantEntry(nil, nil)},
		"project/session-b.jsonl": {assistantEntry(nil, nil)},
	})

	if got := mustCollect(t, agentDir, nil)[0].InputTokens; got != 3272 {
		t.Errorf("inputTokens = %d, want 3272", got)
	}
}

func TestKeepsDistinctEntriesWithIdenticalUsage(t *testing.T) {
	agentDir := piAgentDir(t, map[string][]string{
		"project/session-a.jsonl": {
			assistantEntry(nil, nil),
			assistantEntry(nil, map[string]any{"id": "entry-2"}),
		},
	})

	if got := mustCollect(t, agentDir, nil)[0].InputTokens; got != 6544 {
		t.Errorf("inputTokens = %d, want 6544", got)
	}
}

func TestPrefersTheModelThatAnsweredOverTheOneRequested(t *testing.T) {
	agentDir := piAgentDir(t, map[string][]string{
		"project/session-a.jsonl": {
			assistantEntry(map[string]any{"model": "requested-model", "responseModel": "served-model"}, nil),
		},
	})

	if got := mustCollect(t, agentDir, nil)[0].Model; got != "served-model" {
		t.Errorf("model = %q, want served-model", got)
	}
}

func TestFallsBackToSessionTimestampAndPlaceholderModel(t *testing.T) {
	agentDir := piAgentDir(t, map[string][]string{
		"project/session-a.jsonl": {
			marshalJSON(t, map[string]any{"type": "session", "id": "s", "timestamp": timestamp, "cwd": "/work"}),
			marshalJSON(t, map[string]any{
				"type": "compaction", "id": "c",
				"usage": usage(map[string]any{"cacheRead": 0, "cost": map[string]any{"total": 0.001}}),
			}),
		},
	})

	snapshot := mustCollect(t, agentDir, nil)[0]
	if snapshot.UsageDate != "2026-06-15" || snapshot.Model != "unknown" {
		t.Errorf("snapshot = %+v, want 2026-06-15 / unknown", snapshot)
	}
}

func TestSumsCostBucketsWhenNoTotalIsReported(t *testing.T) {
	agentDir := piAgentDir(t, map[string][]string{
		"project/session-a.jsonl": {
			assistantEntry(map[string]any{"usage": usage(map[string]any{
				"cost": map[string]any{"input": 0.001, "output": 0.002, "cacheRead": 0.0005, "cacheWrite": 0},
			})}, nil),
		},
	})

	if got := mustCollect(t, agentDir, nil)[0].CostUSD; got < 0.0035-1e-12 || got > 0.0035+1e-12 {
		t.Errorf("costUsd = %v, want 0.0035", got)
	}
}

func TestIncludesTheExtendedCacheWriteTierInBucketCostFallback(t *testing.T) {
	agentDir := piAgentDir(t, map[string][]string{
		"project/session-a.jsonl": {
			assistantEntry(map[string]any{"usage": map[string]any{
				"input": 100, "output": 10, "cacheRead": 0,
				"cacheWrite": 200, "cacheWrite1h": 300,
				"cost": map[string]any{
					"input": 0.001, "output": 0.002, "cacheRead": 0, "cacheWrite": 0.004, "cacheWrite1h": 0.005,
				},
			}}, nil),
		},
	})

	if got := mustCollect(t, agentDir, nil)[0].CostUSD; got < 0.012-1e-12 || got > 0.012+1e-12 {
		t.Errorf("costUsd = %v, want 0.012", got)
	}
}

func TestTrimsServedModelIdentifiersBeforeAggregation(t *testing.T) {
	agentDir := piAgentDir(t, map[string][]string{
		"project/session-a.jsonl": {
			assistantEntry(map[string]any{"model": "  requested-model  ", "responseModel": "  served-model  "}, nil),
		},
	})

	if got := mustCollect(t, agentDir, nil)[0].Model; got != "served-model" {
		t.Errorf("model = %q, want served-model", got)
	}
}

func TestAggregatesAcrossSessionsAndDates(t *testing.T) {
	agentDir := piAgentDir(t, map[string][]string{
		"project-a/session-a.jsonl": {assistantEntry(nil, nil)},
		"project-b/session-b.jsonl": {assistantEntry(nil, map[string]any{
			"id": "entry-2", "timestamp": "2026-06-16T02:00:00.000Z",
		})},
	})

	snapshots := mustCollect(t, agentDir, nil)
	if len(snapshots) != 2 || snapshots[0].UsageDate != "2026-06-15" || snapshots[1].UsageDate != "2026-06-16" {
		t.Fatalf("snapshots = %+v", snapshots)
	}
	for _, snapshot := range snapshots {
		if snapshot.SessionCount != 1 {
			t.Errorf("sessionCount = %d, want 1", snapshot.SessionCount)
		}
	}
}

func TestAppliesSinceWindowAndRejectsInvalidValue(t *testing.T) {
	agentDir := piAgentDir(t, map[string][]string{
		"project/session-a.jsonl": {
			assistantEntry(nil, map[string]any{"timestamp": "2026-06-10T02:00:00.000Z"}),
			assistantEntry(nil, map[string]any{"id": "entry-2", "timestamp": "2026-06-20T02:00:00.000Z"}),
		},
	})

	if got := mustCollect(t, agentDir, func(o *Options) { o.Since = "2026-06-15" }); len(got) != 1 {
		t.Errorf("dashed since = %d snapshots, want 1", len(got))
	}
	if got := mustCollect(t, agentDir, func(o *Options) { o.Since = "20260615" }); len(got) != 1 {
		t.Errorf("compact since = %d snapshots, want 1", len(got))
	}
	if got := mustCollect(t, agentDir, func(o *Options) { o.Since = "all" }); len(got) != 2 {
		t.Errorf("since all = %d snapshots, want 2", len(got))
	}
	_, err := runCollect(t, agentDir, func(o *Options) { o.Since = "today" })
	if err == nil || !strings.Contains(err.Error(), "Invalid Pi since value") {
		t.Errorf("invalid since error = %v", err)
	}
}

func TestReportsNoSessionsInsteadOfEmptyUsage(t *testing.T) {
	_, err := runCollect(t, t.TempDir(), nil)
	if err == nil || !strings.Contains(err.Error(), "No Pi sessions found") {
		t.Errorf("error = %v", err)
	}
}

func TestSkipsMalformedLinesWithoutFailingTheScan(t *testing.T) {
	agentDir := piAgentDir(t, map[string][]string{
		"project/session-a.jsonl": {"not-json", "[]", "", assistantEntry(nil, nil)},
	})

	if got := mustCollect(t, agentDir, nil); len(got) != 1 {
		t.Errorf("snapshots = %+v, want 1", got)
	}
}

// Taken from real ~/.pi/agent/sessions files: usage carries totalTokens and a
// per-bucket cost alongside the counts, assistant and toolResult entries both
// carry usage, and responseModel names the model that served the call.
func TestMatchesTheShapeAPiSessionWrites(t *testing.T) {
	agentDir := piAgentDir(t, map[string][]string{
		"--C--Users-lenovo--/session-real.jsonl": {
			marshalJSON(t, map[string]any{"type": "session", "id": "s", "timestamp": timestamp, "cwd": "C:/Users/lenovo"}),
			marshalJSON(t, map[string]any{"type": "model_change", "id": "mc", "timestamp": timestamp, "provider": "xai", "modelId": "grok-4.5"}),
			marshalJSON(t, map[string]any{
				"type": "message", "id": "a1", "timestamp": timestamp,
				"message": map[string]any{
					"role": "assistant", "provider": "xai", "model": "grok-4.5", "responseModel": "grok-4.5",
					"usage": map[string]any{
						"input": 23_785, "output": 15_670, "cacheRead": 559_488,
						"cacheWrite": 0, "cacheWrite1h": 0, "totalTokens": 598_943,
						"cost": map[string]any{"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0},
					},
				},
			}),
			marshalJSON(t, map[string]any{
				"type": "message", "id": "t1", "timestamp": timestamp,
				"message": map[string]any{
					"role": "toolResult", "responseModel": "grok-4.5",
					"usage": map[string]any{
						"input": 23_785, "output": 15_671, "cacheRead": 559_488,
						"cacheWrite": 0, "cacheWrite1h": 0, "totalTokens": 598_944,
						"cost": map[string]any{"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0},
					},
				},
			}),
		},
	})

	snapshots := mustCollect(t, agentDir, nil)
	want := contract.Snapshot{
		Source:        contract.SourcePi,
		UsageDate:     "2026-06-15",
		Timezone:      fixtureTZ,
		Model:         "grok-4.5",
		InputTokens:   47_570,
		OutputTokens:  31_341,
		CacheCreation: 0,
		CacheRead:     1_118_976,
		TotalTokens:   1_197_887,
		// Subscription-tier models report a zero cost breakdown, which is a
		// real zero rather than an absent figure.
		CostUSD:      0,
		SessionCount: 1,
		CollectedAt:  fixtureAt,
	}
	if len(snapshots) != 1 || snapshots[0] != want {
		t.Errorf("snapshots = %+v, want %+v", snapshots, want)
	}
}

func TestCountsBothCacheWriteTiersAsCacheCreation(t *testing.T) {
	// Pi splits cache writes by TTL; ignoring the 1h tier would under-report.
	agentDir := piAgentDir(t, map[string][]string{
		"project/session-a.jsonl": {
			assistantEntry(map[string]any{"usage": map[string]any{
				"input": 100, "output": 10, "cacheRead": 0,
				"cacheWrite": 200, "cacheWrite1h": 300, "cost": map[string]any{"total": 0},
			}}, nil),
		},
	})

	snapshot := mustCollect(t, agentDir, nil)[0]
	if snapshot.CacheCreation != 500 || snapshot.TotalTokens != 610 {
		t.Errorf("snapshot = %+v, want 500 cache creation / 610 total", snapshot)
	}
}

func TestKeepsSessionContentOutOfTheSnapshot(t *testing.T) {
	secrets := []string{"a real user prompt", "the assistant reply", "C:/Users/lenovo/secret"}
	agentDir := piAgentDir(t, map[string][]string{
		"project/session-a.jsonl": {
			marshalJSON(t, map[string]any{"type": "session", "id": "s", "timestamp": timestamp, "cwd": secrets[2]}),
			marshalJSON(t, map[string]any{
				"type": "message", "id": "u", "timestamp": timestamp,
				"message": map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": secrets[0]}}},
			}),
			marshalJSON(t, map[string]any{
				"type": "message", "id": "a", "timestamp": timestamp,
				"message": map[string]any{
					"role": "assistant", "model": "m",
					"content": []any{map[string]any{"type": "text", "text": secrets[1]}},
					"usage":   map[string]any{"input": 10, "output": 2, "cost": map[string]any{"total": 0}},
				},
			}),
		},
	})

	emitted := marshalJSON(t, mustCollect(t, agentDir, nil))
	for _, secret := range secrets {
		if strings.Contains(emitted, secret) {
			t.Errorf("snapshot leaked %q: %s", secret, emitted)
		}
	}
}
