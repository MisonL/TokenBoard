package codex

// Ports codex-subagent-usage.test.ts. The TypeScript file drives the full
// collectCodexUsage pipeline; the Go cases stop at the correction boundary
// (snapshots + session report + Codex home), because the pipeline's
// normalization is covered by the ccusage and provider tests. Every case that
// only observes the correction keeps its original fixture and expectations.

import (
	"math"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
	"runtime"
)

type subagentExpectedSnapshot struct {
	Input         int64
	Output        int64
	CacheCreation int64
	CacheRead     int64
	Total         int64
	Cost          *float64
}

func subagentAssertSnapshot(t *testing.T, got contract.Snapshot, want subagentExpectedSnapshot) {
	t.Helper()
	if got.InputTokens != want.Input ||
		got.OutputTokens != want.Output ||
		got.CacheCreation != want.CacheCreation ||
		got.CacheRead != want.CacheRead ||
		got.TotalTokens != want.Total {
		t.Fatalf("snapshot tokens = %+v, want input=%d output=%d cacheCreation=%d cacheRead=%d total=%d",
			got, want.Input, want.Output, want.CacheCreation, want.CacheRead, want.Total)
	}
	if want.Cost != nil && math.Abs(got.CostUSD-*want.Cost) > 1e-9 {
		t.Fatalf("snapshot cost = %v, want %v", got.CostUSD, *want.Cost)
	}
}

func subagentCost(value float64) *float64 { return &value }

func subagentApply(t *testing.T, input SubagentCorrectionInput) []contract.Snapshot {
	t.Helper()
	got, err := ApplyCodexSubagentUsageCorrections(input)
	if err != nil {
		t.Fatalf("apply corrections: %v", err)
	}
	return got
}

func subagentDatedUsage(usageDate string, input, creation, read, output, total float64) DatedUsage {
	return DatedUsage{
		UsageDate:           usageDate,
		InputTokens:         input,
		CacheCreationTokens: creation,
		CacheReadTokens:     read,
		OutputTokens:        output,
		TotalTokens:         total,
	}
}

// subagentSessionResultFor returns the inherited session report with the given
// session file id.
func subagentSessionResultFor(id string) map[string]any {
	result := subagentInheritedSessionResult()
	result["sessions"].([]any)[0].(map[string]any)["sessionId"] = "2026/05/25/rollout-" + id
	return result
}

func subagentSnapshotForModel(model string, input, cacheRead, output, total int64, cost float64) contract.Snapshot {
	return contract.Snapshot{
		Source:        contract.SourceCodex,
		UsageDate:     "2026-05-25",
		Timezone:      "Asia/Shanghai",
		Model:         model,
		InputTokens:   input,
		OutputTokens:  output,
		CacheCreation: 0,
		CacheRead:     cacheRead,
		TotalTokens:   total,
		CostUSD:       cost,
		SessionCount:  1,
		CollectedAt:   "2026-05-25T01:20:00.000Z",
	}
}

func TestFindsValidSubagentMetadataAfterAnIncompleteSessionMetadataRow(t *testing.T) {
	home := t.TempDir()
	childFile := filepath.Join(home, "sessions", "2026", "05", "25", "rollout-child-thread.jsonl")
	writeJSONL(t, childFile, []map[string]any{
		{
			"type":      "session_meta",
			"timestamp": "2026-05-25T00:59:00.000Z",
			"payload":   map[string]any{"id": "incomplete-child", "timestamp": "2026-05-25T00:59:00.000Z"},
		},
		subagentChildSessionMeta("child-thread", "parent-thread", "2026-05-25T01:00:00.000Z"),
		subagentUsageEventWithLast(
			"2026-05-25T01:10:00.000Z",
			subagentTokens(1200, 1050, 70),
			subagentTokens(200, 150, 20),
			"",
		),
	})

	got := subagentApply(t, SubagentCorrectionInput{
		Snapshots:  []contract.Snapshot{subagentCodexSnapshot()},
		Sessions:   subagentInheritedSessionResult(),
		CodexHomes: []string{home},
		Timezone:   "Asia/Shanghai",
	})

	if len(got) != 1 {
		t.Fatalf("got %d snapshots, want 1", len(got))
	}
	subagentAssertSnapshot(t, got[0], subagentExpectedSnapshot{
		Input: 50, Output: 20, CacheRead: 150, Total: 220,
	})
	if got[0].SessionCount != 1 {
		t.Fatalf("sessionCount = %d, want 1", got[0].SessionCount)
	}
}

func TestCorrectsAChildSessionWhenSubagentMetadataOmitsTheParentThreadID(t *testing.T) {
	home := t.TempDir()
	childFile := filepath.Join(home, "sessions", "2026", "05", "25", "rollout-child-thread.jsonl")
	writeJSONL(t, childFile, []map[string]any{
		subagentChildSessionMeta("child-thread", "", "2026-05-25T01:00:00.000Z"),
		subagentUsageEventWithLast(
			"2026-05-25T01:10:00.000Z",
			subagentTokens(1200, 1050, 70),
			subagentTokens(200, 150, 20),
			"",
		),
	})

	got := subagentApply(t, SubagentCorrectionInput{
		Snapshots:  []contract.Snapshot{subagentCodexSnapshot()},
		Sessions:   subagentInheritedSessionResult(),
		CodexHomes: []string{home},
		Timezone:   "Asia/Shanghai",
	})

	subagentAssertSnapshot(t, got[0], subagentExpectedSnapshot{
		Input: 50, Output: 20, CacheRead: 150, Total: 220,
	})
}

func TestCorrectsAChildSessionStoredInALaterConfiguredCodexHome(t *testing.T) {
	firstHome := t.TempDir()
	secondHome := t.TempDir()
	childFile := filepath.Join(secondHome, "sessions", "2026", "05", "25", "rollout-child-thread.jsonl")
	subagentWriteInheritedChildSession(t, childFile)

	got := subagentApply(t, SubagentCorrectionInput{
		Snapshots:  []contract.Snapshot{subagentCodexSnapshot()},
		Sessions:   subagentInheritedSessionResult(),
		CodexHomes: []string{firstHome, secondHome},
		Timezone:   "Asia/Shanghai",
	})

	subagentAssertSnapshot(t, got[0], subagentExpectedSnapshot{
		Input: 50, Output: 20, CacheRead: 150, Total: 220,
	})
}

func TestCorrectsALaterProfileChildSessionDuringAFullHistoryScan(t *testing.T) {
	// The `since: all` flag only changes the provider's ccusage window; the
	// correction always reads every configured home, so this case is the same
	// at the correction boundary.
	firstHome := t.TempDir()
	secondHome := t.TempDir()
	childFile := filepath.Join(secondHome, "sessions", "2026", "05", "25", "rollout-child-thread.jsonl")
	subagentWriteInheritedChildSession(t, childFile)

	got := subagentApply(t, SubagentCorrectionInput{
		Snapshots:  []contract.Snapshot{subagentCodexSnapshot()},
		Sessions:   subagentInheritedSessionResult(),
		CodexHomes: []string{firstHome, secondHome},
		Timezone:   "Asia/Shanghai",
	})

	subagentAssertSnapshot(t, got[0], subagentExpectedSnapshot{
		Input: 50, Output: 20, CacheRead: 150, Total: 220,
	})
}

