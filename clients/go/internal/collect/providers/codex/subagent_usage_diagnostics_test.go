package codex

// Port of codex-subagent-usage-diagnostics.test.ts.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

func TestCoalescesRepeatedSafeOversizedRowWarningsWithoutChangingCorrections(t *testing.T) {
	home := t.TempDir()
	stateDir := t.TempDir()
	warnings := []string{}
	childNames := []string{"child-a", "child-b"}
	oversizedRecord, err := json.Marshal(map[string]any{
		"type":    "compacted",
		"payload": map[string]any{"summary": strings.Repeat("x", MaxCodexChildSessionLineBytes+1)},
	})
	if err != nil {
		t.Fatalf("marshal oversized row: %v", err)
	}
	oversized := string(oversizedRecord)

	sessions := []any{}
	for _, name := range childNames {
		filePath := filepath.Join(home, "sessions", "2026", "05", "25", name+".jsonl")
		writeJSONL(t, filePath, []map[string]any{
			subagentChildSessionMeta(name, "parent-thread", "2026-05-25T01:00:00.000Z"),
			subagentUsageEvent("2026-05-25T01:10:00.000Z", subagentTokensWithTotal(100, 0, 10, 110), ""),
		})
		file, err := os.OpenFile(filePath, os.O_APPEND|os.O_WRONLY, 0o644)
		if err != nil {
			t.Fatalf("open child: %v", err)
		}
		if _, err := file.WriteString(oversized + "\n"); err != nil {
			file.Close()
			t.Fatalf("append oversized row: %v", err)
		}
		if err := file.Close(); err != nil {
			t.Fatalf("close child: %v", err)
		}
		sessions = append(sessions, map[string]any{
			"directory":    "2026/05/25",
			"sessionFile":  name,
			"lastActivity": "2026-05-25T01:30:00.000Z",
			"models": map[string]any{
				"gpt-5": map[string]any{
					"inputTokens":       float64(200),
					"cachedInputTokens": float64(0),
					"outputTokens":      float64(20),
					"totalTokens":       float64(220),
					"costUSD":           float64(0),
				},
			},
		})
	}

	corrected := subagentApply(t, SubagentCorrectionInput{
		Snapshots: []contract.Snapshot{{
			Source:        contract.SourceCodex,
			UsageDate:     "2026-05-25",
			Timezone:      "UTC",
			Model:         "gpt-5",
			InputTokens:   400,
			OutputTokens:  40,
			CacheCreation: 0,
			CacheRead:     0,
			TotalTokens:   440,
			CostUSD:       0,
			SessionCount:  2,
			CollectedAt:   "2026-05-25T02:00:00.000Z",
		}},
		Sessions:                map[string]any{"sessions": sessions},
		CodexHomes:              []string{home},
		StateDir:                stateDir,
		Timezone:                "UTC",
		MaxConcurrentChildReads: 2,
		Stderr:                  func(line string) { warnings = append(warnings, line) },
	})

	if len(corrected) != 1 {
		t.Fatalf("got %d snapshots, want 1", len(corrected))
	}
	subagentAssertSnapshot(t, corrected[0], subagentExpectedSnapshot{
		Input: 200, Output: 20, Total: 220,
	})
	want := "Skipped 2 oversized Codex child session JSONL rows without usage or subagent metadata across 2 scans (largest " +
		itoa64(int64(len(oversized))) + " bytes)"
	if len(warnings) != 1 || warnings[0] != want {
		t.Fatalf("warnings = %v, want [%s]", warnings, want)
	}
}
