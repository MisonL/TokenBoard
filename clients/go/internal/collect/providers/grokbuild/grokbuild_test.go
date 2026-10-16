package grokbuild

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// sessionID and the field names/epoch-seconds timestamp below were taken from
// real ~/.grok/sessions/**/updates.jsonl events, matching the TS fixture.
const (
	sessionID    = "019fb7fc-11bd-7da0-91a4-44be3dbd35e6"
	eventSeconds = 1_785_498_182
	fixtureTZ    = "Asia/Shanghai"
	fixtureAt    = "2026-07-30T10:00:00.000Z"
	fixtureDate  = "2026-07-31"
)

func turnEvent(usage map[string]any, timestamp any) string {
	payload := map[string]any{
		"method":    usageMethod,
		"timestamp": timestamp,
		"params":    map[string]any{"update": map[string]any{"sessionUpdate": "turn_completed", "usage": usage}},
	}
	return marshalJSON(payload)
}

func counters(overrides map[string]any) map[string]any {
	counters := map[string]any{
		"inputTokens":      22_037,
		"outputTokens":     181,
		"totalTokens":      22_218,
		"cachedReadTokens": 22_016,
		"reasoningTokens":  75,
		"modelCalls":       1,
		"apiDurationMs":    2428,
	}
	for key, value := range overrides {
		counters[key] = value
	}
	return counters
}