func TestDeduplicatesRepeatedChildEventsAcrossMatchingCodexHomes(t *testing.T) {
	firstHome := t.TempDir()
	secondHome := t.TempDir()
	firstChild := filepath.Join(firstHome, "sessions", "2026", "05", "25", "rollout-child-thread.jsonl")
	secondChild := filepath.Join(secondHome, "sessions", "2026", "05", "25", "rollout-child-thread.jsonl")
	firstEvent := subagentUsageEventWithLast(
		"2026-05-25T01:10:00.000Z",
		subagentTokens(1200, 1050, 70),
		subagentTokens(200, 150, 20),
		"",
	)
	writeJSONL(t, firstChild, []map[string]any{
		subagentChildSessionMeta("child-thread", "parent-thread", "2026-05-25T01:00:00.000Z"),
		firstEvent,
	})
	writeJSONL(t, secondChild, []map[string]any{
		subagentChildSessionMeta("child-thread", "parent-thread", "2026-05-25T01:00:00.000Z"),
		firstEvent,
		subagentUsageEventWithLast(
			"2026-05-25T01:20:00.000Z",
			subagentTokens(1600, 1350, 110),
			subagentTokens(400, 300, 40),
			"",
		),
	})

	snapshot := subagentCodexSnapshot()
	snapshot.InputTokens = 2200
	snapshot.OutputTokens = 240
	snapshot.CacheRead = 3900
	snapshot.TotalTokens = 6340
	snapshot.CostUSD = 6.34

	got := subagentApply(t, SubagentCorrectionInput{
		Snapshots:  []contract.Snapshot{snapshot},
		Sessions:   subagentMergedProfileSessionResult(),
		CodexHomes: []string{firstHome, secondHome},
		Timezone:   "Asia/Shanghai",
	})

	subagentAssertSnapshot(t, got[0], subagentExpectedSnapshot{
		Input: 150, Output: 60, CacheRead: 450, Total: 660, Cost: subagentCost(0.66),
	})
}

func TestDoesNotPersistCrossProfileChildEventIdentitiesInTheLocalCache(t *testing.T) {
	firstHome := t.TempDir()
	secondHome := t.TempDir()
	stateDir := t.TempDir()
	firstChild := filepath.Join(firstHome, "sessions", "2026", "05", "25", "rollout-child-thread.jsonl")
	secondChild := filepath.Join(secondHome, "sessions", "2026", "05", "25", "rollout-child-thread.jsonl")
	writeJSONL(t, firstChild, []map[string]any{
		subagentChildSessionMeta("child-thread", "parent-thread", "2026-05-25T01:00:00.000Z"),
	})
	writeJSONL(t, secondChild, []map[string]any{
		subagentChildSessionMeta("child-thread", "parent-thread", "2026-05-25T01:00:00.000Z"),
	})

	firstEvent := ChildUsageEvent{
		EventKey:   "first-event",
		DatedUsage: subagentDatedUsage("2026-05-25", 200, 0, 150, 20, 220),
	}
	secondEvent := ChildUsageEvent{
		EventKey:   "second-event",
		DatedUsage: subagentDatedUsage("2026-05-25", 400, 0, 300, 40, 440),
	}
	resolvedFirstChild, err := filepath.EvalSymlinks(firstChild)
	if err != nil {
		t.Fatalf("realpath first child: %v", err)
	}
	eventReads := 0
	var eventMu sync.Mutex
	activeEventReads := 0
	maxConcurrentEventReads := 0
	input := SubagentCorrectionInput{
		Snapshots: []contract.Snapshot{{
			Source:        contract.SourceCodex,
			UsageDate:     "2026-05-25",
			Timezone:      "Asia/Shanghai",
			Model:         "gpt-5",
			InputTokens:   2200,
			OutputTokens:  240,
			CacheCreation: 0,
			CacheRead:     3900,
			TotalTokens:   6340,
			CostUSD:       6.34,
			SessionCount:  1,
			CollectedAt:   "2026-05-25T01:20:00.000Z",
		}},
		Sessions:   subagentMergedProfileSessionResult(),
		CodexHomes: []string{firstHome, secondHome},
		StateDir:   stateDir,
		Timezone:   "Asia/Shanghai",
		ReadChildUsageByDate: func(string, string, string, func(string), string) ([]DatedUsage, error) {
			return nil, errSubagentTestMultiProfileMustUseEvents
		},
		ReadChildUsageEvents: func(filePath, _, _ string, _ func(string), _ string) ([]ChildUsageEvent, error) {
			eventMu.Lock()
			eventReads++
			activeEventReads++
			if activeEventReads > maxConcurrentEventReads {
				maxConcurrentEventReads = activeEventReads
			}
			eventMu.Unlock()
			// Yield so a reader with a higher concurrency would overlap.
			time.Sleep(2 * time.Millisecond)
			eventMu.Lock()
			activeEventReads--
			eventMu.Unlock()
			if filePath == resolvedFirstChild {
				return []ChildUsageEvent{firstEvent}, nil
			}
			return []ChildUsageEvent{firstEvent, secondEvent}, nil
		},
	}

	first := subagentApply(t, input)
	second := subagentApply(t, SubagentCorrectionInput{
		Snapshots:            append([]contract.Snapshot{}, input.Snapshots...),
		Sessions:             input.Sessions,
		CodexHomes:           input.CodexHomes,
		StateDir:             input.StateDir,
		Timezone:             input.Timezone,
		ReadChildUsageByDate: input.ReadChildUsageByDate,
		ReadChildUsageEvents: input.ReadChildUsageEvents,
	})

	if eventReads != 4 {
		t.Fatalf("event reads = %d, want 4", eventReads)
	}
	if maxConcurrentEventReads != 1 {
		t.Fatalf("max concurrent event reads = %d, want 1", maxConcurrentEventReads)
	}
	if !reflect.DeepEqual(second, first) {
		t.Fatalf("second correction = %+v, want %+v", second, first)
	}
	subagentAssertSnapshot(t, second[0], subagentExpectedSnapshot{
		Input: 150, Output: 60, CacheRead: 450, Total: 660,
	})
	cachePath := filepath.Join(stateDir, "codex-subagent-usage-cache.json")
	content, err := os.ReadFile(cachePath)
	if err != nil {
		t.Fatalf("read cache: %v", err)
	}
	if strings.Contains(string(content), "eventKey") {
		t.Fatalf("cache must not persist event identities: %s", content)
	}
}

var errSubagentTestMultiProfileMustUseEvents = &subagentTestError{"Multi-profile correction must use event-level reads"}

type subagentTestError struct{ message string }

func (e *subagentTestError) Error() string { return e.message }

