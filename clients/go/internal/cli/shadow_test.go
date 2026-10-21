package cli

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// shadowSnapshot is the snapshot the stubbed provider and the stubbed TS
// runner both report unless a test changes one field.
func shadowSnapshot() contract.Snapshot {
	return contract.Snapshot{
		Source:       contract.SourceGrokBuild,
		UsageDate:    "2026-07-31",
		Timezone:     "UTC",
		Model:        "grok-4.5",
		InputTokens:  1000,
		OutputTokens: 10,
		TotalTokens:  1010,
		CostUSD:      0,
		SessionCount: 1,
		CollectedAt:  "2026-07-31T12:00:00Z",
	}
}

// stubShadowTS replaces the TypeScript side of the shadow run.
func stubShadowTS(t *testing.T, snapshots []contract.Snapshot, err error) *int {
	t.Helper()
	calls := 0
	previous := runShadowTS
	runShadowTS = func(context.Context, shadowTSInput) ([]contract.Snapshot, error) {
		calls++
		return snapshots, err
	}
	t.Cleanup(func() { runShadowTS = previous })
	return &calls
}

// shadowEnv is the environment a shadow run needs: a stub provider for the
// source and a repo directory that exists (the TS side is stubbed).
func shadowEnv(t *testing.T) (map[string]string, string) {
	t.Helper()
	repoDir := t.TempDir()
	srcDir := filepath.Join(repoDir, "packages", "collector", "src")
	if err := os.MkdirAll(srcDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(srcDir, "cli.ts"), []byte("// fixture\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	stubSource(t, contract.SourceGrokBuild, stubProvider{snapshots: []contract.Snapshot{shadowSnapshot()}})
	return map[string]string{
		"TOKENBOARD_TIMEZONE":      "UTC",
		"TOKENBOARD_COLLECTOR_DIR": repoDir,
	}, repoDir
}

func runShadowCLI(t *testing.T, env map[string]string, args ...string) (int, string, string) {
	t.Helper()
	if _, ok := env["TOKENBOARD_STATE_DIR"]; !ok {
		env["TOKENBOARD_STATE_DIR"] = t.TempDir()
	}
	return run(t, env, args...)
}

func TestShadowReportsAMatchAndExitsZero(t *testing.T) {
	env, _ := shadowEnv(t)
	// The TS side reports the same snapshot with a different collectedAt:
	// that field is wall clock, not semantics, and must not fail the diff.
	tsSnapshot := shadowSnapshot()
	tsSnapshot.CollectedAt = "2026-07-31T23:59:59Z"
	stubShadowTS(t, []contract.Snapshot{tsSnapshot}, nil)

	code, stdout, stderr := runShadowCLI(t, env, "shadow", "--source", "grok-build")
	if code != ExitOK {
		t.Fatalf("code = %d, stderr = %s", code, stderr)
	}
	var report shadowReport
	if err := json.Unmarshal([]byte(stdout), &report); err != nil {
		t.Fatalf("decode %q: %v", stdout, err)
	}
	if report.Status != "match" || report.Snapshots != 1 {
		t.Errorf("report = %+v, want a one-snapshot match", report)
	}
}

func TestShadowReportsAFieldDifferenceAndExitsOne(t *testing.T) {
	env, _ := shadowEnv(t)
	tsSnapshot := shadowSnapshot()
	tsSnapshot.InputTokens = 999
	stubShadowTS(t, []contract.Snapshot{tsSnapshot}, nil)

	code, stdout, stderr := runShadowCLI(t, env, "shadow", "--source", "grok-build")
	if code != ExitFailure {
		t.Fatalf("code = %d, want %d; stderr = %s", code, ExitFailure, stderr)
	}
	var report shadowReport
	if err := json.Unmarshal([]byte(stdout), &report); err != nil {
		t.Fatalf("decode %q: %v", stdout, err)
	}
	if report.Status != "diff" || len(report.Differing) != 1 {
		t.Fatalf("report = %+v, want one differing snapshot", report)
	}
	difference := report.Differing[0]
	if difference.Key.Model != "grok-4.5" {
		t.Errorf("key = %+v", difference.Key)
	}
	if len(difference.Fields) != 1 || difference.Fields[0].Field != "inputTokens" {
		t.Fatalf("fields = %+v, want only inputTokens", difference.Fields)
	}
	if difference.Fields[0].TS != float64(999) || difference.Fields[0].Go != float64(1000) {
		t.Errorf("field = %+v, want ts=999 go=1000", difference.Fields[0])
	}
}

func TestShadowReportsSnapshotsOnlyOneSideCollected(t *testing.T) {
	env, _ := shadowEnv(t)
	extra := shadowSnapshot()
	extra.Model = "grok-4.6"
	stubShadowTS(t, []contract.Snapshot{extra}, nil)

	code, stdout, stderr := runShadowCLI(t, env, "shadow", "--source", "grok-build")
	if code != ExitFailure {
		t.Fatalf("code = %d, stderr = %s", code, stderr)
	}
	var report shadowReport
	if err := json.Unmarshal([]byte(stdout), &report); err != nil {
		t.Fatalf("decode %q: %v", stdout, err)
	}
	if len(report.OnlyInTS) != 1 || report.OnlyInTS[0].Model != "grok-4.6" {
		t.Errorf("onlyInTs = %+v", report.OnlyInTS)
	}
	if len(report.OnlyInGo) != 1 || report.OnlyInGo[0].Model != "grok-4.5" {
		t.Errorf("onlyInGo = %+v", report.OnlyInGo)
	}
}

// The diff is order-insensitive: both sides sort by the snapshot key before
// comparing, so a provider that emits rows in a different order is still a
// match.
func TestShadowComparesInKeyOrder(t *testing.T) {
	env, _ := shadowEnv(t)
	second := shadowSnapshot()
	second.UsageDate = "2026-07-30"
	second.Model = "grok-4.5-mini"
	stubSource(t, contract.SourceGrokBuild, stubProvider{
		snapshots: []contract.Snapshot{shadowSnapshot(), second},
	})
	stubShadowTS(t, []contract.Snapshot{second, shadowSnapshot()}, nil)

	code, stdout, stderr := runShadowCLI(t, env, "shadow", "--source", "grok-build")
	if code != ExitOK {
		t.Fatalf("code = %d, stderr = %s; stdout = %s", code, stderr, stdout)
	}
}

func TestShadowRequiresACollectorDirectory(t *testing.T) {
	stubSource(t, contract.SourceGrokBuild, stubProvider{})
	code, _, stderr := runShadowCLI(t, map[string]string{
		"TOKENBOARD_TIMEZONE": "UTC",
	}, "shadow", "--source", "grok-build")
	if code != ExitUsage || !strings.Contains(stderr, "collector") {
		t.Errorf("code = %d, stderr = %q; want a usage error naming the collector directory", code, stderr)
	}
}

func TestShadowReportsAFailedTSSide(t *testing.T) {
	env, _ := shadowEnv(t)
	stubShadowTS(t, nil, os.ErrNotExist)

	code, _, stderr := runShadowCLI(t, env, "shadow", "--source", "grok-build")
	if code != ExitFailure || !strings.Contains(stderr, "TypeScript") {
		t.Errorf("code = %d, stderr = %q; want the TS failure named", code, stderr)
	}
}

func TestShadowRejectsAnInvalidSource(t *testing.T) {
	env, _ := shadowEnv(t)
	code, _, stderr := runShadowCLI(t, env, "shadow", "--source", "nonsense")
	if code != ExitUsage || !strings.Contains(stderr, "Invalid source") {
		t.Errorf("code = %d, stderr = %q", code, stderr)
	}
}

// The shadow run must not read or write the real state directory: both sides
// get their own temporary one, so cursors and locks stay untouched.
func TestShadowIsolatesTheStateDirectory(t *testing.T) {
	env, _ := shadowEnv(t)
	realState := t.TempDir()
	env["TOKENBOARD_STATE_DIR"] = realState
	var tsState string
	previous := runShadowTS
	runShadowTS = func(_ context.Context, input shadowTSInput) ([]contract.Snapshot, error) {
		tsState = input.StateDir
		return []contract.Snapshot{shadowSnapshot()}, nil
	}
	t.Cleanup(func() { runShadowTS = previous })

	code, _, stderr := runShadowCLI(t, env, "shadow", "--source", "grok-build")
	if code != ExitOK {
		t.Fatalf("code = %d, stderr = %s", code, stderr)
	}
	if tsState == "" || tsState == realState {
		t.Errorf("TS state dir = %q, want an isolated directory distinct from %q", tsState, realState)
	}
	entries, err := os.ReadDir(realState)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Errorf("real state dir gained %d entries", len(entries))
	}
}

// A shadow run started from a hook environment (TOKENBOARD_HOOK_MODE=1) must
// still compare full preview semantics: the Go side collects every source,
// matching the TS child whose environment strips hook mode.
func TestShadowIgnoresInheritedHookMode(t *testing.T) {
	env, _ := shadowEnv(t)
	env["TOKENBOARD_HOOK_MODE"] = "1"
	stubShadowTS(t, []contract.Snapshot{shadowSnapshot()}, nil)

	code, stdout, stderr := runShadowCLI(t, env, "shadow", "--source", "grok-build")
	if code != ExitOK {
		t.Fatalf("code = %d, stderr = %s; stdout = %s", code, stderr, stdout)
	}
}