// grokHome writes files into a temp home, keyed by slash-separated relative
// paths, and returns the home.
func grokHome(t *testing.T, files map[string][]string) string {
	t.Helper()
	home := t.TempDir()
	for relative, lines := range files {
		filePath := filepath.Join(append([]string{home}, strings.Split(relative, "/")...)...)
		if err := os.MkdirAll(filepath.Dir(filePath), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filePath, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return home
}

func runCollect(t *testing.T, home string, mutate func(*Options)) ([]contract.Snapshot, error) {
	t.Helper()
	options := Options{
		GrokHome:    home,
		Timezone:    fixtureTZ,
		CollectedAt: fixtureAt,
		Since:       "all",
	}
	if mutate != nil {
		mutate(&options)
	}
	return Collect(options)
}

func mustCollect(t *testing.T, home string, mutate func(*Options)) []contract.Snapshot {
	t.Helper()
	snapshots, err := runCollect(t, home, mutate)
	if err != nil {
		t.Fatal(err)
	}
	return snapshots
}

func marshalJSON(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return string(encoded)
}

func withModelUsage(usage map[string]any, modelUsage map[string]any) map[string]any {
	merged := map[string]any{}
	for key, value := range usage {
		merged[key] = value
	}
	merged["modelUsage"] = modelUsage
	return merged
}

func models(snapshots []contract.Snapshot) []string {
	out := make([]string, 0, len(snapshots))
	for _, snapshot := range snapshots {
		out = append(out, snapshot.Model)
	}
	return out
}

func TestSubtractsCachedReadsOutOfReportedInput(t *testing.T) {
	home := grokHome(t, map[string][]string{
		"sessions/enc-cwd/" + sessionID + "/updates.jsonl": {
			turnEvent(map[string]any{"modelUsage": map[string]any{"grok-4.5": counters(nil)}}, eventSeconds),
		},
	})

	snapshots := mustCollect(t, home, nil)
	if len(snapshots) != 1 {
		t.Fatalf("snapshots = %d, want 1", len(snapshots))
	}
	got := snapshots[0]
	want := contract.Snapshot{
		Source:       contract.SourceGrokBuild,
		UsageDate:    fixtureDate,
		Timezone:     fixtureTZ,
		Model:        "grok-4.5",
		InputTokens:  21,
		OutputTokens: 181,
		TotalTokens:  22_218,
		CacheRead:    22_016,
		CostUSD:      0,
		SessionCount: 1,
		CollectedAt:  fixtureAt,
	}
	if got != want {
		t.Errorf("snapshot mismatch\n got: %+v\nwant: %+v", got, want)
	}
}

func TestRecordsEachCompletedTurnAtFaceValue(t *testing.T) {
	// Two turns reporting identical numbers are two real turns, not a repeated
	// cumulative snapshot: differencing them would drop the second turn.
	home := grokHome(t, map[string][]string{
		"sessions/enc-cwd/" + sessionID + "/updates.jsonl": {
			turnEvent(map[string]any{"modelUsage": map[string]any{"grok-4.5": counters(nil)}}, eventSeconds),
			turnEvent(map[string]any{"modelUsage": map[string]any{"grok-4.5": counters(nil)}}, eventSeconds+60),
		},
	})

	snapshot := mustCollect(t, home, nil)[0]
	if snapshot.InputTokens != 42 || snapshot.OutputTokens != 362 || snapshot.CacheRead != 44_032 {
		t.Errorf("face-value totals wrong: %+v", snapshot)
	}
}

func TestNeverReportsCostForGrokBuild(t *testing.T) {
	home := grokHome(t, map[string][]string{
		"sessions/enc-cwd/" + sessionID + "/updates.jsonl": {
			turnEvent(map[string]any{
				"modelUsage": map[string]any{"grok-4.5": counters(map[string]any{"costUsdTicks": 23_113_000})},
			}, eventSeconds),
		},
	})

	if got := mustCollect(t, home, nil)[0].CostUSD; got != 0 {
		t.Errorf("costUsd = %v, want 0", got)
	}
}

func TestSplitsTurnAcrossModels(t *testing.T) {
	home := grokHome(t, map[string][]string{
		"sessions/enc-cwd/" + sessionID + "/updates.jsonl": {
			turnEvent(map[string]any{"modelUsage": map[string]any{
				"grok-4.5":          counters(map[string]any{"inputTokens": 1000, "cachedReadTokens": 0, "outputTokens": 10}),
				"deepseek-v4-flash": counters(map[string]any{"inputTokens": 500, "cachedReadTokens": 0, "outputTokens": 5}),
			}}, eventSeconds),
		},
	})

	snapshots := mustCollect(t, home, nil)
	if len(snapshots) != 2 || snapshots[0].Model != "deepseek-v4-flash" || snapshots[1].Model != "grok-4.5" {
		t.Fatalf("models = %v", models(snapshots))
	}
	for _, snapshot := range snapshots {
		if snapshot.Model == "grok-4.5" && snapshot.InputTokens != 1000 {
			t.Errorf("grok input = %d, want 1000", snapshot.InputTokens)
		}
	}
}

func TestKeepsTopLevelTotalsWithoutModelBreakdown(t *testing.T) {
	home := grokHome(t, map[string][]string{
		"sessions/enc-cwd/" + sessionID + "/updates.jsonl": {
			turnEvent(counters(map[string]any{"inputTokens": 1000, "cachedReadTokens": 0, "outputTokens": 10}), eventSeconds),
		},
	})

	snapshot := mustCollect(t, home, nil)[0]
	if snapshot.Model != "unknown" || snapshot.InputTokens != 1000 {
		t.Errorf("snapshot = %+v", snapshot)
	}
}

func TestKeepsTopLevelTotalsForEmptyBreakdown(t *testing.T) {
	home := grokHome(t, map[string][]string{
		"sessions/enc-cwd/" + sessionID + "/updates.jsonl": {
			turnEvent(withModelUsage(
				counters(map[string]any{"inputTokens": 1000, "cachedReadTokens": 0, "outputTokens": 10}),
				map[string]any{},
			), eventSeconds),
		},
	})

	snapshot := mustCollect(t, home, nil)[0]
	if snapshot.Model != "unknown" || snapshot.InputTokens != 1000 {
		t.Errorf("snapshot = %+v", snapshot)
	}
}

func TestKeepsTopLevelTotalsWhenEveryEntryUnreadable(t *testing.T) {
	home := grokHome(t, map[string][]string{
		"sessions/enc-cwd/" + sessionID + "/updates.jsonl": {
			turnEvent(withModelUsage(
				counters(map[string]any{"inputTokens": 1000, "cachedReadTokens": 0, "outputTokens": 10}),
				map[string]any{"grok-4.5": "corrupt"},
			), eventSeconds),
		},
	})

	snapshot := mustCollect(t, home, nil)[0]
	if snapshot.Model != "unknown" || snapshot.InputTokens != 1000 {
		t.Errorf("snapshot = %+v", snapshot)
	}
}

func TestCountsOnlyReadableEntriesWhenPartlyCorrupt(t *testing.T) {
	home := grokHome(t, map[string][]string{
		"sessions/enc-cwd/" + sessionID + "/updates.jsonl": {
			turnEvent(withModelUsage(
				counters(map[string]any{"inputTokens": 1000, "cachedReadTokens": 0, "outputTokens": 10}),
				map[string]any{
					"grok-4.5": counters(map[string]any{"inputTokens": 500, "cachedReadTokens": 0, "outputTokens": 5}),
					"broken":   42,
				},
			), eventSeconds),
		},
	})

	snapshots := mustCollect(t, home, nil)
	if len(snapshots) != 1 || snapshots[0].Model != "grok-4.5" || snapshots[0].InputTokens != 500 {
		t.Errorf("snapshots = %+v", snapshots)
	}
}

func TestReportsUnreadableEntryInsteadOfDroppingIt(t *testing.T) {
	home := grokHome(t, map[string][]string{
		"sessions/enc-cwd/" + sessionID + "/updates.jsonl": {
			turnEvent(withModelUsage(
				counters(map[string]any{"inputTokens": 1000, "cachedReadTokens": 0, "outputTokens": 10}),
				map[string]any{
					"grok-4.5": counters(map[string]any{"inputTokens": 500, "cachedReadTokens": 0, "outputTokens": 5}),
					"broken":   42,
				},
			), eventSeconds),
		},
	})
	var warnings []string
	_, err := runCollect(t, home, func(options *Options) {
		options.Stderr = func(line string) { warnings = append(warnings, line) }
	})
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(warnings, "\n")
	if !strings.Contains(joined, "Skipping unreadable Grok Build modelUsage entry") || !strings.Contains(joined, "broken") {
		t.Errorf("warnings = %q", joined)
	}
}

// A readable but all-zero entry carries no usage of its own; treating it as
// the turn's output would skip the top-level totals and lose them.
func TestFallsBackToTopLevelTotalsWhenEveryEntryZero(t *testing.T) {
	home := grokHome(t, map[string][]string{
		"sessions/enc-cwd/" + sessionID + "/updates.jsonl": {
			turnEvent(withModelUsage(
				counters(map[string]any{"inputTokens": 1000, "cachedReadTokens": 0, "outputTokens": 10}),
				map[string]any{"grok-4.5": counters(map[string]any{
					"inputTokens": 0, "cachedReadTokens": 0, "outputTokens": 0, "totalTokens": 0,
				})},
			), eventSeconds),
		},
	})

	snapshot := mustCollect(t, home, nil)[0]
	if snapshot.Model != "unknown" || snapshot.InputTokens != 1000 {
		t.Errorf("snapshot = %+v", snapshot)
	}
}

func TestIgnoresUpdatesThatAreNotCompletedTurns(t *testing.T) {
	// A mid-turn snapshot alongside the turn's final event would double-count.
	home := grokHome(t, map[string][]string{
		"sessions/enc-cwd/" + sessionID + "/updates.jsonl": {
			marshalJSON(map[string]any{
				"method": usageMethod, "timestamp": eventSeconds,
				"params": map[string]any{"update": map[string]any{"sessionUpdate": "agent_message_chunk", "usage": counters(nil)}},
			}),
			marshalJSON(map[string]any{
				"method": "session/update", "timestamp": eventSeconds,
				"params": map[string]any{"update": map[string]any{"update": map[string]any{"usage": counters(nil)}}},
			}),
			turnEvent(counters(nil), eventSeconds),
		},
	})

	snapshots := mustCollect(t, home, nil)
	if len(snapshots) != 1 || snapshots[0].CacheRead != 22_016 {
		t.Errorf("snapshots = %+v", snapshots)
	}
}

func TestSkipsCompletedTurnWithNonStringKind(t *testing.T) {
	home := grokHome(t, map[string][]string{
		"sessions/enc-cwd/" + sessionID + "/updates.jsonl": {
			marshalJSON(map[string]any{
				"method": usageMethod, "timestamp": eventSeconds,
				"params": map[string]any{"update": map[string]any{"sessionUpdate": 42, "usage": counters(nil)}},
			}),
			marshalJSON(map[string]any{
				"method": usageMethod, "timestamp": eventSeconds,
				"params": map[string]any{"update": map[string]any{"sessionUpdate": []string{"turn_completed"}, "usage": counters(nil)}},
			}),
			turnEvent(counters(nil), eventSeconds),
		},
	})

	snapshots := mustCollect(t, home, nil)
	if len(snapshots) != 1 || snapshots[0].CacheRead != 22_016 {
		t.Errorf("snapshots = %+v", snapshots)
	}
}

func TestSkipsEventsWithoutTimestampOrUsage(t *testing.T) {
	home := grokHome(t, map[string][]string{
		"sessions/enc-cwd/" + sessionID + "/updates.jsonl": {
			marshalJSON(map[string]any{
				"method": usageMethod,
				"params": map[string]any{"update": map[string]any{"sessionUpdate": "turn_completed", "usage": counters(nil)}},
			}),
			marshalJSON(map[string]any{
				"method": usageMethod, "timestamp": eventSeconds,
				"params": map[string]any{"update": map[string]any{"sessionUpdate": "turn_completed"}},
			}),
			"not-json",
			"",
		},
	})

	snapshots := mustCollect(t, home, nil)
	if len(snapshots) != 0 {
		t.Errorf("snapshots = %+v, want none", snapshots)
	}
}

func TestReadsBothLiveAndArchivedRoots(t *testing.T) {
	home := grokHome(t, map[string][]string{
		"sessions/enc-cwd/" + sessionID + "/updates.jsonl": {
			turnEvent(map[string]any{"modelUsage": map[string]any{
				"grok-4.5": counters(map[string]any{"inputTokens": 1000, "cachedReadTokens": 0, "outputTokens": 1}),
			}}, eventSeconds),
		},
		"archived_sessions/enc-cwd/older-session/updates.jsonl": {
			turnEvent(map[string]any{"modelUsage": map[string]any{
				"grok-4.5": counters(map[string]any{"inputTokens": 2000, "cachedReadTokens": 0, "outputTokens": 2}),
			}}, eventSeconds),
		},
	})

	snapshot := mustCollect(t, home, nil)[0]
	if snapshot.InputTokens != 3000 || snapshot.SessionCount != 2 {
		t.Errorf("snapshot = %+v", snapshot)
	}
}

func TestAcceptsMillisecondAndISOTimestamps(t *testing.T) {
	home := grokHome(t, map[string][]string{
		"sessions/a/" + sessionID + "/updates.jsonl": {
			turnEvent(map[string]any{"modelUsage": map[string]any{
				"m": counters(map[string]any{"cachedReadTokens": 0}),
			}}, 1_785_173_400_000), // 2026-07-27T17:30:00.000Z
		},
		"sessions/b/other/updates.jsonl": {
			marshalJSON(map[string]any{
				"method": usageMethod, "timestamp": "2026-07-27T17:30:00.000Z",
				"params": map[string]any{"update": map[string]any{
					"sessionUpdate": "turn_completed",
					"usage":         map[string]any{"modelUsage": map[string]any{"m": counters(map[string]any{"cachedReadTokens": 0})}},
				}},
			}),
		},
	})

	snapshots := mustCollect(t, home, nil)
	if len(snapshots) != 1 || snapshots[0].UsageDate != "2026-07-28" {
		t.Fatalf("snapshots = %+v", snapshots)
	}
	if snapshots[0].SessionCount != 2 {
		t.Errorf("sessionCount = %d, want 2", snapshots[0].SessionCount)
	}
}

func TestAppliesSinceWindowAndRejectsInvalidValue(t *testing.T) {
	home := grokHome(t, map[string][]string{
		"sessions/enc-cwd/" + sessionID + "/updates.jsonl": {
			turnEvent(map[string]any{"modelUsage": map[string]any{
				"m": counters(map[string]any{"cachedReadTokens": 0}),
			}}, 1_784_512_800_000), // 2026-07-20T02:00:00Z
			turnEvent(map[string]any{"modelUsage": map[string]any{
				"m": counters(map[string]any{"cachedReadTokens": 0}),
			}}, 1_785_117_600_000), // 2026-07-27T02:00:00Z
		},
	})

	if got := mustCollect(t, home, func(o *Options) { o.Since = "2026-07-25" }); len(got) != 1 {
		t.Errorf("dashed since = %d snapshots, want 1", len(got))
	}
	if got := mustCollect(t, home, func(o *Options) { o.Since = "20260725" }); len(got) != 1 {
		t.Errorf("compact since = %d snapshots, want 1", len(got))
	}
	if got := mustCollect(t, home, func(o *Options) { o.Since = "all" }); len(got) != 2 {
		t.Errorf("since all = %d snapshots, want 2", len(got))
	}
	_, err := runCollect(t, home, func(o *Options) { o.Since = "yesterday" })
	if err == nil || !strings.Contains(err.Error(), "Invalid Grok Build since value") {
		t.Errorf("invalid since error = %v", err)
	}
}

func TestReportsNoSessionsInsteadOfEmptyUsage(t *testing.T) {
	_, err := runCollect(t, t.TempDir(), nil)
	if err == nil || !strings.Contains(err.Error(), "No Grok Build sessions found") {
		t.Errorf("error = %v", err)
	}
}

func TestDoesNotFollowSymlinkedSessionDirectories(t *testing.T) {
	home := grokHome(t, map[string][]string{
		"sessions/real/" + sessionID + "/updates.jsonl": {
			turnEvent(map[string]any{"modelUsage": map[string]any{
				"m": counters(map[string]any{"cachedReadTokens": 0}),
			}}, eventSeconds),
		},
	})
	// A cycle back to the root would recurse forever if links were followed.
	if err := os.Symlink(filepath.Join(home, "sessions"), filepath.Join(home, "sessions", "loop")); err != nil {
		t.Skip("directory symlinks unavailable")
	}
	var skipped []string
	snapshots, err := runCollect(t, home, func(options *Options) {
		options.Stderr = func(line string) { skipped = append(skipped, line) }
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 1 {
		t.Fatalf("snapshots = %d, want 1", len(snapshots))
	}
	if !strings.Contains(strings.Join(skipped, "\n"), "(symlink)") {
		t.Errorf("skipped = %q", skipped)
	}
}