func TestFindsValidSubagentMetadataAfterARowWithoutItsParentThreadID(t *testing.T) {
	home := t.TempDir()
	childFile := filepath.Join(home, "sessions", "2026", "05", "25", "rollout-child-thread.jsonl")
	writeJSONL(t, childFile, []map[string]any{
		{
			"type":      "session_meta",
			"timestamp": "2026-05-25T01:00:00.000Z",
			"payload": map[string]any{
				"id":        "incomplete-child",
				"timestamp": "2026-05-25T01:00:00.000Z",
				"source":    map[string]any{"subagent": map[string]any{"thread_spawn": map[string]any{}}},
			},
		},
		subagentChildSessionMeta("child-thread", "parent-thread", "2026-05-25T01:00:00.000Z"),
		subagentUsageEventWithLast(
			"2026-05-25T01:10:00.000Z",
			subagentTokens(1200, 1050, 70),
			subagentTokens(200, 150, 20),
			"",
		),
	})

	got := subagentApply(t, SubagentCorrectionInput{
		Snapshots:  []contract.Snapshot{subagentCodexSnapshot()},
		Sessions:   subagentInheritedSessionResult(),
		CodexHomes: []string{home},
		Timezone:   "Asia/Shanghai",
	})

	subagentAssertSnapshot(t, got[0], subagentExpectedSnapshot{
		Input: 50, Output: 20, CacheRead: 150, Total: 220,
	})
}

func TestPreservesCacheCreationTokensWhileCorrectingChildUsage(t *testing.T) {
	home := t.TempDir()
	childFile := filepath.Join(home, "sessions", "2026", "05", "25", "rollout-child-thread.jsonl")
	writeJSONL(t, childFile, []map[string]any{
		subagentChildSessionMeta("child-thread", "parent-thread", "2026-05-25T01:00:00.000Z"),
	})

	snapshot := subagentCodexSnapshot()
	snapshot.CacheCreation = 100
	snapshot.TotalTokens = 3270
	snapshot.CostUSD = 3.27
	sessions := map[string]any{
		"sessions": []any{
			map[string]any{
				"sessionId":    "2026/05/25/rollout-child-thread",
				"lastActivity": "2026-05-25T01:10:00.000Z",
				"totalTokens":  float64(3270),
				"costUSD":      float64(3.27),
				"models": map[string]any{
					"gpt-5": map[string]any{
						"inputTokens":              float64(1100),
						"cacheCreationInputTokens": float64(100),
						"cachedInputTokens":        float64(1950),
						"outputTokens":             float64(120),
						"totalTokens":              float64(3270),
						"costUSD":                  float64(3.27),
					},
				},
			},
		},
	}

	got := subagentApply(t, SubagentCorrectionInput{
		Snapshots:  []contract.Snapshot{snapshot},
		Sessions:   sessions,
		CodexHomes: []string{home},
		Timezone:   "Asia/Shanghai",
		ReadChildUsageByDate: func(string, string, string, func(string), string) ([]DatedUsage, error) {
			return []DatedUsage{subagentDatedUsage("2026-05-25", 200, 30, 150, 20, 250)}, nil
		},
	})

	subagentAssertSnapshot(t, got[0], subagentExpectedSnapshot{
		Input: 50, Output: 20, CacheCreation: 30, CacheRead: 150, Total: 250,
	})
}

func TestSkipsChildUsageReadsForSessionsBeforeTheEarliestSnapshotDate(t *testing.T) {
	home := t.TempDir()
	oldChildFile := filepath.Join(home, "sessions", "2026", "04", "01", "rollout-old-child-thread.jsonl")
	currentChildFile := filepath.Join(home, "sessions", "2026", "05", "25", "rollout-child-thread.jsonl")
	subagentWriteInheritedChildSession(t, oldChildFile)
	subagentWriteInheritedChildSession(t, currentChildFile)

	currentRow := subagentInheritedSessionResult()["sessions"].([]any)[0].(map[string]any)
	oldRow := map[string]any{}
	for key, value := range currentRow {
		oldRow[key] = value
	}
	oldRow["sessionId"] = "2026/04/01/rollout-old-child-thread"
	oldRow["lastActivity"] = "2026-04-01T01:10:00.000Z"
	sessions := map[string]any{"sessions": []any{oldRow, currentRow}}

	reads := []string{}
	got := subagentApply(t, SubagentCorrectionInput{
		Snapshots:  []contract.Snapshot{subagentCodexSnapshot()},
		Sessions:   sessions,
		CodexHomes: []string{home},
		Timezone:   "Asia/Shanghai",
		ReadChildUsageByDate: func(filePath, _, _ string, _ func(string), _ string) ([]DatedUsage, error) {
			reads = append(reads, filePath)
			return []DatedUsage{subagentDatedUsage("2026-05-25", 200, 0, 150, 20, 220)}, nil
		},
	})

	resolvedCurrent, err := filepath.EvalSymlinks(currentChildFile)
	if err != nil {
		t.Fatalf("realpath: %v", err)
	}
	if !reflect.DeepEqual(reads, []string{resolvedCurrent}) {
		t.Fatalf("child reads = %v, want [%s]", reads, resolvedCurrent)
	}
	subagentAssertSnapshot(t, got[0], subagentExpectedSnapshot{
		Input: 50, Output: 20, CacheRead: 150, Total: 220,
	})
}

func TestKeepsATimezoneBoundaryChildSessionInsideTheSnapshotWindow(t *testing.T) {
	home := t.TempDir()
	childFile := filepath.Join(home, "sessions", "2026", "05", "25", "rollout-child-thread.jsonl")
	subagentWriteInheritedChildSession(t, childFile)

	sessions := subagentInheritedSessionResult()
	sessions["sessions"].([]any)[0].(map[string]any)["lastActivity"] = "2026-05-25T16:00:00.000Z"
	snapshot := subagentCodexSnapshot()
	snapshot.UsageDate = "2026-05-26"

	reads := 0
	subagentApply(t, SubagentCorrectionInput{
		Snapshots:  []contract.Snapshot{snapshot},
		Sessions:   sessions,
		CodexHomes: []string{home},
		Timezone:   "Asia/Shanghai",
		ReadChildUsageByDate: func(string, string, string, func(string), string) ([]DatedUsage, error) {
			reads++
			return nil, nil
		},
	})

	if reads != 1 {
		t.Fatalf("child reads = %d, want 1", reads)
	}
}

