package cli

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect"
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

// The dual run compares full preview semantics, and the hook path is a
// different code path: incremental cursor scan, narrow ccusage window,
// reconciliation assertions. Production uses that path, so a shadow gate that
// only compares previews leaves it unverified. `shadow --hook` compares the
// hook path on both sides instead, over an isolated state dir so a fresh
// cursor makes the hook scan cover the whole tree.
func TestShadowCanCompareTheHookPath(t *testing.T) {
	repoDir := t.TempDir()
	srcDir := filepath.Join(repoDir, "packages", "collector", "src")
	if err := os.MkdirAll(srcDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(srcDir, "cli.ts"), []byte("// fixture\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	stubSource(t, contract.SourceClaudeCode, stubProvider{snapshots: []contract.Snapshot{shadowSnapshot()}})

	var seenHookMode bool
	previous := runShadowTS
	runShadowTS = func(_ context.Context, input shadowTSInput) ([]contract.Snapshot, error) {
		seenHookMode = input.HookMode
		return []contract.Snapshot{shadowSnapshot()}, nil
	}
	t.Cleanup(func() { runShadowTS = previous })

	code, stdout, stderr := runShadowCLI(t, map[string]string{
		"TOKENBOARD_TIMEZONE":      "UTC",
		"TOKENBOARD_COLLECTOR_DIR": repoDir,
	}, "shadow", "--source", "claude-code", "--hook")
	if code != ExitOK {
		t.Fatalf("code = %d, stderr = %s; stdout = %s", code, stderr, stdout)
	}
	if !seenHookMode {
		t.Error("the TypeScript side must run in hook mode too, or the two sides compare different paths")
	}
}

// hookModeProbe answers like stubProvider but records what the provider was
// told about hook mode, which is how the Go side actually decides between the
// hook and preview paths.
type hookModeProbe struct {
	snapshots []contract.Snapshot
	seen      string
}

func (p *hookModeProbe) Collect(_ context.Context, options collect.Options) ([]contract.Snapshot, error) {
	if options.Env != nil {
		p.seen = options.Env("TOKENBOARD_HOOK_MODE")
	}
	return p.snapshots, nil
}

// --hook must reach the Go provider, not just the TypeScript child. The
// providers branch on TOKENBOARD_HOOK_MODE themselves, so a flag that only
// sets Options.HookMode would leave the Go side collecting the full preview
// while the TS child runs the hook path — a comparison of two different code
// paths, reported as if it were an implementation difference.
func TestShadowHookModeReachesTheGoProvider(t *testing.T) {
	repoDir := t.TempDir()
	srcDir := filepath.Join(repoDir, "packages", "collector", "src")
	if err := os.MkdirAll(srcDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(srcDir, "cli.ts"), []byte("// fixture\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	probe := &hookModeProbe{snapshots: []contract.Snapshot{shadowSnapshot()}}
	stubSource(t, contract.SourceClaudeCode, probe)
	stubShadowTS(t, []contract.Snapshot{shadowSnapshot()}, nil)

	code, stdout, stderr := runShadowCLI(t, map[string]string{
		"TOKENBOARD_TIMEZONE":      "UTC",
		"TOKENBOARD_COLLECTOR_DIR": repoDir,
	}, "shadow", "--source", "claude-code", "--hook")
	if code != ExitOK {
		t.Fatalf("code = %d, stderr = %s; stdout = %s", code, stderr, stdout)
	}
	if probe.seen != "1" {
		t.Errorf("provider saw TOKENBOARD_HOOK_MODE = %q, want \"1\"", probe.seen)
	}
}

// The same wiring must strip an ambient hook mode when --hook was not given:
// a shadow started from a notifier's environment still compares previews, and
// the provider must not see the notifier's flag.
func TestShadowStripsAmbientHookModeFromTheGoProvider(t *testing.T) {
	repoDir := t.TempDir()
	srcDir := filepath.Join(repoDir, "packages", "collector", "src")
	if err := os.MkdirAll(srcDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(srcDir, "cli.ts"), []byte("// fixture\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	probe := &hookModeProbe{snapshots: []contract.Snapshot{shadowSnapshot()}}
	stubSource(t, contract.SourceClaudeCode, probe)
	stubShadowTS(t, []contract.Snapshot{shadowSnapshot()}, nil)

	code, stdout, stderr := runShadowCLI(t, map[string]string{
		"TOKENBOARD_TIMEZONE":      "UTC",
		"TOKENBOARD_COLLECTOR_DIR": repoDir,
		"TOKENBOARD_HOOK_MODE":     "1",
	}, "shadow", "--source", "claude-code")
	if code != ExitOK {
		t.Fatalf("code = %d, stderr = %s; stdout = %s", code, stderr, stdout)
	}
	if probe.seen != "" {
		t.Errorf("provider saw TOKENBOARD_HOOK_MODE = %q, want it stripped without --hook", probe.seen)
	}
}

// Without --hook the comparison stays a full preview on both sides, and an
// inherited TOKENBOARD_HOOK_MODE must not flip it.
func TestShadowDefaultsToPreviewEvenWithHookModeSet(t *testing.T) {
	env, _ := shadowEnv(t)
	env["TOKENBOARD_HOOK_MODE"] = "1"
	var seenHookMode bool
	previous := runShadowTS
	runShadowTS = func(_ context.Context, input shadowTSInput) ([]contract.Snapshot, error) {
		seenHookMode = input.HookMode
		return []contract.Snapshot{shadowSnapshot()}, nil
	}
	t.Cleanup(func() { runShadowTS = previous })

	code, stdout, stderr := runShadowCLI(t, env, "shadow", "--source", "grok-build")
	if code != ExitOK {
		t.Fatalf("code = %d, stderr = %s; stdout = %s", code, stderr, stdout)
	}
	if seenHookMode {
		t.Error("hook mode must come from the flag, not from the ambient environment")
	}
}

// Both clients reject --until in hook mode, because the hook window comes
// from the changed cursor dates rather than a flag. Shadow must refuse the
// combination before it starts a long collection, not halfway through when the
// TypeScript child reports a usage error.
func TestShadowRejectsUntilInHookMode(t *testing.T) {
	env, _ := shadowEnv(t)
	stubSource(t, contract.SourceClaudeCode, stubProvider{snapshots: []contract.Snapshot{shadowSnapshot()}})
	calls := stubShadowTS(t, []contract.Snapshot{shadowSnapshot()}, nil)
	code, _, stderr := runShadowCLI(t, env, "shadow", "--source", "claude-code", "--hook", "--until", "2026-07-30")
	if code != ExitUsage || !strings.Contains(stderr, "--until") {
		t.Errorf("code = %d, stderr = %q; want a usage error naming --until", code, stderr)
	}
	if *calls != 0 {
		t.Errorf("TS side ran %d times; a rejected invocation must not collect", *calls)
	}
}

// An ambient TOKENBOARD_UNTIL is ignored in hook mode, the way the TypeScript
// client ignores it: the hook window is computed from the cursors, so an
// inherited variable is not a contradiction and must not fail the run. Only an
// explicitly typed --until is a usage error.
func TestShadowIgnoresAmbientUntilInHookMode(t *testing.T) {
	env, _ := shadowEnv(t)
	stubSource(t, contract.SourceClaudeCode, stubProvider{snapshots: []contract.Snapshot{shadowSnapshot()}})
	stubShadowTS(t, []contract.Snapshot{shadowSnapshot()}, nil)
	env["TOKENBOARD_UNTIL"] = "2026-07-30"

	code, stdout, stderr := runShadowCLI(t, env, "shadow", "--source", "claude-code", "--hook")
	if code != ExitOK {
		t.Fatalf("code = %d, stderr = %s; stdout = %s", code, stderr, stdout)
	}
}
