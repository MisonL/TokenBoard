package codex

// Port of codex-subagent-usage-concurrency.test.ts.

import (
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

func TestRunsIndependentChildReadsUpToTheConfiguredConcurrencyLimit(t *testing.T) {
	home := t.TempDir()
	stateDir := t.TempDir()
	names := []string{"child-a", "child-b", "child-c"}
	sessions := []any{}
	for _, name := range names {
		writeJSONL(t, filepath.Join(home, "sessions", "2026", "07", "25", name+".jsonl"), []map[string]any{
			subagentChildSessionMeta(name, "parent", "2026-07-25T01:00:00.000Z"),
		})
		sessions = append(sessions, map[string]any{
			"directory":    "2026/07/25",
			"sessionFile":  name,
			"lastActivity": "2026-07-25T01:30:00.000Z",
			"models": map[string]any{
				"gpt-5.6": map[string]any{
					"inputTokens":  float64(100),
					"outputTokens": float64(10),
					"totalTokens":  float64(110),
					"costUSD":      float64(0),
				},
			},
		})
	}

	var (
		mu       sync.Mutex
		active   int
		maxReads int
		once     sync.Once
	)
	reachedTwo := make(chan struct{})
	release := make(chan struct{})
	read := func(string, string, string, func(string), string) ([]DatedUsage, error) {
		mu.Lock()
		active++
		if active > maxReads {
			maxReads = active
		}
		reached := active
		mu.Unlock()
		if reached == 2 {
			once.Do(func() { close(reachedTwo) })
		}
		<-release
		mu.Lock()
		active--
		mu.Unlock()
		return nil, nil
	}

	errs := make(chan error, 1)
	go func() {
		_, err := ApplyCodexSubagentUsageCorrections(SubagentCorrectionInput{
			Snapshots: []contract.Snapshot{{
				Source:        contract.SourceCodex,
				UsageDate:     "2026-07-25",
				Timezone:      "UTC",
				Model:         "gpt-5.6",
				InputTokens:   300,
				OutputTokens:  30,
				CacheCreation: 0,
				CacheRead:     0,
				TotalTokens:   330,
				CostUSD:       0,
				SessionCount:  3,
				CollectedAt:   "2026-07-25T02:00:00.000Z",
			}},
			Sessions:                map[string]any{"sessions": sessions},
			CodexHomes:              []string{home},
			StateDir:                stateDir,
			Timezone:                "UTC",
			MaxConcurrentChildReads: 2,
			ReadChildUsageByDate:    read,
		})
		errs <- err
	}()

	select {
	case <-reachedTwo:
	case <-time.After(5 * time.Second):
		close(release)
		<-errs
		t.Fatal("child reads did not reach the configured concurrency")
	}
	close(release)
	if err := <-errs; err != nil {
		t.Fatalf("apply corrections: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if maxReads != 2 {
		t.Fatalf("max active reads = %d, want 2", maxReads)
	}
}