func TestRetainsChildCacheCreationTokensInCollectedSnapshots(t *testing.T) {
	home := t.TempDir()
	stateDir := t.TempDir()
	childFile := filepath.Join(home, "sessions", "2026", "05", "25", "rollout-child-thread.jsonl")
	writeJSONL(t, childFile, []map[string]any{
		subagentChildSessionMeta("child-thread", "parent-thread", "2026-05-25T01:00:00.000Z"),
		{
			"type":      "event_msg",
			"timestamp": "2026-05-25T01:10:00.000Z",
			"payload": map[string]any{
				"type": "token_count",
				"info": map[string]any{
					"model": "gpt-5",
					"total_token_usage": map[string]any{
						"input_tokens":                float64(1200),
						"cache_creation_input_tokens": float64(100),
						"cached_input_tokens":         float64(1050),
						"output_tokens":               float64(70),
						"total_tokens":                float64(1370),
					},
					"last_token_usage": map[string]any{
						"input_tokens":                float64(200),
						"cache_creation_input_tokens": float64(30),
						"cached_input_tokens":         float64(150),
						"output_tokens":               float64(20),
						"total_tokens":                float64(250),
					},
				},
			},
		},
	})

	snapshot := subagentCodexSnapshot()
	snapshot.CacheCreation = 100
	snapshot.TotalTokens = 3270
	snapshot.CostUSD = 3.27
	sessions := map[string]any{
		"sessions": []any{
			map[string]any{
				"sessionId":    "2026/05/25/rollout-child-thread",
				"lastActivity": "2026-05-25T01:10:00.000Z",
				"totalTokens":  float64(3270),
				"costUSD":      float64(3.27),
				"models": map[string]any{
					"gpt-5": map[string]any{
						"inputTokens":              float64(1100),
						"cacheCreationInputTokens": float64(100),
						"cachedInputTokens":        float64(1950),
						"outputTokens":             float64(120),
						"totalTokens":              float64(3270),
						"costUSD":                  float64(3.27),
					},
				},
			},
		},
	}

	got := subagentApply(t, SubagentCorrectionInput{
		Snapshots:  []contract.Snapshot{snapshot},
		Sessions:   sessions,
		CodexHomes: []string{home},
		StateDir:   stateDir,
		Timezone:   "Asia/Shanghai",
	})

	subagentAssertSnapshot(t, got[0], subagentExpectedSnapshot{
		Input: 50, Output: 20, CacheCreation: 30, CacheRead: 150, Total: 250, Cost: subagentCost(0.25),
	})
}

func TestDoesNotPersistACacheEntryAfterItsLockOwnershipChanges(t *testing.T) {
	home := t.TempDir()
	stateDir := t.TempDir()
	cachePath := filepath.Join(stateDir, "codex-subagent-usage-cache.json")
	lockPath := cachePath + ".lock"
	childFile := filepath.Join(home, "sessions", "2026", "05", "25", "rollout-child-thread.jsonl")
	subagentWriteInheritedChildSession(t, childFile)

	_, err := ApplyCodexSubagentUsageCorrections(SubagentCorrectionInput{
		Snapshots:  []contract.Snapshot{subagentCodexSnapshot()},
		Sessions:   subagentInheritedSessionResult(),
		CodexHomes: []string{home},
		StateDir:   stateDir,
		Timezone:   "Asia/Shanghai",
		ReadChildUsageByDate: func(string, string, string, func(string), string) ([]DatedUsage, error) {
			if err := os.Remove(lockPath); err != nil {
				return nil, err
			}
			payload := []byte(`{"pid":` + itoa64(int64(os.Getpid())) + `,"token":"replacement-owner"}`)
			if err := os.WriteFile(lockPath, payload, 0o600); err != nil {
				return nil, err
			}
			return []DatedUsage{subagentDatedUsage("2026-05-25", 200, 0, 150, 20, 220)}, nil
		},
	})
	if err == nil || !strings.Contains(err.Error(), "Cursor lock ownership changed") {
		t.Fatalf("error = %v, want a cursor lock ownership failure", err)
	}
	if _, statErr := os.Stat(cachePath); !os.IsNotExist(statErr) {
		t.Fatalf("cache file must not exist after an ownership failure, stat error = %v", statErr)
	}
}

func TestReusesStableChildUsageDataFromTheLocalCache(t *testing.T) {
	home := t.TempDir()
	stateDir := t.TempDir()
	childFile := filepath.Join(home, "sessions", "2026", "05", "25", "rollout-child-thread.jsonl")
	subagentWriteInheritedChildSession(t, childFile)

	reads := 0
	readByDate := func(string, string, string, func(string), string) ([]DatedUsage, error) {
		reads++
		return []DatedUsage{subagentDatedUsage("2026-05-25", 200, 0, 150, 20, 220)}, nil
	}
	input := SubagentCorrectionInput{
		Snapshots:            []contract.Snapshot{subagentCodexSnapshot()},
		Sessions:             subagentInheritedSessionResult(),
		CodexHomes:           []string{home},
		StateDir:             stateDir,
		Timezone:             "Asia/Shanghai",
		ReadChildUsageByDate: readByDate,
	}

	first := subagentApply(t, input)
	second := subagentApply(t, SubagentCorrectionInput{
		Snapshots:            []contract.Snapshot{subagentCodexSnapshot()},
		Sessions:             input.Sessions,
		CodexHomes:           input.CodexHomes,
		StateDir:             input.StateDir,
		Timezone:             input.Timezone,
		ReadChildUsageByDate: readByDate,
	})

	if reads != 1 {
		t.Fatalf("child reads = %d, want 1", reads)
	}
	if !reflect.DeepEqual(second, first) {
		t.Fatalf("second correction = %+v, want %+v", second, first)
	}
}

func TestRetainsStableCachedChildUsageAcrossNarrowerSessionWindows(t *testing.T) {
	home := t.TempDir()
	stateDir := t.TempDir()
	subagentWriteCachedChildSession(t, filepath.Join(home, "sessions", "2026", "05", "25", "rollout-child-a.jsonl"), "child-a")
	subagentWriteCachedChildSession(t, filepath.Join(home, "sessions", "2026", "05", "25", "rollout-child-b.jsonl"), "child-b")

	reads := 0
	readByDate := func(string, string, string, func(string), string) ([]DatedUsage, error) {
		reads++
		return []DatedUsage{subagentDatedUsage("2026-05-25", 200, 0, 150, 20, 220)}, nil
	}
	apply := func(sessions map[string]any) {
		subagentApply(t, SubagentCorrectionInput{
			Snapshots:            []contract.Snapshot{subagentCodexSnapshot()},
			Sessions:             sessions,
			CodexHomes:           []string{home},
			StateDir:             stateDir,
			Timezone:             "Asia/Shanghai",
			ReadChildUsageByDate: readByDate,
		})
	}

	apply(subagentSessionResultFor("child-a"))
	apply(subagentSessionResultFor("child-b"))
	apply(subagentSessionResultFor("child-a"))

	if reads != 2 {
		t.Fatalf("child reads = %d, want 2", reads)
	}
}

