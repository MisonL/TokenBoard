package codex

// Port of codex-subagent-usage-validation.test.ts. The TypeScript file drives
// collectCodexUsage; the Go cases use the same child fixture and session row at
// the correction boundary.

import (
	"path/filepath"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

func TestRetainsAHighCacheChildEventWithAdditiveCounters(t *testing.T) {
	root := t.TempDir()
	filePath := filepath.Join(root, "child.jsonl")
	writeJSONL(t, filePath, []map[string]any{
		subagentUsageEvent("2026-05-25T01:10:00.000Z", subagentTokensWithTotal(50, 150, 20, 220), ""),
	})

	diagnostics := []string{}
	usage, err := ReadChildLastUsageByDate(
		filePath, "2026-05-25T00:00:00.000Z", "Asia/Shanghai",
		func(line string) { diagnostics = append(diagnostics, line) },
	)
	if err != nil {
		t.Fatalf("read child usage: %v", err)
	}
	if len(usage) != 1 {
		t.Fatalf("got %d dated usages, want 1", len(usage))
	}
	got := usage[0]
	if got.UsageDate != "2026-05-25" || got.InputTokens != 50 || got.CacheReadTokens != 150 ||
		got.OutputTokens != 20 || got.TotalTokens != 220 {
		t.Fatalf("usage = %+v, want 2026-05-25 input=50 cacheRead=150 output=20 total=220", got)
	}
	if len(diagnostics) != 0 {
		t.Fatalf("diagnostics = %v, want none", diagnostics)
	}
}

func TestAppliesAHighCacheChildCorrectionInsteadOfRetainingTheInflatedAggregate(t *testing.T) {
	home := t.TempDir()
	childFile := filepath.Join(home, "sessions", "2026", "05", "25", "rollout-child.jsonl")
	writeJSONL(t, childFile, []map[string]any{
		subagentChildSessionMeta("child", "parent", "2026-05-25T01:00:00.000Z"),
		subagentUsageEvent("2026-05-25T01:10:00.000Z", subagentTokensWithTotal(50, 150, 20, 220), ""),
	})

	sessions := subagentChildSessionResult()
	diagnostics := []string{}
	got := subagentApply(t, SubagentCorrectionInput{
		Snapshots:  []contract.Snapshot{subagentCodexSnapshot()},
		Sessions:   sessions,
		CodexHomes: []string{home},
		Timezone:   "Asia/Shanghai",
		Stderr:     func(line string) { diagnostics = append(diagnostics, line) },
	})

	if len(got) != 1 {
		t.Fatalf("got %d snapshots, want 1", len(got))
	}
	subagentAssertSnapshot(t, got[0], subagentExpectedSnapshot{
		Input: 50, Output: 20, CacheRead: 150, Total: 220,
	})
	if len(diagnostics) != 0 {
		t.Fatalf("diagnostics = %v, want none", diagnostics)
	}
}

func TestPreservesAdditiveInputWhenCacheReadIsSmallerThanInput(t *testing.T) {
	home := t.TempDir()
	childFile := filepath.Join(home, "sessions", "2026", "05", "25", "rollout-child.jsonl")
	writeJSONL(t, childFile, []map[string]any{
		subagentChildSessionMeta("child", "parent", "2026-05-25T01:00:00.000Z"),
		subagentUsageEvent("2026-05-25T01:10:00.000Z", subagentTokensWithTotal(200, 150, 20, 370), ""),
	})

	diagnostics := []string{}
	got := subagentApply(t, SubagentCorrectionInput{
		Snapshots:  []contract.Snapshot{subagentCodexSnapshot()},
		Sessions:   subagentChildSessionResult(),
		CodexHomes: []string{home},
		Timezone:   "Asia/Shanghai",
		Stderr:     func(line string) { diagnostics = append(diagnostics, line) },
	})

	if len(got) != 1 {
		t.Fatalf("got %d snapshots, want 1", len(got))
	}
	subagentAssertSnapshot(t, got[0], subagentExpectedSnapshot{
		Input: 200, Output: 20, CacheRead: 150, Total: 370,
	})
	if len(diagnostics) != 0 {
		t.Fatalf("diagnostics = %v, want none", diagnostics)
	}
}

// subagentChildSessionResult is the TS childSessionResult: a single session row
// whose totals still contain the parent's copied history.
func subagentChildSessionResult() map[string]any {
	return map[string]any{
		"sessions": []any{
			map[string]any{
				"sessionId":    "2026/05/25/rollout-child",
				"lastActivity": "2026-05-25T01:10:00.000Z",
				"totalTokens":  float64(3170),
				"costUSD":      float64(3.17),
				"models": map[string]any{
					"gpt-5": map[string]any{
						"inputTokens":       float64(1100),
						"cachedInputTokens": float64(1950),
						"outputTokens":      float64(120),
						"totalTokens":       float64(3170),
						"costUSD":           float64(3.17),
					},
				},
			},
		},
	}
}