func TestInvalidatesCachedChildUsageWhenCtimeChangesDespiteStableMtimeAndTail(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows exposes no change time through os.FileInfo; the fingerprint falls back to mtime by design")
	}
	home := t.TempDir()
	stateDir := t.TempDir()
	childFile := filepath.Join(home, "sessions", "2026", "05", "25", "rollout-child-thread.jsonl")
	subagentWriteInheritedChildSession(t, childFile)
	padding := `{"padding":"` + strings.Repeat("x", 70*1024) + `"}` + "\n"
	file, err := os.OpenFile(childFile, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatalf("open child: %v", err)
	}
	if _, err := file.WriteString(padding); err != nil {
		file.Close()
		t.Fatalf("append padding: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("close child: %v", err)
	}
	fixedTime := time.Date(2026, 5, 25, 1, 20, 0, 0, time.UTC)
	if err := os.Chtimes(childFile, fixedTime, fixedTime); err != nil {
		t.Fatalf("chtimes: %v", err)
	}
	before, err := os.Stat(childFile)
	if err != nil {
		t.Fatalf("stat before: %v", err)
	}

	reads := 0
	readByDate := func(string, string, string, func(string), string) ([]DatedUsage, error) {
		reads++
		return []DatedUsage{subagentDatedUsage("2026-05-25", 200, 0, 150, 20, 220)}, nil
	}
	apply := func() {
		subagentApply(t, SubagentCorrectionInput{
			Snapshots:            []contract.Snapshot{subagentCodexSnapshot()},
			Sessions:             subagentInheritedSessionResult(),
			CodexHomes:           []string{home},
			StateDir:             stateDir,
			Timezone:             "Asia/Shanghai",
			ReadChildUsageByDate: readByDate,
		})
	}
	apply()

	content, err := os.ReadFile(childFile)
	if err != nil {
		t.Fatalf("read child: %v", err)
	}
	renewed := strings.Replace(string(content), "child-thread", "child-renewd", 1)
	if err := os.WriteFile(childFile, []byte(renewed), 0o644); err != nil {
		t.Fatalf("rewrite child: %v", err)
	}
	if err := os.Chtimes(childFile, fixedTime, fixedTime); err != nil {
		t.Fatalf("chtimes after rewrite: %v", err)
	}
	after, err := os.Stat(childFile)
	if err != nil {
		t.Fatalf("stat after: %v", err)
	}
	if after.Size() != before.Size() {
		t.Fatalf("size = %d, want %d", after.Size(), before.Size())
	}
	if !after.ModTime().Equal(before.ModTime()) {
		t.Fatalf("mtime = %v, want %v", after.ModTime(), before.ModTime())
	}

	apply()
	if reads != 2 {
		t.Fatalf("child reads = %d, want 2", reads)
	}
}

func TestStopsReadingANormalSessionAfterItsSessionMetadata(t *testing.T) {
	home := t.TempDir()
	normalFile := filepath.Join(home, "sessions", "2026", "05", "25", "rollout-parent-thread.jsonl")
	writeJSONL(t, normalFile, []map[string]any{subagentSessionMeta("parent-thread", "2026-05-25T01:00:00.000Z")})
	file, err := os.OpenFile(normalFile, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatalf("open normal session: %v", err)
	}
	if _, err := file.WriteString("{malformed-json}\n"); err != nil {
		file.Close()
		t.Fatalf("append malformed row: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("close normal session: %v", err)
	}

	diagnostics := []string{}
	reads := 0
	// The session report is empty because the daily report was empty: the
	// correction returns before resolving any session file, which is why a
	// malformed row in a normal session is never read.
	got := subagentApply(t, SubagentCorrectionInput{
		Snapshots:  nil,
		Sessions:   map[string]any{"sessions": []any{map[string]any{"sessionId": "2026/05/25/rollout-parent-thread"}}},
		CodexHomes: []string{home},
		Timezone:   "Asia/Shanghai",
		Stderr:     func(line string) { diagnostics = append(diagnostics, line) },
		ReadChildUsageByDate: func(string, string, string, func(string), string) ([]DatedUsage, error) {
			reads++
			return nil, nil
		},
	})

	if len(got) != 0 {
		t.Fatalf("got %d snapshots, want 0", len(got))
	}
	if reads != 0 {
		t.Fatalf("child reads = %d, want 0", reads)
	}
	if len(diagnostics) != 0 {
		t.Fatalf("diagnostics = %v, want none", diagnostics)
	}
}

func TestKeepsChargedSubagentDeltaWhileRemovingDuplicatedParentHistory(t *testing.T) {
	home := t.TempDir()
	childFile := filepath.Join(home, "sessions", "2026", "05", "25", "rollout-child-thread.jsonl")
	subagentWriteInheritedChildSession(t, childFile)

	got := subagentApply(t, SubagentCorrectionInput{
		Snapshots:  []contract.Snapshot{subagentCodexSnapshot()},
		Sessions:   subagentInheritedSessionResult(),
		CodexHomes: []string{home},
		Timezone:   "Asia/Shanghai",
	})

	if len(got) != 1 {
		t.Fatalf("got %d snapshots, want 1", len(got))
	}
	if got[0].Source != contract.SourceCodex || got[0].UsageDate != "2026-05-25" || got[0].Model != "gpt-5" {
		t.Fatalf("snapshot identity = %+v", got[0])
	}
	subagentAssertSnapshot(t, got[0], subagentExpectedSnapshot{
		Input: 50, Output: 20, CacheRead: 150, Total: 220, Cost: subagentCost(0.22),
	})
}

func TestSplitsSubagentCorrectionsByChildUsageDate(t *testing.T) {
	home := t.TempDir()
	childFile := filepath.Join(home, "sessions", "2026", "05", "26", "rollout-child-thread.jsonl")
	writeJSONL(t, childFile, []map[string]any{
		subagentChildSessionMeta("child-thread", "parent-thread", "2026-05-25T23:50:00.000Z"),
		subagentUsageEventWithLast(
			"2026-05-25T23:55:00.000Z",
			subagentTokens(1200, 1050, 70),
			subagentTokens(200, 150, 20),
			"",
		),
		subagentUsageEventWithLast(
			"2026-05-26T00:10:00.000Z",
			subagentTokens(1400, 1200, 90),
			subagentTokens(200, 150, 20),
			"",
		),
	})

	first := subagentCodexSnapshot()
	first.Timezone = "UTC"
	second := first
	second.UsageDate = "2026-05-26"

	got := subagentApply(t, SubagentCorrectionInput{
		Snapshots:  []contract.Snapshot{first, second},
		Sessions:   subagentMultiDaySessionResult(),
		CodexHomes: []string{home},
		Timezone:   "UTC",
	})

	if len(got) != 2 {
		t.Fatalf("got %d snapshots, want 2", len(got))
	}
	if got[0].UsageDate != "2026-05-25" || got[1].UsageDate != "2026-05-26" {
		t.Fatalf("dates = %s, %s", got[0].UsageDate, got[1].UsageDate)
	}
	for _, snapshot := range got {
		if snapshot.Model != "gpt-5" {
			t.Fatalf("model = %s, want gpt-5", snapshot.Model)
		}
		subagentAssertSnapshot(t, snapshot, subagentExpectedSnapshot{
			Input: 50, Output: 20, CacheRead: 150, Total: 220, Cost: subagentCost(0.22),
		})
	}
}

func TestBucketsSubagentCorrectionsByReportTimezone(t *testing.T) {
	home := t.TempDir()
	childFile := filepath.Join(home, "sessions", "2026", "05", "25", "rollout-child-thread.jsonl")
	writeJSONL(t, childFile, []map[string]any{
		subagentChildSessionMeta("child-thread", "parent-thread", "2026-05-25T16:00:00.000Z"),
		subagentUsageEventWithLast(
			"2026-05-25T16:10:00.000Z",
			subagentTokens(1200, 1050, 70),
			subagentTokens(200, 150, 20),
			"",
		),
	})

	sessions := subagentInheritedSessionResult()
	sessions["sessions"].([]any)[0].(map[string]any)["lastActivity"] = "2026-05-26"
	snapshot := subagentCodexSnapshot()
	snapshot.UsageDate = "2026-05-26"

	got := subagentApply(t, SubagentCorrectionInput{
		Snapshots:  []contract.Snapshot{snapshot},
		Sessions:   sessions,
		CodexHomes: []string{home},
		Timezone:   "Asia/Shanghai",
	})

	if len(got) != 1 || got[0].UsageDate != "2026-05-26" {
		t.Fatalf("snapshots = %+v, want one on 2026-05-26", got)
	}
	subagentAssertSnapshot(t, got[0], subagentExpectedSnapshot{
		Input: 50, Output: 20, CacheRead: 150, Total: 220, Cost: subagentCost(0.22),
	})
}

func TestKeepsIndependentSubagentTotalsWhenChildCountersDoNotIncludeParentHistory(t *testing.T) {
	home := t.TempDir()
	childFile := filepath.Join(home, "sessions", "2026", "05", "25", "rollout-child-thread.jsonl")
	writeJSONL(t, childFile, []map[string]any{
		subagentChildSessionMeta("child-thread", "parent-thread", "2026-05-25T01:00:00.000Z"),
		subagentUsageEvent("2026-05-25T01:10:00.000Z", subagentTokens(200, 150, 20), ""),
	})

	got := subagentApply(t, SubagentCorrectionInput{
		Snapshots:  []contract.Snapshot{subagentSnapshotForModel("gpt-5", 50, 150, 20, 220, 0.22)},
		Sessions:   subagentIndependentSessionResult(),
		CodexHomes: []string{home},
		Timezone:   "Asia/Shanghai",
	})

	subagentAssertSnapshot(t, got[0], subagentExpectedSnapshot{
		Input: 50, Output: 20, CacheRead: 150, Total: 220, Cost: subagentCost(0.22),
	})
}

func TestDoesNotSubtractSessionOnlyInflationWhenDailyTotalsAlreadyMatchChildUsage(t *testing.T) {
	home := t.TempDir()
	childFile := filepath.Join(home, "sessions", "2026", "05", "25", "rollout-child-thread.jsonl")
	subagentWriteInheritedChildSession(t, childFile)

	got := subagentApply(t, SubagentCorrectionInput{
		Snapshots:  []contract.Snapshot{subagentSnapshotForModel("gpt-5", 50, 150, 20, 220, 0.22)},
		Sessions:   subagentInheritedSessionResult(),
		CodexHomes: []string{home},
		Timezone:   "Asia/Shanghai",
	})

	subagentAssertSnapshot(t, got[0], subagentExpectedSnapshot{
		Input: 50, Output: 20, CacheRead: 150, Total: 220, Cost: subagentCost(0.22),
	})
}

func TestNormalizesDisplaySessionDatesWithoutLocalTimezoneDrift(t *testing.T) {
	home := t.TempDir()
	childFile := filepath.Join(home, "sessions", "2026", "04", "28", "rollout-child-thread.jsonl")
	writeJSONL(t, childFile, []map[string]any{
		subagentChildSessionMeta("child-thread", "parent-thread", "2026-04-28T01:00:00.000Z"),
		subagentUsageEventWithLast(
			"2026-04-28T01:10:00.000Z",
			subagentTokens(1200, 1050, 70),
			subagentTokens(200, 150, 20),
			"",
		),
	})

	sessions := subagentInheritedSessionResult()
	row := sessions["sessions"].([]any)[0].(map[string]any)
	row["sessionId"] = "2026/04/28/rollout-child-thread"
	row["lastActivity"] = "Apr 28, 2026"
	snapshot := subagentCodexSnapshot()
	snapshot.UsageDate = "2026-04-28"

	got := subagentApply(t, SubagentCorrectionInput{
		Snapshots:  []contract.Snapshot{snapshot},
		Sessions:   sessions,
		CodexHomes: []string{home},
		Timezone:   "Asia/Shanghai",
	})

	if len(got) != 1 || got[0].UsageDate != "2026-04-28" {
		t.Fatalf("snapshots = %+v, want one on 2026-04-28", got)
	}
	subagentAssertSnapshot(t, got[0], subagentExpectedSnapshot{
		Input: 50, Output: 20, CacheRead: 150, Total: 220,
	})
}

func TestIncludesCachedTokensWhenTotalFieldsAreOmitted(t *testing.T) {
	home := t.TempDir()
	childFile := filepath.Join(home, "sessions", "2026", "05", "25", "rollout-child-thread.jsonl")
	subagentWriteInheritedChildSession(t, childFile)

	sessions := subagentInheritedSessionResult()
	row := sessions["sessions"].([]any)[0].(map[string]any)
	delete(row, "totalTokens")
	delete(row["models"].(map[string]any)["gpt-5"].(map[string]any), "totalTokens")

	got := subagentApply(t, SubagentCorrectionInput{
		Snapshots:  []contract.Snapshot{subagentCodexSnapshot()},
		Sessions:   sessions,
		CodexHomes: []string{home},
		Timezone:   "Asia/Shanghai",
	})

	subagentAssertSnapshot(t, got[0], subagentExpectedSnapshot{
		Input: 50, Output: 20, CacheRead: 150, Total: 220, Cost: subagentCost(0.22),
	})
}

func TestCorrectsBoundedSubagentUsageWithoutRequiringParentSessionLookup(t *testing.T) {
	home := t.TempDir()
	parentFile := filepath.Join(home, "sessions", "2026", "05", "24", "rollout-parent-thread.jsonl")
	writeJSONL(t, parentFile, []map[string]any{
		subagentSessionMeta("parent-thread", "2026-05-24T13:00:00.000Z"),
		subagentUsageEvent("2026-05-24T23:50:00.000Z", subagentTokens(1000, 900, 50), ""),
	})
	childFile := filepath.Join(home, "sessions", "2026", "05", "25", "rollout-child-thread.jsonl")
	writeJSONL(t, childFile, []map[string]any{
		subagentChildSessionMeta("child-thread", "parent-thread", "2026-05-25T01:00:00.000Z"),
		subagentUsageEventWithLast(
			"2026-05-25T01:10:00.000Z",
			subagentTokens(1200, 1050, 70),
			subagentTokens(200, 150, 20),
			"",
		),
	})

	got := subagentApply(t, SubagentCorrectionInput{
		Snapshots:  []contract.Snapshot{subagentCodexSnapshot()},
		Sessions:   subagentInheritedSessionResult(),
		CodexHomes: []string{home},
		Timezone:   "Asia/Shanghai",
	})

	subagentAssertSnapshot(t, got[0], subagentExpectedSnapshot{
		Input: 50, Output: 20, CacheRead: 150, Total: 220,
	})
}

func TestIgnoresSubagentSessionIDPathsThatEscapeTheSessionsDirectory(t *testing.T) {
	home := t.TempDir()
	subagentWriteInheritedChildSession(t, filepath.Join(home, "outside-child-thread.jsonl"))

	sessions := subagentInheritedSessionResult()
	sessions["sessions"].([]any)[0].(map[string]any)["sessionId"] = "../outside-child-thread"

	got := subagentApply(t, SubagentCorrectionInput{
		Snapshots:  []contract.Snapshot{subagentCodexSnapshot()},
		Sessions:   sessions,
		CodexHomes: []string{home},
		Timezone:   "Asia/Shanghai",
	})

	subagentAssertSnapshot(t, got[0], subagentExpectedSnapshot{
		Input: 1100, Output: 120, CacheRead: 1950, Total: 3170,
	})
}

func TestIgnoresSubagentDirectoryAndSessionFilePathsThatEscapeTheSessionsDirectory(t *testing.T) {
	home := t.TempDir()
	subagentWriteInheritedChildSession(t, filepath.Join(home, "outside-child-thread.jsonl"))

	sessions := subagentInheritedSessionResult()
	row := sessions["sessions"].([]any)[0].(map[string]any)
	delete(row, "sessionId")
	row["directory"] = ".."
	row["sessionFile"] = "outside-child-thread"

	got := subagentApply(t, SubagentCorrectionInput{
		Snapshots:  []contract.Snapshot{subagentCodexSnapshot()},
		Sessions:   sessions,
		CodexHomes: []string{home},
		Timezone:   "Asia/Shanghai",
	})

	subagentAssertSnapshot(t, got[0], subagentExpectedSnapshot{
		Input: 1100, Output: 120, CacheRead: 1950, Total: 3170,
	})
}

func TestDistributesCorrectedSubagentUsageAcrossMultiModelSessionRows(t *testing.T) {
	home := t.TempDir()
	parentFile := filepath.Join(home, "sessions", "2026", "05", "15", "rollout-parent-thread.jsonl")
	writeJSONL(t, parentFile, []map[string]any{
		subagentSessionMeta("parent-thread", "2026-05-15T13:00:00.000Z"),
		subagentUsageEvent("2026-05-25T00:50:00.000Z", subagentTokens(1000, 900, 50), ""),
	})
	childFile := filepath.Join(home, "sessions", "2026", "05", "25", "rollout-child-thread.jsonl")
	writeJSONL(t, childFile, []map[string]any{
		subagentChildSessionMeta("child-thread", "parent-thread", "2026-05-25T01:00:00.000Z"),
		subagentUsageEventWithLast(
			"2026-05-25T01:10:00.000Z",
			subagentTokens(1200, 1050, 70),
			subagentTokens(200, 150, 20),
			"",
		),
	})

	// The daily report carries one row cost, so normalization prorates it
	// across the model rows by token share before the correction runs. These
	// are the row costs the TS pipeline hands to applyCodexSubagentUsageCorrections.
	diagnostics := []string{}
	got := subagentApply(t, SubagentCorrectionInput{
		Snapshots: []contract.Snapshot{
			subagentSnapshotForModel("gpt-5.4", 100, 300, 20, 420, 0.42),
			subagentSnapshotForModel("gpt-5.5", 1000, 1650, 100, 2750, 2.75),
		},
		Sessions:   subagentInheritedMultiModelSessionResult(),
		CodexHomes: []string{home},
		Timezone:   "Asia/Shanghai",
		Stderr:     func(line string) { diagnostics = append(diagnostics, line) },
	})

	if len(got) != 2 || got[0].Model != "gpt-5.4" || got[1].Model != "gpt-5.5" {
		t.Fatalf("snapshots = %+v, want the gpt-5.4 and gpt-5.5 rows", got)
	}
	var total, cacheRead, input, output int64
	cost := 0.0
	for _, snapshot := range got {
		total += snapshot.TotalTokens
		cacheRead += snapshot.CacheRead
		input += snapshot.InputTokens
		output += snapshot.OutputTokens
		cost += snapshot.CostUSD
	}
	if total != 220 || cacheRead != 150 || input != 50 || output != 20 {
		t.Fatalf("summed correction = input %d cacheRead %d output %d total %d, want 50/150/20/220 (diagnostics %v)",
			input, cacheRead, output, total, diagnostics)
	}
	if math.Abs(cost-0.22) > 1e-9 {
		t.Fatalf("summed cost = %v, want 0.22", cost)
	}
}

func TestKeepsRawMultiModelUsageWhenCorrectedDistributionCannotBeSubtracted(t *testing.T) {
	home := t.TempDir()
	childFile := filepath.Join(home, "sessions", "2026", "05", "25", "rollout-child-thread.jsonl")
	writeJSONL(t, childFile, []map[string]any{
		subagentChildSessionMeta("child-thread", "parent-thread", "2026-05-25T01:00:00.000Z"),
		subagentUsageEvent("2026-05-25T01:10:00.000Z", subagentTokens(1000, 1000, 10), ""),
	})

	diagnostics := []string{}
	got := subagentApply(t, SubagentCorrectionInput{
		Snapshots: []contract.Snapshot{
			subagentSnapshotForModel("gpt-5.4", 10, 1, 1, 12, 0.012),
			subagentSnapshotForModel("gpt-5.5", 1000, 1000, 100, 2100, 2.1),
		},
		Sessions:   subagentSkewedMultiModelSessionResult(),
		CodexHomes: []string{home},
		Timezone:   "Asia/Shanghai",
		Stderr:     func(line string) { diagnostics = append(diagnostics, line) },
	})

	if len(got) != 2 || got[0].Model != "gpt-5.4" || got[1].Model != "gpt-5.5" {
		t.Fatalf("snapshots = %+v, want the gpt-5.4 and gpt-5.5 rows", got)
	}
	if got[0].CacheRead != 1 || got[0].TotalTokens != 12 {
		t.Fatalf("gpt-5.4 row = %+v, want its raw cacheRead=1 total=12", got[0])
	}
	if got[0].TotalTokens+got[1].TotalTokens != 2112 {
		t.Fatalf("total = %d, want 2112", got[0].TotalTokens+got[1].TotalTokens)
	}
	want := "Skipping Codex subagent usage correction for 2026-05-25/gpt-5.4: corrected usage exceeds session row"
	if !subagentContainsLine(diagnostics, want) {
		t.Fatalf("diagnostics = %v, want %q", diagnostics, want)
	}
}

func TestReportsAChildWhoseUsageExceedsTheSessionRowInsteadOfSkippingQuietly(t *testing.T) {
	home := t.TempDir()
	childFile := filepath.Join(home, "sessions", "2026", "05", "25", "rollout-child-thread.jsonl")
	writeJSONL(t, childFile, []map[string]any{
		subagentChildSessionMeta("child-thread", "parent-thread", "2026-05-25T01:00:00.000Z"),
		subagentUsageEventWithLast(
			"2026-05-25T01:10:00.000Z",
			subagentTokens(999999, 0, 0),
			subagentTokens(999999, 0, 0),
			"",
		),
	})
	sessions := map[string]any{
		"sessions": []any{
			map[string]any{
				"sessionId":    "2026/05/25/rollout-child-thread",
				"lastActivity": "2026-05-25T01:10:00.000Z",
				"totalTokens":  float64(100),
				"costUSD":      float64(0.1),
				"models": map[string]any{
					"gpt-5": map[string]any{
						"inputTokens":       float64(100),
						"cachedInputTokens": float64(0),
						"outputTokens":      float64(0),
						"totalTokens":       float64(100),
						"costUSD":           float64(0.1),
					},
				},
			},
		},
	}

	diagnostics := []string{}
	got := subagentApply(t, SubagentCorrectionInput{
		Snapshots:  []contract.Snapshot{subagentSnapshotForModel("gpt-5", 100, 0, 0, 100, 0.1)},
		Sessions:   sessions,
		CodexHomes: []string{home},
		Timezone:   "Asia/Shanghai",
		Stderr:     func(line string) { diagnostics = append(diagnostics, line) },
	})

	if len(got) != 1 || got[0].TotalTokens != 100 {
		t.Fatalf("snapshots = %+v, want the unchanged 100-token row", got)
	}
	want := "Skipping Codex subagent usage correction for 2026-05-25/gpt-5: child usage 999999 exceeds session row 100"
	if !subagentContainsLine(diagnostics, want) {
		t.Fatalf("diagnostics = %v, want %q", diagnostics, want)
	}
}

func TestIgnoresMalformedSubagentJSONLRowsWithoutAbortingCodexCollection(t *testing.T) {
	home := t.TempDir()
	parentFile := filepath.Join(home, "sessions", "2026", "05", "15", "rollout-parent-thread.jsonl")
	writeJSONL(t, parentFile, []map[string]any{
		subagentSessionMeta("parent-thread", "2026-05-15T13:00:00.000Z"),
		subagentUsageEvent("2026-05-25T00:50:00.000Z", subagentTokens(1000, 900, 50), ""),
	})
	childFile := filepath.Join(home, "sessions", "2026", "05", "25", "rollout-child-thread.jsonl")
	writeJSONL(t, childFile, []map[string]any{
		subagentChildSessionMeta("child-thread", "parent-thread", "2026-05-25T01:00:00.000Z"),
		subagentUsageEventWithLast(
			"2026-05-25T01:10:00.000Z",
			subagentTokens(1200, 1050, 70),
			subagentTokens(200, 150, 20),
			"",
		),
	})
	file, err := os.OpenFile(childFile, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatalf("open child: %v", err)
	}
	if _, err := file.WriteString("{\"type\":\"event_msg\",\n"); err != nil {
		file.Close()
		t.Fatalf("append malformed row: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("close child: %v", err)
	}

	diagnostics := []string{}
	got := subagentApply(t, SubagentCorrectionInput{
		Snapshots:  []contract.Snapshot{subagentCodexSnapshot()},
		Sessions:   subagentInheritedSessionResult(),
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
	if !subagentContainsLine(diagnostics, "Skipping malformed Codex subagent JSONL row at line 3") {
		t.Fatalf("diagnostics = %v, want the malformed row warning", diagnostics)
	}
	if strings.Contains(strings.Join(diagnostics, "\n"), childFile) {
		t.Fatalf("diagnostics must not include the session path: %v", diagnostics)
	}
}

func TestDoesNotRejectABoundedScanWhenAnUnrelatedSessionChanges(t *testing.T) {
	home := provEmptyCodexHome(t)
	childFile := filepath.Join(home, "sessions", "2026", "05", "25", "rollout-child-thread.jsonl")
	unrelatedFile := filepath.Join(home, "sessions", "2026", "05", "25", "rollout-unrelated-thread.jsonl")
	subagentWriteInheritedChildSession(t, childFile)
	writeJSONL(t, unrelatedFile, []map[string]any{subagentSessionMeta("unrelated-thread", "2026-05-25T01:00:00.000Z")})

	runner := &provStubRunner{t: t, respond: func(call provCall) (any, error) {
		if call.hasArg("daily") {
			file, err := os.OpenFile(unrelatedFile, os.O_APPEND|os.O_WRONLY, 0o644)
			if err != nil {
				t.Fatalf("open unrelated session: %v", err)
			}
			if _, err := file.WriteString(`{"type":"event_msg"}` + "\n"); err != nil {
				file.Close()
				t.Fatalf("append unrelated session: %v", err)
			}
			if err := file.Close(); err != nil {
				t.Fatalf("close unrelated session: %v", err)
			}
		}
		if call.hasArg("session") {
			return provJSON(t, provSubagentInheritedSessionJSON), nil
		}
		return provJSON(t, provSubagentInheritedDailyJSON), nil
	}}
	diagnostics := []string{}
	got, err := provCollect(t, Options{
		CodexHome:   provHome(home),
		Stderr:      func(line string) { diagnostics = append(diagnostics, line) },
		Since:       "20260525",
		Timezone:    "Asia/Shanghai",
		CollectedAt: "2026-05-25T01:20:00.000Z",
		Runner:      runner.run,
	}, nil)
	if err != nil {
		t.Fatalf("collect: %v", err)
	}

	if len(got) != 1 {
		t.Fatalf("got %d snapshots, want 1", len(got))
	}
	for _, line := range diagnostics {
		if strings.Contains(line, "unrelated") || strings.Contains(line, "retry the sync") {
			t.Fatalf("diagnostics = %v, want no change rejection", diagnostics)
		}
	}
	subagentAssertSnapshot(t, got[0], subagentExpectedSnapshot{
		Input: 50, Output: 20, CacheRead: 150, Total: 220,
	})
}

var (
	provSubagentInheritedDailyJSON = `{"data":[{"date":"2026-05-25","models":{
		"gpt-5":{"inputTokens":1100,"cachedInputTokens":1950,"outputTokens":120,"totalTokens":3170}},
		"totalTokens":3170,"costUSD":3.17}]}`
	provSubagentInheritedSessionJSON = `{"data":[{"sessionId":"2026/05/25/rollout-child-thread",
		"lastActivity":"2026-05-25T01:10:00.000Z","totalTokens":3170,"costUSD":3.17,"models":{
		"gpt-5":{"inputTokens":1100,"cachedInputTokens":1950,"outputTokens":120,
		"totalTokens":3170,"costUSD":3.17}}}]}`
)

func subagentContainsLine(lines []string, want string) bool {
	for _, line := range lines {
		if line == want {
			return true
		}
	}
	return false
}
