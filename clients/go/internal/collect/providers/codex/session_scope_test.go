package codex

// Port of the five TS Codex session scope suites:
// codex-session-scope.test.ts, codex-session-scope-bounds.test.ts,
// codex-session-scope-race.test.ts, codex-session-scope-root-race.test.ts and
// codex-session-scope-explicit-batches.test.ts.
//
// The TS suites mock module exports (vi.doMock) and node:fs; the Go port
// injects the same seams through SessionScopeOptions and the two package
// variables scopeRootLstat / scopeResolveSessionFiles, so the assertions are
// about the same observable behavior: which files a scope contains, which
// diagnostics fire, and which failures surface.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessionwalk"
)

// --- createCodexSessionScope ---------------------------------------------

func TestCreateCodexSessionScopeReturnsNilWhenNoDateFilterIsConfigured(t *testing.T) {
	scope, err := CreateCodexSessionScope(SessionScopeOptions{CodexHomes: []string{t.TempDir()}})
	if err != nil {
		t.Fatal(err)
	}
	if scope != nil {
		t.Fatalf("scope = %+v, want nil", scope)
	}
}

func TestCreateCodexSessionScopeDefaultsToTheHomeCodexDirectory(t *testing.T) {
	root := t.TempDir()
	fakeHome := filepath.Join(root, "home")
	fakeCwd := filepath.Join(root, "cwd")
	writeScopeJSONL(t, filepath.Join(fakeHome, ".codex", "sessions", "2026", "05", "home.jsonl"),
		[]any{scopeTokenCountEvent("2026-05-09T04:24:07.234Z")})
	writeScopeJSONL(t, filepath.Join(fakeCwd, ".codex", "sessions", "2026", "05", "cwd.jsonl"),
		[]any{scopeTokenCountEvent("2026-05-09T04:24:07.234Z")})

	scope, err := CreateCodexSessionScope(SessionScopeOptions{
		Since:   "all",
		HomeDir: fakeHome,
		Env:     func(string) string { return "" },
	})
	if err != nil {
		t.Fatal(err)
	}
	if scope == nil {
		t.Fatal("scope = nil, want the default home's sessions")
	}
	defer scope.Cleanup()
	content, err := os.ReadFile(filepath.Join(scope.CodexHome, "sessions", "2026", "05", "home.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(content), "token_count") {
		t.Errorf("copied home session = %q", content)
	}
	if scopeFileExists(filepath.Join(scope.CodexHome, "sessions", "2026", "05", "cwd.jsonl")) {
		t.Error("the working directory's .codex must not be read")
	}
}

func TestCreateCodexSessionScopePreservesACommaInAnExplicitHomeArray(t *testing.T) {
	root := t.TempDir()
	codexHome := filepath.Join(root, "profile,primary")
	sessionFile := filepath.Join(codexHome, "sessions", "2026", "05", "09", "session.jsonl")
	writeScopeJSONL(t, sessionFile, []any{scopeTokenCountEvent("2026-05-09T04:24:07.234Z")})

	scope, err := CreateCodexSessionScope(SessionScopeOptions{
		CodexHomes: []string{codexHome},
		Since:      "all",
		Env:        func(string) string { return "" },
	})
	if err != nil {
		t.Fatal(err)
	}
	if scope == nil {
		t.Fatal("scope = nil")
	}
	defer scope.Cleanup()
	if len(scope.CodexHomes) != 1 {
		t.Fatalf("codex homes = %v", scope.CodexHomes)
	}
	content, err := os.ReadFile(filepath.Join(scope.CodexHome, "sessions", "2026", "05", "09", "session.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(content), "token_count") {
		t.Errorf("copied session = %q", content)
	}
}

func TestCreateCodexSessionScopeRejectsAnAmbiguousLegacyCommaHome(t *testing.T) {
	root := t.TempDir()
	codexHome := filepath.Join(root, "profile,primary")
	if err := os.MkdirAll(codexHome, 0o755); err != nil {
		t.Fatal(err)
	}
	_, err := CreateCodexSessionScope(SessionScopeOptions{
		CodexHome: &codexHome,
		Since:     "all",
		Env:       func(string) string { return "" },
	})
	if err == nil || !strings.Contains(err.Error(), "CODEX_HOME is ambiguous because the configured path contains a comma") {
		t.Fatalf("error = %v", err)
	}
}

func TestCreateCodexSessionScopeCleansUpWhenTmpdirContainsAComma(t *testing.T) {
	codexHome := t.TempDir()
	tempRoot := t.TempDir()
	commaTmpdir := filepath.Join(tempRoot, "temporary,scope")
	if err := os.Mkdir(commaTmpdir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeScopeJSONL(t, filepath.Join(codexHome, "sessions", "2026", "05", "09", "session.jsonl"),
		[]any{scopeTokenCountEvent("2026-05-09T04:24:07.234Z")})
	// os.MkdirTemp("") reads the platform's temp variable: TMPDIR on POSIX,
	// TMP/TEMP on Windows. Set all three so the fixture reaches the product on
	// either platform.
	t.Setenv("TMPDIR", commaTmpdir)
	t.Setenv("TMP", commaTmpdir)
	t.Setenv("TEMP", commaTmpdir)

	_, err := CreateCodexSessionScope(SessionScopeOptions{
		CodexHome: &codexHome,
		Since:     "all",
		Env:       func(string) string { return "" },
	})
	if err == nil || !strings.Contains(err.Error(), "Temporary Codex session scope path contains a comma") {
		t.Fatalf("error = %v", err)
	}
	if entries := listScopeTempDirs(t, commaTmpdir); len(entries) != 0 {
		t.Errorf("leftover scope directories = %v", entries)
	}
}

func TestCreateCodexSessionScopeReadsCommaHomesFromTheJSONEnvironment(t *testing.T) {
	root := t.TempDir()
	codexHome := filepath.Join(root, "profile,primary")
	ignoredLegacyHome := filepath.Join(root, "legacy")
	writeScopeJSONL(t, filepath.Join(codexHome, "sessions", "2026", "05", "09", "session.jsonl"),
		[]any{scopeTokenCountEvent("2026-05-09T04:24:07.234Z")})
	t.Setenv("CODEX_HOME", ignoredLegacyHome)
	encoded, err := json.Marshal([]string{codexHome})
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("TOKENBOARD_CODEX_HOMES_JSON", string(encoded))

	scope, err := CreateCodexSessionScope(SessionScopeOptions{Since: "all"})
	if err != nil {
		t.Fatal(err)
	}
	if scope == nil {
		t.Fatal("scope = nil")
	}
	defer scope.Cleanup()
	if len(scope.CodexHomes) != 1 {
		t.Fatalf("codex homes = %v", scope.CodexHomes)
	}
	content, err := os.ReadFile(filepath.Join(scope.CodexHome, "sessions", "2026", "05", "09", "session.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(content), "token_count") {
		t.Errorf("copied session = %q", content)
	}
}

func TestCreateCodexSessionScopeSelectsSessionsByTokenCountTimestamp(t *testing.T) {
	codexHome := t.TempDir()
	active := filepath.Join(codexHome, "sessions", "2026", "03", "25", "still-active.jsonl")
	inactive := filepath.Join(codexHome, "sessions", "2026", "03", "20", "inactive.jsonl")
	writeScopeJSONL(t, active, []any{scopeTokenCountEvent("2026-05-09T04:24:07.234Z")})
	writeScopeJSONL(t, inactive, []any{scopeTokenCountEvent("2026-03-20T04:24:07.234Z")})
	setScopeModTime(t, inactive, "2026-03-20T04:24:07.234Z")

	scope, err := CreateCodexSessionScope(SessionScopeOptions{CodexHome: &codexHome, Since: "20260508"})
	if err != nil {
		t.Fatal(err)
	}
	if scope == nil {
		t.Fatal("scope = nil")
	}
	defer scope.Cleanup()
	if !scopeFileExists(filepath.Join(scope.CodexHome, "sessions", "2026", "03", "25", "still-active.jsonl")) {
		t.Error("the token_count-active session must be copied")
	}
	if scopeFileExists(filepath.Join(scope.CodexHome, "sessions", "2026", "03", "20", "inactive.jsonl")) {
		t.Error("the inactive session must be skipped")
	}
}

func TestCreateCodexSessionScopeKeepsThePreviousUTCDayCandidate(t *testing.T) {
	codexHome := t.TempDir()
	edgeFile := filepath.Join(codexHome, "sessions", "2026", "07", "07", "positive-offset-edge.jsonl")
	writeScopeJSONL(t, edgeFile, []any{scopeTokenCountEvent("2026-07-07T16:30:00.000Z")})
	setScopeModTime(t, edgeFile, "2026-07-01T00:00:00.000Z")

	scope, err := CreateCodexSessionScope(SessionScopeOptions{CodexHome: &codexHome, Since: "20260708"})
	if err != nil {
		t.Fatal(err)
	}
	if scope == nil {
		t.Fatal("scope = nil")
	}
	defer scope.Cleanup()
	if !scopeFileExists(filepath.Join(scope.CodexHome, "sessions", "2026", "07", "07", "positive-offset-edge.jsonl")) {
		t.Error("the previous UTC-day candidate must be kept for positive-timezone filtering")
	}
}

func TestCreateCodexSessionScopeFallsBackToFileMtime(t *testing.T) {
	codexHome := t.TempDir()
	activeFile := filepath.Join(codexHome, "sessions", "2026", "03", "25", "mtime-active.jsonl")
	inactiveFile := filepath.Join(codexHome, "sessions", "2026", "03", "25", "mtime-inactive.jsonl")
	noTimestamp := map[string]any{"type": "event_msg", "payload": map[string]any{"type": "token_count"}}
	writeScopeJSONL(t, activeFile, []any{noTimestamp})
	writeScopeJSONL(t, inactiveFile, []any{noTimestamp})
	setScopeModTime(t, activeFile, "2026-05-09T04:24:07.234Z")
	setScopeModTime(t, inactiveFile, "2026-03-20T04:24:07.234Z")

	scope, err := CreateCodexSessionScope(SessionScopeOptions{CodexHome: &codexHome, Since: "20260508"})
	if err != nil {
		t.Fatal(err)
	}
	if scope == nil {
		t.Fatal("scope = nil")
	}
	defer scope.Cleanup()
	if !scopeFileExists(filepath.Join(scope.CodexHome, "sessions", "2026", "03", "25", "mtime-active.jsonl")) {
		t.Error("the mtime-active session must be copied")
	}
	if scopeFileExists(filepath.Join(scope.CodexHome, "sessions", "2026", "03", "25", "mtime-inactive.jsonl")) {
		t.Error("the mtime-inactive session must be skipped")
	}
}

func TestCreateCodexSessionScopeKeepsTheNextUTCDayCandidate(t *testing.T) {
	codexHome := t.TempDir()
	writeScopeJSONL(t, filepath.Join(codexHome, "sessions", "2026", "05", "09", "included.jsonl"),
		[]any{scopeTokenCountEvent("2026-05-09T23:59:59.999Z")})
	writeScopeJSONL(t, filepath.Join(codexHome, "sessions", "2026", "05", "10", "negative-offset-edge.jsonl"),
		[]any{scopeTokenCountEvent("2026-05-10T07:30:00.000Z")})
	writeScopeJSONL(t, filepath.Join(codexHome, "sessions", "2026", "05", "11", "excluded.jsonl"),
		[]any{scopeTokenCountEvent("2026-05-11T00:00:00.000Z")})

	scope, err := CreateCodexSessionScope(SessionScopeOptions{CodexHome: &codexHome, Until: "20260509"})
	if err != nil {
		t.Fatal(err)
	}
	if scope == nil {
		t.Fatal("scope = nil")
	}
	defer scope.Cleanup()
	for _, relative := range []string{
		filepath.Join("sessions", "2026", "05", "09", "included.jsonl"),
		filepath.Join("sessions", "2026", "05", "10", "negative-offset-edge.jsonl"),
	} {
		if !scopeFileExists(filepath.Join(scope.CodexHome, relative)) {
			t.Errorf("%s must be copied", relative)
		}
	}
	if scopeFileExists(filepath.Join(scope.CodexHome, "sessions", "2026", "05", "11", "excluded.jsonl")) {
		t.Error("the next-next UTC-day session must be skipped")
	}
}

func TestCreateCodexSessionScopeRejectsInvalidDateFilters(t *testing.T) {
	for _, since := range []string{"2026/05/09", "2026--05-09", "20260230"} {
		t.Run(since, func(t *testing.T) {
			codexHome := t.TempDir()
			_, err := CreateCodexSessionScope(SessionScopeOptions{CodexHome: &codexHome, Since: since})
			if err == nil || !strings.Contains(err.Error(), "Invalid Codex usage date filter") {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestCreateCodexSessionScopeBatchesStreamFullScansInBounds(t *testing.T) {
	codexHome := t.TempDir()
	for index, relative := range []string{
		filepath.Join("2026", "03", "20", "first.jsonl"),
		filepath.Join("2026", "04", "20", "second.jsonl"),
		filepath.Join("2026", "05", "09", "third.jsonl"),
	} {
		writeScopeJSONL(t, filepath.Join(codexHome, "sessions", relative),
			[]any{scopeTokenCountEvent(fmt.Sprintf("2026-0%d-20T04:24:07.234Z", index+3))})
	}

	type batchSummary struct {
		first  bool
		second bool
		third  bool
	}
	batches := []batchSummary{}
	err := CreateCodexSessionScopeBatches(
		SessionScopeOptions{CodexHome: &codexHome, Since: "all", BatchSize: 2},
		func(scope *SessionScope) error {
			summary := batchSummary{
				first:  scopeFileExists(filepath.Join(scope.CodexHome, "sessions", "2026", "03", "20", "first.jsonl")),
				second: scopeFileExists(filepath.Join(scope.CodexHome, "sessions", "2026", "04", "20", "second.jsonl")),
				third:  scopeFileExists(filepath.Join(scope.CodexHome, "sessions", "2026", "05", "09", "third.jsonl")),
			}
			batches = append(batches, summary)
			return scope.Cleanup()
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(batches) != 2 {
		t.Fatalf("batches = %d, want 2", len(batches))
	}
	total := 0
	for _, batch := range batches {
		count := 0
		for _, present := range []bool{batch.first, batch.second, batch.third} {
			if present {
				count++
			}
		}
		if count > 2 {
			t.Errorf("batch holds %d files, want at most 2", count)
		}
		total += count
	}
	if total != 3 {
		t.Errorf("copied files = %d, want 3", total)
	}
}

func TestCreateCodexSessionScopeBatchesGroupPathsAcrossProfiles(t *testing.T) {
	root := t.TempDir()
	firstHome := filepath.Join(root, "first")
	secondHome := filepath.Join(root, "second")
	firstSibling := filepath.Join(firstHome, "sessions", "a.jsonl")
	secondSibling := filepath.Join(secondHome, "sessions", "a.jsonl")
	firstNested := filepath.Join(firstHome, "sessions", "a", "nested.jsonl")
	for _, file := range []string{firstSibling, secondSibling, firstNested} {
		writeScopeJSONL(t, file, []any{scopeTokenCountEvent("2026-05-09T04:24:07.234Z")})
	}

	batches := [][]string{}
	err := CreateCodexSessionScopeBatches(
		SessionScopeOptions{CodexHomes: []string{firstHome, secondHome}, Since: "all", BatchSize: 1},
		func(scope *SessionScope) error {
			values := make([]string, 0, len(scope.SourceFiles))
			for _, source := range scope.SourceFiles {
				values = append(values, source)
			}
			sort.Strings(values)
			batches = append(batches, values)
			return scope.Cleanup()
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	wantSiblings := []string{firstSibling, secondSibling}
	sort.Strings(wantSiblings)
	want := [][]string{wantSiblings, {firstNested}}
	if len(batches) != len(want) {
		t.Fatalf("batches = %v, want %v", batches, want)
	}
	for index := range want {
		if len(batches[index]) != len(want[index]) {
			t.Fatalf("batch %d = %v, want %v", index, batches[index], want[index])
		}
		for item := range want[index] {
			if batches[index][item] != want[index][item] {
				t.Fatalf("batch %d = %v, want %v", index, batches[index], want[index])
			}
		}
	}
}

func TestCreateCodexSessionScopeCombinesEveryMatchingFile(t *testing.T) {
	codexHome := t.TempDir()
	for index := 0; index < 3; index++ {
		writeScopeJSONL(t, filepath.Join(codexHome, "sessions", "2026", "05", fmt.Sprintf("%d.jsonl", index)),
			[]any{scopeTokenCountEvent("2026-05-09T04:24:07.234Z")})
	}

	scope, err := CreateCodexSessionScope(SessionScopeOptions{CodexHome: &codexHome, Since: "all", BatchSize: 2})
	if err != nil {
		t.Fatal(err)
	}
	if scope == nil {
		t.Fatal("scope = nil")
	}
	defer scope.Cleanup()
	files, ok, err := sessionwalk.Resolve(filepath.Join(scope.CodexHome, "sessions"), sessionwalk.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if !ok || len(files.Paths) != 3 {
		t.Errorf("scoped files = %v, want 3", files.Paths)
	}
}

func TestCreateCodexSessionScopeCopiesAnExplicitArchivedSession(t *testing.T) {
	codexHome := t.TempDir()
	archived := filepath.Join(codexHome, "archived_sessions", "2026", "05", "archived.jsonl")
	writeScopeJSONL(t, archived, []any{scopeTokenCountEvent("2026-05-09T04:24:07.234Z")})

	scope, err := CreateCodexSessionScope(SessionScopeOptions{CodexHome: &codexHome, Files: []string{archived}})
	if err != nil {
		t.Fatal(err)
	}
	if scope == nil {
		t.Fatal("scope = nil")
	}
	defer scope.Cleanup()
	scopedFile := filepath.Join(scope.CodexHome, "archived_sessions", "2026", "05", "archived.jsonl")
	content, err := os.ReadFile(scopedFile)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(content), "token_count") {
		t.Errorf("scoped file = %q", content)
	}
	if scope.SourceFiles[scopedFile] != archived {
		t.Errorf("source mapping = %q, want %q", scope.SourceFiles[scopedFile], archived)
	}
}

func TestCreateCodexSessionScopeIncludesArchiveOnlySessions(t *testing.T) {
	codexHome := t.TempDir()
	archived := filepath.Join(codexHome, "archived_sessions", "2026", "05", "archive-only.jsonl")
	writeScopeJSONL(t, archived, []any{scopeTokenCountEvent("2026-05-09T04:24:07.234Z")})

	scope, err := CreateCodexSessionScope(SessionScopeOptions{CodexHome: &codexHome, Since: "all"})
	if err != nil {
		t.Fatal(err)
	}
	if scope == nil {
		t.Fatal("scope = nil")
	}
	defer scope.Cleanup()
	content, err := os.ReadFile(filepath.Join(scope.CodexHome, "archived_sessions", "2026", "05", "archive-only.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(content), "token_count") {
		t.Errorf("scoped file = %q", content)
	}
}

func TestCreateCodexSessionScopePrefersTheActiveSessionOverTheArchive(t *testing.T) {
	codexHome := t.TempDir()
	active := filepath.Join(codexHome, "sessions", "2026", "05", "shared.jsonl")
	archived := filepath.Join(codexHome, "archived_sessions", "2026", "05", "shared.jsonl")
	writeScopeJSONL(t, active, []any{map[string]any{"source": "active"}})
	writeScopeJSONL(t, archived, []any{map[string]any{"source": "archived"}})

	scope, err := CreateCodexSessionScope(SessionScopeOptions{
		CodexHome: &codexHome,
		Files:     []string{archived, active},
	})
	if err != nil {
		t.Fatal(err)
	}
	if scope == nil {
		t.Fatal("scope = nil")
	}
	defer scope.Cleanup()
	scoped := filepath.Join(scope.CodexHome, "sessions", "2026", "05", "shared.jsonl")
	content, err := os.ReadFile(scoped)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(content), `"source":"active"`) {
		t.Errorf("scoped file = %q, want the active session", content)
	}
	if scope.SourceFiles[scoped] != active {
		t.Errorf("source mapping = %q, want %q", scope.SourceFiles[scoped], active)
	}
}

func TestCreateCodexSessionScopeRejectsFilesOutsideTheSessionDirectories(t *testing.T) {
	codexHome := t.TempDir()
	outside := filepath.Join(codexHome, "outside.jsonl")
	writeScopeJSONL(t, filepath.Join(codexHome, "sessions", "2026", "05", "valid.jsonl"),
		[]any{scopeTokenCountEvent("2026-05-09T04:24:07.234Z")})
	writeScopeJSONL(t, outside, []any{scopeTokenCountEvent("2026-05-09T04:24:07.234Z")})

	_, err := CreateCodexSessionScope(SessionScopeOptions{CodexHome: &codexHome, Files: []string{outside}})
	if err == nil || !strings.Contains(err.Error(), "Invalid Codex session file path for canonical session attribution") {
		t.Fatalf("error = %v", err)
	}
}

func TestCreateCodexSessionScopeCleansUpAFailedBatchCopy(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX permission bits are what makes the copy fail; Windows ACLs ignore mode 0000")
	}
	if os.Geteuid() == 0 {
		t.Skip("root bypasses the 0000 permission bits the test relies on")
	}
	codexHome := t.TempDir()
	sandboxTmpdir := t.TempDir()
	t.Setenv("TMPDIR", sandboxTmpdir)
	brokenFile := filepath.Join(codexHome, "sessions", "2026", "05", "broken.jsonl")
	writeScopeJSONL(t, filepath.Join(codexHome, "sessions", "2026", "05", "ok.jsonl"),
		[]any{scopeTokenCountEvent("2026-05-09T04:24:07.234Z")})
	writeScopeJSONL(t, brokenFile, []any{scopeTokenCountEvent("2026-05-09T04:24:07.234Z")})
	if err := os.Chmod(brokenFile, 0o000); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(brokenFile, 0o600)

	before := listScopeTempDirs(t, sandboxTmpdir)
	err := CreateCodexSessionScopeBatches(
		SessionScopeOptions{CodexHome: &codexHome, Since: "all", BatchSize: 2},
		func(scope *SessionScope) error { return scope.Cleanup() },
	)
	if err == nil {
		t.Fatal("expected the unreadable session to fail the batch")
	}
	after := listScopeTempDirs(t, sandboxTmpdir)
	for _, entry := range after {
		if !containsScopeEntry(before, entry) {
			t.Errorf("leftover scope directory %s", entry)
		}
	}
}

func TestCreateCodexSessionScopeFailsVisiblyWhenACandidateCannotBeRead(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX permission bits are what makes the read fail; Windows ACLs ignore mode 0000")
	}
	if os.Geteuid() == 0 {
		t.Skip("root bypasses the 0000 permission bits the test relies on")
	}
	codexHome := t.TempDir()
	unreadable := filepath.Join(codexHome, "sessions", "2026", "05", "unreadable.jsonl")
	writeScopeJSONL(t, unreadable, []any{scopeTokenCountEvent("2026-05-09T04:24:07.234Z")})
	setScopeModTime(t, unreadable, "2026-03-20T04:24:07.234Z")
	if err := os.Chmod(unreadable, 0o000); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(unreadable, 0o600)

	_, err := CreateCodexSessionScope(SessionScopeOptions{CodexHome: &codexHome, Since: "20260508"})
	if err == nil || !strings.Contains(err.Error(), "Unable to read Codex session file") {
		t.Fatalf("error = %v", err)
	}
}

// --- bounds ---------------------------------------------------------------

func TestWriteFileHandleFullyCompletesPartialWrites(t *testing.T) {
	writer := &scopeLimitedWriter{limit: 2}
	if err := writeFileHandleFully(writer, []byte("{\"type\":\"token_count\"}\n")); err != nil {
		t.Fatal(err)
	}
	if got := writer.buffer.String(); got != "{\"type\":\"token_count\"}\n" {
		t.Errorf("written = %q", got)
	}
}

func TestWriteFileHandleFullyFailsOnAZeroByteWrite(t *testing.T) {
	err := writeFileHandleFully(&scopeLimitedWriter{limit: 0}, []byte("data"))
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "made no valid progress") {
		t.Fatalf("error = %v", err)
	}
}

func TestCreateCodexSessionScopeAllowsAFileAtTheConfiguredLimit(t *testing.T) {
	codexHome := t.TempDir()
	writeScopeSizedFile(t, filepath.Join(codexHome, "sessions", "2026", "07", "limit.jsonl"), 128)

	scope, err := CreateCodexSessionScope(SessionScopeOptions{
		CodexHome:     &codexHome,
		Since:         "all",
		MaxFileBytes:  128,
		MaxBatchBytes: 128,
		MaxGroupBytes: 128,
	})
	if err != nil {
		t.Fatal(err)
	}
	if scope == nil {
		t.Fatal("scope = nil")
	}
	if err := scope.Cleanup(); err != nil {
		t.Fatal(err)
	}
}

func TestCreateCodexSessionScopeRejectsSymlinkedSessionFiles(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation needs a privilege the test cannot assume on Windows")
	}
	root := t.TempDir()
	codexHome := filepath.Join(root, "codex")
	outside := filepath.Join(root, "outside.jsonl")
	linkedSession := filepath.Join(codexHome, "archived_sessions", "2026", "07", "linked.jsonl")
	writeScopeSizedFile(t, outside, 128)
	if err := os.MkdirAll(filepath.Dir(linkedSession), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, linkedSession); err != nil {
		t.Fatal(err)
	}

	_, err := CreateCodexSessionScope(SessionScopeOptions{CodexHome: &codexHome, Since: "all"})
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "symbolic link") {
		t.Fatalf("error = %v", err)
	}
}

func TestCreateCodexSessionScopeAllowsAConfiguredSymlinkRoot(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation needs a privilege the test cannot assume on Windows")
	}
	root := t.TempDir()
	codexHome := filepath.Join(root, "codex")
	target := filepath.Join(root, "archive-target")
	linkedRoot := filepath.Join(codexHome, "archived_sessions")
	writeScopeSizedFile(t, filepath.Join(target, "2026", "07", "linked.jsonl"), 128)
	if err := os.MkdirAll(codexHome, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, linkedRoot); err != nil {
		t.Fatal(err)
	}

	scope, err := CreateCodexSessionScope(SessionScopeOptions{
		CodexHome:         &codexHome,
		Since:             "all",
		CodexSymlinkRoots: []string{target},
	})
	if err != nil {
		t.Fatal(err)
	}
	if scope == nil {
		t.Fatal("scope = nil")
	}
	if err := scope.Cleanup(); err != nil {
		t.Fatal(err)
	}
}

func TestCreateCodexSessionScopeAcceptsAFileThroughTheResolvedSymlinkTarget(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation needs a privilege the test cannot assume on Windows")
	}
	root := t.TempDir()
	codexHome := filepath.Join(root, "codex")
	target := filepath.Join(root, "archive-target")
	linkedRoot := filepath.Join(codexHome, "archived_sessions")
	targetFile := filepath.Join(target, "2026", "07", "linked.jsonl")
	writeScopeSizedFile(t, targetFile, 128)
	if err := os.MkdirAll(codexHome, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, linkedRoot); err != nil {
		t.Fatal(err)
	}
	resolvedFile, err := filepath.EvalSymlinks(targetFile)
	if err != nil {
		t.Fatal(err)
	}

	scope, err := CreateCodexSessionScope(SessionScopeOptions{
		CodexHome:         &codexHome,
		Files:             []string{resolvedFile},
		CodexSymlinkRoots: []string{target},
	})
	if err != nil {
		t.Fatal(err)
	}
	if scope == nil {
		t.Fatal("scope = nil")
	}
	if err := scope.Cleanup(); err != nil {
		t.Fatal(err)
	}
}

func TestCreateCodexSessionScopeRejectsSymlinkedSessionRoots(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation needs a privilege the test cannot assume on Windows")
	}
	root := t.TempDir()
	codexHome := filepath.Join(root, "codex")
	linkedRoot := filepath.Join(codexHome, "sessions")
	outsideRoot := filepath.Join(root, "outside-sessions")
	writeScopeSizedFile(t, filepath.Join(outsideRoot, "2026", "07", "outside.jsonl"), 128)
	if err := os.MkdirAll(codexHome, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outsideRoot, linkedRoot); err != nil {
		t.Fatal(err)
	}

	_, err := CreateCodexSessionScope(SessionScopeOptions{CodexHome: &codexHome, Since: "all"})
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "session directory") ||
		!strings.Contains(strings.ToLower(err.Error()), "symbolic link") {
		t.Fatalf("error = %v", err)
	}
}

func TestCreateCodexSessionScopeBatchesSplitBeforeTheCopiedBytesExceedTheLimit(t *testing.T) {
	codexHome := t.TempDir()
	for _, name := range []string{"first", "second", "third"} {
		writeScopeSizedFile(t, filepath.Join(codexHome, "sessions", "2026", "07", name+".jsonl"), 180)
	}

	copiedFileCounts := []int{}
	err := CreateCodexSessionScopeBatches(
		SessionScopeOptions{
			CodexHome:     &codexHome,
			Since:         "all",
			BatchSize:     3,
			MaxBatchBytes: 300,
			MaxFileBytes:  256,
		},
		func(scope *SessionScope) error {
			copiedFileCounts = append(copiedFileCounts, len(scope.SourceFiles))
			return scope.Cleanup()
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(copiedFileCounts) != 3 || copiedFileCounts[0] != 1 || copiedFileCounts[1] != 1 || copiedFileCounts[2] != 1 {
		t.Errorf("copied file counts = %v, want [1 1 1]", copiedFileCounts)
	}
}

func TestCreateCodexSessionScopeProjectsAnOversizedSession(t *testing.T) {
	codexHome := t.TempDir()
	session := filepath.Join(codexHome, "sessions", "2026", "07", "oversized.jsonl")
	writeScopeRaw(t, session, strings.Join([]string{
		`{"type":"session_meta","id":"session"}`,
		`{"type":"turn_context","payload":{"model":"gpt-5"}}`,
		`{"type":"event_msg","timestamp":"2026-07-01T00:00:00.000Z","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":2,"output_tokens":3}}}}`,
		`{"type":"response_item","payload":"` + strings.Repeat("x", 4096) + `"}`,
	}, "\n")+"\n")

	scope, err := CreateCodexSessionScope(SessionScopeOptions{
		CodexHome:     &codexHome,
		Since:         "all",
		MaxFileBytes:  128,
		MaxBatchBytes: 2048,
		MaxGroupBytes: 2048,
	})
	if err != nil {
		t.Fatal(err)
	}
	if scope == nil {
		t.Fatal("scope = nil")
	}
	defer scope.Cleanup()
	content, err := os.ReadFile(filepath.Join(scope.CodexHome, "sessions", "2026", "07", "oversized.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(content), "token_count") {
		t.Errorf("projected = %q, want the usage row", content)
	}
	if strings.Contains(string(content), "response_item") {
		t.Errorf("projected = %q, want the payload row dropped", content)
	}
	if !scope.ProjectedSourceFiles[session] {
		t.Errorf("projected sources = %v, want %s", scope.ProjectedSourceFiles, session)
	}
}

func TestCreateCodexSessionScopeFailsOnMalformedOversizedJSONL(t *testing.T) {
	codexHome := t.TempDir()
	writeScopeSizedFile(t, filepath.Join(codexHome, "sessions", "2026", "07", "oversized.jsonl"), 256)

	_, err := CreateCodexSessionScope(SessionScopeOptions{
		CodexHome:    &codexHome,
		Since:        "all",
		MaxFileBytes: 128,
	})
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "malformed jsonl row") {
		t.Fatalf("error = %v", err)
	}
}

func TestCreateCodexSessionScopeAllowsAnAppendAfterThePrefixIsCaptured(t *testing.T) {
	codexHome := t.TempDir()
	session := filepath.Join(codexHome, "sessions", "2026", "07", "changing.jsonl")
	writeScopeRaw(t, session, strings.Join(scopeOversizedRows(), "\n")+"\n")

	changed := false
	scope, err := CreateCodexSessionScope(SessionScopeOptions{
		CodexHome:     &codexHome,
		Since:         "all",
		MaxFileBytes:  128,
		MaxBatchBytes: 4096,
		OnProjectionDiagnostic: func(string) {
			if changed {
				return
			}
			changed = true
			file, err := os.OpenFile(session, os.O_APPEND|os.O_WRONLY, 0)
			if err != nil {
				t.Errorf("append: %v", err)
				return
			}
			defer file.Close()
			if _, err := file.WriteString(`{"type":"response_item","payload":"changed"}` + "\n"); err != nil {
				t.Errorf("append: %v", err)
			}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if scope == nil {
		t.Fatal("scope = nil")
	}
	if err := scope.Cleanup(); err != nil {
		t.Fatal(err)
	}
}

func TestCreateCodexSessionScopeFailsWhenAnOversizedSessionIsReplaced(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("replacement detection needs dev/ino, which os.FileInfo does not carry on Windows")
	}
	codexHome := t.TempDir()
	session := filepath.Join(codexHome, "sessions", "2026", "07", "replaced.jsonl")
	replacement := filepath.Join(codexHome, "sessions", "2026", "07", "replacement.jsonl")
	writeScopeRaw(t, session, strings.Join(scopeOversizedRows(), "\n")+"\n")

	changed := false
	_, err := CreateCodexSessionScope(SessionScopeOptions{
		CodexHome:     &codexHome,
		Since:         "all",
		MaxFileBytes:  128,
		MaxBatchBytes: 4096,
		OnProjectionDiagnostic: func(string) {
			if changed {
				return
			}
			changed = true
			writeScopeRaw(t, replacement, strings.Join(scopeOversizedRows(), "\n")+"\n")
			if err := os.Rename(replacement, session); err != nil {
				t.Errorf("rename: %v", err)
			}
		},
	})
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "session changed during scoped collection") {
		t.Fatalf("error = %v", err)
	}
}

func TestCreateCodexSessionScopeFailsWhenAnOversizedSessionIsTruncated(t *testing.T) {
	codexHome := t.TempDir()
	session := filepath.Join(codexHome, "sessions", "2026", "07", "truncated.jsonl")
	writeScopeRaw(t, session, strings.Join(scopeOversizedRows(), "\n")+"\n")

	_, err := CreateCodexSessionScope(SessionScopeOptions{
		CodexHome:     &codexHome,
		Since:         "all",
		MaxFileBytes:  128,
		MaxBatchBytes: 4096,
		OnProjectionDiagnostic: func(string) {
			if err := os.Truncate(session, 64); err != nil {
				t.Errorf("truncate: %v", err)
			}
		},
	})
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "session changed during scoped collection") {
		t.Fatalf("error = %v", err)
	}
}

func TestCreateCodexSessionScopeFailsWhenTheProjectionExceedsTheBatchLimit(t *testing.T) {
	codexHome := t.TempDir()
	session := filepath.Join(codexHome, "sessions", "2026", "07", "projected-limit.jsonl")
	writeScopeRaw(t, session, strings.Join([]string{
		`{"type":"session_meta","id":"session"}`,
		`{"type":"event_msg","timestamp":"2026-07-01T00:00:00.000Z","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":2,"output_tokens":3}},"padding":"` + strings.Repeat("x", 1024) + `"}}`,
	}, "\n")+"\n")

	_, err := CreateCodexSessionScope(SessionScopeOptions{
		CodexHome:     &codexHome,
		Since:         "all",
		MaxFileBytes:  128,
		MaxBatchBytes: 256,
		MaxGroupBytes: 256,
	})
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "projected session file exceeds scoped collection byte limit") {
		t.Fatalf("error = %v", err)
	}
}

func TestCreateCodexSessionScopeFailsWhenAnOversizedUsageRowExceedsTheLineLimit(t *testing.T) {
	codexHome := t.TempDir()
	session := filepath.Join(codexHome, "sessions", "2026", "07", "oversized-usage.jsonl")
	writeScopeRaw(t, session, strings.Join([]string{
		`{"type":"session_meta","id":"session"}`,
		`{"type":"event_msg","timestamp":"2026-07-01T00:00:00.000Z","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":2,"output_tokens":3}},"padding":"` + strings.Repeat("x", 2*1024*1024) + `"}}`,
	}, "\n")+"\n")

	_, err := CreateCodexSessionScope(SessionScopeOptions{
		CodexHome:     &codexHome,
		Since:         "all",
		MaxFileBytes:  128,
		MaxBatchBytes: 4096,
		MaxGroupBytes: 4096,
	})
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "oversized line with usage or subagent metadata") {
		t.Fatalf("error = %v", err)
	}
}

func TestCreateCodexSessionScopeKeepsProjectedFilesMappedAcrossProfiles(t *testing.T) {
	firstHome := t.TempDir()
	secondHome := t.TempDir()
	firstSession := filepath.Join(firstHome, "sessions", "2026", "07", "shared.jsonl")
	secondSession := filepath.Join(secondHome, "sessions", "2026", "07", "shared.jsonl")
	rows := strings.Join(scopeOversizedRows(), "\n") + "\n"
	writeScopeRaw(t, firstSession, rows)
	writeScopeRaw(t, secondSession, rows)

	var projected map[string]bool
	var sources map[string]bool
	batches := 0
	err := CreateCodexSessionScopeBatches(
		SessionScopeOptions{
			CodexHomes:    []string{firstHome, secondHome},
			Since:         "all",
			MaxFileBytes:  128,
			MaxBatchBytes: 4096,
			MaxGroupBytes: 8192,
		},
		func(scope *SessionScope) error {
			batches++
			projected = map[string]bool{}
			for file := range scope.ProjectedSourceFiles {
				projected[file] = true
			}
			sources = map[string]bool{}
			for _, source := range scope.SourceFiles {
				sources[source] = true
			}
			return scope.Cleanup()
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if batches != 1 {
		t.Fatalf("batches = %d, want 1", batches)
	}
	if !projected[firstSession] || !projected[secondSession] || len(projected) != 2 {
		t.Errorf("projected = %v", projected)
	}
	if !sources[firstSession] || !sources[secondSession] || len(sources) != 2 {
		t.Errorf("sources = %v", sources)
	}
}

func TestCreateCodexSessionScopeProjectsThroughAnApprovedRootSymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation needs a privilege the test cannot assume on Windows")
	}
	root := t.TempDir()
	codexHome := filepath.Join(root, "codex")
	targetRoot := filepath.Join(root, "archive-target")
	session := filepath.Join(targetRoot, "2026", "07", "linked.jsonl")
	writeScopeRaw(t, session, strings.Join(scopeOversizedRows(), "\n")+"\n")
	if err := os.MkdirAll(codexHome, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(targetRoot, filepath.Join(codexHome, "archived_sessions")); err != nil {
		t.Fatal(err)
	}

	scope, err := CreateCodexSessionScope(SessionScopeOptions{
		CodexHome:         &codexHome,
		Since:             "all",
		CodexSymlinkRoots: []string{targetRoot},
		MaxFileBytes:      128,
		MaxBatchBytes:     4096,
		MaxGroupBytes:     4096,
	})
	if err != nil {
		t.Fatal(err)
	}
	if scope == nil {
		t.Fatal("scope = nil")
	}
	defer scope.Cleanup()
	resolvedSession, err := filepath.EvalSymlinks(session)
	if err != nil {
		t.Fatal(err)
	}
	if !scope.ProjectedSourceFiles[resolvedSession] {
		t.Errorf("projected sources = %v, want %s", scope.ProjectedSourceFiles, resolvedSession)
	}
}

func TestCreateCodexSessionScopeKeepsAMultiProfileGroupTogether(t *testing.T) {
	firstHome := t.TempDir()
	secondHome := t.TempDir()
	firstSession := filepath.Join(firstHome, "sessions", "2026", "07", "shared.jsonl")
	secondSession := filepath.Join(secondHome, "sessions", "2026", "07", "shared.jsonl")
	writeScopeSizedFile(t, firstSession, 180)
	writeScopeSizedFile(t, secondSession, 180)

	var sources map[string]bool
	batches := 0
	err := CreateCodexSessionScopeBatches(
		SessionScopeOptions{
			CodexHomes:    []string{firstHome, secondHome},
			Since:         "all",
			MaxFileBytes:  256,
			MaxBatchBytes: 300,
			MaxGroupBytes: 400,
		},
		func(scope *SessionScope) error {
			batches++
			sources = map[string]bool{}
			for _, source := range scope.SourceFiles {
				sources[source] = true
			}
			return scope.Cleanup()
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if batches != 1 {
		t.Fatalf("batches = %d, want 1", batches)
	}
	if !sources[firstSession] || !sources[secondSession] || len(sources) != 2 {
		t.Errorf("sources = %v, want both profiles", sources)
	}
}

func TestCreateCodexSessionScopeBatchesRejectAGroupOverTheGroupLimit(t *testing.T) {
	firstHome := t.TempDir()
	secondHome := t.TempDir()
	writeScopeSizedFile(t, filepath.Join(firstHome, "sessions", "2026", "07", "shared.jsonl"), 180)
	writeScopeSizedFile(t, filepath.Join(secondHome, "sessions", "2026", "07", "shared.jsonl"), 180)

	err := CreateCodexSessionScopeBatches(
		SessionScopeOptions{
			CodexHomes:    []string{firstHome, secondHome},
			Since:         "all",
			MaxFileBytes:  256,
			MaxBatchBytes: 300,
			MaxGroupBytes: 300,
		},
		func(scope *SessionScope) error { return scope.Cleanup() },
	)
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "group exceeds") ||
		!strings.Contains(strings.ToLower(err.Error()), "group byte limit") {
		t.Fatalf("error = %v", err)
	}
}

func TestCreateCodexSessionScopeSkipsADatedSessionOutsideTheWindow(t *testing.T) {
	codexHome := t.TempDir()
	session := filepath.Join(codexHome, "sessions", "2026", "01", "01", "large.jsonl")
	writeScopeSizedFile(t, session, 256)
	setScopeModTime(t, session, "2026-01-01T00:00:00.000Z")

	scope, err := CreateCodexSessionScope(SessionScopeOptions{
		CodexHome:         &codexHome,
		Since:             "20260701",
		MaxPrefilterBytes: 128,
	})
	if err != nil {
		t.Fatal(err)
	}
	if scope != nil {
		scope.Cleanup()
		t.Fatalf("scope = %+v, want nil", scope)
	}
}

func TestCreateCodexSessionScopeSkipsAnArchivedRolloutOutsideTheWindow(t *testing.T) {
	codexHome := t.TempDir()
	session := filepath.Join(codexHome, "archived_sessions", "rollout-2026-01-01T00-00-00-session.jsonl")
	writeScopeSizedFile(t, session, 256)
	setScopeModTime(t, session, "2026-01-01T00:00:00.000Z")

	scope, err := CreateCodexSessionScope(SessionScopeOptions{
		CodexHome:         &codexHome,
		Since:             "20260701",
		MaxPrefilterBytes: 128,
	})
	if err != nil {
		t.Fatal(err)
	}
	if scope != nil {
		scope.Cleanup()
		t.Fatalf("scope = %+v, want nil", scope)
	}
}

func TestCreateCodexSessionScopeKeepsADatedLongRunningSession(t *testing.T) {
	codexHome := t.TempDir()
	session := filepath.Join(codexHome, "sessions", "2026", "01", "01", "long-running.jsonl")
	writeScopeSizedFile(t, session, 256)
	setScopeModTime(t, session, "2026-08-03T00:00:00.000Z")

	scope, err := CreateCodexSessionScope(SessionScopeOptions{
		CodexHome:         &codexHome,
		Since:             "20260701",
		Until:             "20260731",
		MaxPrefilterBytes: 128,
	})
	if err != nil {
		t.Fatal(err)
	}
	if scope == nil {
		t.Fatal("scope = nil")
	}
	if err := scope.Cleanup(); err != nil {
		t.Fatal(err)
	}
}

func TestCreateCodexSessionScopeFallsBackWhenThePrefilterExceedsItsReadLimit(t *testing.T) {
	codexHome := t.TempDir()
	session := filepath.Join(codexHome, "sessions", "large.jsonl")
	writeScopeSizedFile(t, session, 256)
	setScopeModTime(t, session, "2026-01-01T00:00:00.000Z")

	scope, err := CreateCodexSessionScope(SessionScopeOptions{
		CodexHome:         &codexHome,
		Since:             "20260701",
		MaxPrefilterBytes: 128,
	})
	if err != nil {
		t.Fatal(err)
	}
	if scope == nil {
		t.Fatal("scope = nil")
	}
	if err := scope.Cleanup(); err != nil {
		t.Fatal(err)
	}
}

func TestCreateCodexSessionScopeAcceptsAnInRangeTokenCountBeforeTheReadLimit(t *testing.T) {
	codexHome := t.TempDir()
	session := filepath.Join(codexHome, "sessions", "early-token.jsonl")
	tokenCount := `{"type":"event_msg","timestamp":"2026-07-01T00:00:00.000Z","payload":{"type":"token_count"}}`
	writeScopeRaw(t, session, tokenCount+"\n"+strings.Repeat("x", 512))
	setScopeModTime(t, session, "2026-01-01T00:00:00.000Z")

	scope, err := CreateCodexSessionScope(SessionScopeOptions{
		CodexHome:         &codexHome,
		Since:             "20260701",
		MaxPrefilterBytes: int64(len(tokenCount) + 1),
	})
	if err != nil {
		t.Fatal(err)
	}
	if scope == nil {
		t.Fatal("scope = nil")
	}
	if err := scope.Cleanup(); err != nil {
		t.Fatal(err)
	}
}

func TestCreateCodexSessionScopeFallsBackOnAnOversizedPrefilterLine(t *testing.T) {
	codexHome := t.TempDir()
	session := filepath.Join(codexHome, "sessions", "long-line.jsonl")
	writeScopeSizedFile(t, session, 256)
	setScopeModTime(t, session, "2026-01-01T00:00:00.000Z")

	scope, err := CreateCodexSessionScope(SessionScopeOptions{
		CodexHome:             &codexHome,
		Since:                 "20260701",
		MaxPrefilterBytes:     512,
		MaxPrefilterLineBytes: 64,
	})
	if err != nil {
		t.Fatal(err)
	}
	if scope == nil {
		t.Fatal("scope = nil")
	}
	if err := scope.Cleanup(); err != nil {
		t.Fatal(err)
	}
}

// --- copy races -----------------------------------------------------------

func TestCreateCodexSessionScopeClosesTheClonerAfterCopying(t *testing.T) {
	codexHome := t.TempDir()
	writeScopeJSONL(t, filepath.Join(codexHome, "sessions", "2026", "05", "first.jsonl"),
		[]any{scopeTokenCountEvent("2026-05-09T04:24:07.234Z")})
	writeScopeJSONL(t, filepath.Join(codexHome, "sessions", "2026", "05", "second.jsonl"),
		[]any{scopeTokenCountEvent("2026-05-09T04:25:07.234Z")})

	cloner := &fakeSessionCloner{copy: copyClonerFixture}
	scope, err := CreateCodexSessionScope(SessionScopeOptions{
		CodexHome: &codexHome,
		Since:     "all",
		CreateCloner: func(func()) CodexSessionCloner {
			return cloner
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if scope == nil {
		t.Fatal("scope = nil")
	}
	if cloner.copies != 2 {
		t.Errorf("copies = %d, want 2", cloner.copies)
	}
	if cloner.closes != 1 {
		t.Errorf("closes = %d, want 1 (the helper must not outlive the copy)", cloner.closes)
	}
	if err := scope.Cleanup(); err != nil {
		t.Fatal(err)
	}
	if cloner.closes != 1 {
		t.Errorf("closes after cleanup = %d, want 1", cloner.closes)
	}
}

func TestCreateCodexSessionScopeReportsTheFallbackOnce(t *testing.T) {
	codexHome := t.TempDir()
	writeScopeJSONL(t, filepath.Join(codexHome, "sessions", "2026", "05", "first.jsonl"),
		[]any{scopeTokenCountEvent("2026-05-09T04:24:07.234Z")})
	writeScopeJSONL(t, filepath.Join(codexHome, "sessions", "2026", "05", "second.jsonl"),
		[]any{scopeTokenCountEvent("2026-05-09T04:25:07.234Z")})

	messages := []string{}
	scope, err := CreateCodexSessionScope(SessionScopeOptions{
		CodexHome: &codexHome,
		Since:     "all",
		OnCopyFallback: func(message string) {
			messages = append(messages, message)
		},
		CreateCloner: func(onFallback func()) CodexSessionCloner {
			return &fakeSessionCloner{copy: func(source, target string) error {
				onFallback()
				return copyClonerFixture(source, target)
			}}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if scope == nil {
		t.Fatal("scope = nil")
	}
	defer scope.Cleanup()
	if len(messages) != 1 || messages[0] != CodexSessionCopyFallbackMessage {
		t.Errorf("messages = %v, want the fallback message once", messages)
	}
}

func TestCreateCodexSessionScopeDoesNotHideANonFallbackCloneError(t *testing.T) {
	codexHome := t.TempDir()
	writeScopeJSONL(t, filepath.Join(codexHome, "sessions", "2026", "05", "active.jsonl"),
		[]any{scopeTokenCountEvent("2026-05-09T04:24:07.234Z")})

	cloner := &fakeSessionCloner{copy: func(_, _ string) error {
		return &os.PathError{Op: "copy", Path: "target", Err: syscall.EACCES}
	}}
	_, err := CreateCodexSessionScope(SessionScopeOptions{
		CodexHome:    &codexHome,
		Since:        "all",
		CreateCloner: func(func()) CodexSessionCloner { return cloner },
	})
	if err == nil || !errors.Is(err, syscall.EACCES) {
		t.Fatalf("error = %v, want EACCES", err)
	}
	if cloner.closes != 1 {
		t.Errorf("closes = %d, want 1", cloner.closes)
	}
}

func TestCreateCodexSessionScopeSkipsOnlyADisappearedSource(t *testing.T) {
	codexHome := t.TempDir()
	activeFile := filepath.Join(codexHome, "sessions", "2026", "05", "active.jsonl")
	disappearingFile := filepath.Join(codexHome, "sessions", "2026", "05", "disappearing.jsonl")
	writeScopeJSONL(t, activeFile, []any{scopeTokenCountEvent("2026-05-09T04:24:07.234Z")})
	writeScopeJSONL(t, disappearingFile, []any{scopeTokenCountEvent("2026-05-09T04:25:07.234Z")})

	skippedFiles := []string{}
	scope, err := CreateCodexSessionScope(SessionScopeOptions{
		CodexHome: &codexHome,
		Since:     "all",
		OnMissingSessionFile: func(file string) {
			skippedFiles = append(skippedFiles, file)
		},
		CreateCloner: func(func()) CodexSessionCloner {
			return &fakeSessionCloner{copy: func(source, target string) error {
				if strings.HasSuffix(source, "disappearing.jsonl") {
					if err := os.Remove(source); err != nil {
						return err
					}
					return &os.PathError{Op: "copy", Path: target, Err: syscall.ENOENT}
				}
				return copyClonerFixture(source, target)
			}}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if scope == nil {
		t.Fatal("scope = nil")
	}
	defer scope.Cleanup()
	if len(skippedFiles) != 1 || skippedFiles[0] != "2026/05/disappearing.jsonl" {
		t.Errorf("skipped = %v", skippedFiles)
	}
	content, err := os.ReadFile(filepath.Join(scope.CodexHome, "sessions", "2026", "05", "active.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(content), "token_count") {
		t.Errorf("active session = %q", content)
	}
}

func TestCreateCodexSessionScopeDoesNotTreatAnUnrelatedENOENTAsMissing(t *testing.T) {
	codexHome := t.TempDir()
	writeScopeJSONL(t, filepath.Join(codexHome, "sessions", "2026", "05", "active.jsonl"),
		[]any{scopeTokenCountEvent("2026-05-09T04:24:07.234Z")})

	skippedFiles := []string{}
	_, err := CreateCodexSessionScope(SessionScopeOptions{
		CodexHome: &codexHome,
		Since:     "all",
		OnMissingSessionFile: func(file string) {
			skippedFiles = append(skippedFiles, file)
		},
		CreateCloner: func(func()) CodexSessionCloner {
			return &fakeSessionCloner{copy: func(_, _ string) error {
				return errors.New("target vanished")
			}}
		},
	})
	if err == nil || err.Error() != "target vanished" {
		t.Fatalf("error = %v", err)
	}
	if len(skippedFiles) != 0 {
		t.Errorf("skipped = %v, want none", skippedFiles)
	}
}

// --- root races -----------------------------------------------------------

func TestCreateCodexSessionScopeSkipsARootRemovedAfterResolution(t *testing.T) {
	codexHome := t.TempDir()
	rootPath := filepath.Join(codexHome, "sessions")
	if err := os.Mkdir(rootPath, 0o755); err != nil {
		t.Fatal(err)
	}
	original := scopeRootLstat
	t.Cleanup(func() { scopeRootLstat = original })
	calls := 0
	scopeRootLstat = func(string) (os.FileInfo, error) {
		calls++
		return nil, &os.PathError{Op: "lstat", Path: rootPath, Err: syscall.ENOENT}
	}

	scope, err := CreateCodexSessionScope(SessionScopeOptions{CodexHome: &codexHome, Since: "all"})
	if err != nil {
		t.Fatal(err)
	}
	if scope != nil {
		scope.Cleanup()
		t.Fatalf("scope = %+v, want nil", scope)
	}
	if calls != 1 {
		t.Errorf("root metadata reads = %d, want 1 (only the existing root is re-read)", calls)
	}
}

func TestCreateCodexSessionScopeSkipsANonSymlinkRootRemovedAfterRealpathResolution(t *testing.T) {
	codexHome := t.TempDir()
	rootPath := filepath.Join(codexHome, "sessions")
	if err := os.Mkdir(rootPath, 0o755); err != nil {
		t.Fatal(err)
	}
	// The resolved-root stat lives in sessionwalk; this seam injects the
	// outcome that race produces (the root resolves, then vanishes before the
	// walk), so the scope's own handling is what is under test.
	original := scopeResolveSessionFiles
	t.Cleanup(func() { scopeResolveSessionFiles = original })
	resolutions := map[string]int{}
	scopeResolveSessionFiles = func(root string, _ sessionwalk.Options) (sessionwalk.Files, bool, error) {
		resolutions[root]++
		return sessionwalk.Files{}, false, nil
	}

	scope, err := CreateCodexSessionScope(SessionScopeOptions{CodexHome: &codexHome, Since: "all"})
	if err != nil {
		t.Fatal(err)
	}
	if scope != nil {
		scope.Cleanup()
		t.Fatalf("scope = %+v, want nil", scope)
	}
	if resolutions[rootPath] != 1 {
		t.Errorf("root resolutions for %s = %d, want 1", rootPath, resolutions[rootPath])
	}
	if resolutions[filepath.Join(codexHome, "archived_sessions")] != 1 {
		t.Errorf("archived root resolutions = %d, want 1", resolutions[filepath.Join(codexHome, "archived_sessions")])
	}
}

// --- explicit batches -----------------------------------------------------

func TestCreateCodexSessionScopeBatchesForFilesKeepGroupsTogether(t *testing.T) {
	root := t.TempDir()
	firstHome := filepath.Join(root, "first")
	secondHome := filepath.Join(root, "second")
	firstShared := filepath.Join(firstHome, "sessions", "2026", "07", "shared.jsonl")
	secondShared := filepath.Join(secondHome, "sessions", "2026", "07", "shared.jsonl")
	later := filepath.Join(firstHome, "sessions", "2026", "07", "later.jsonl")
	for _, file := range []string{firstShared, secondShared, later} {
		writeScopeSizedFile(t, file, 130)
	}

	type batchSummary struct {
		firstShared  bool
		secondShared bool
		later        bool
		homeCount    int
	}
	batches := []batchSummary{}
	err := CreateCodexSessionScopeBatchesForFiles(SessionScopeFilesInput{
		Options: SessionScopeOptions{
			CodexHomes:    []string{firstHome, secondHome},
			MaxFileBytes:  256,
			MaxBatchBytes: 300,
			BatchSize:     2,
		},
		Groups: []SessionScopeFileGroup{
			{Files: []SessionScopeFile{
				{CodexHome: firstHome, FilePath: firstShared},
				{CodexHome: secondHome, FilePath: secondShared},
			}},
			{Files: []SessionScopeFile{{CodexHome: firstHome, FilePath: later}}},
		},
	}, func(scope *SessionScope) error {
		copied := map[string]bool{}
		for _, source := range scope.SourceFiles {
			copied[source] = true
		}
		batches = append(batches, batchSummary{
			firstShared:  copied[firstShared],
			secondShared: copied[secondShared],
			later:        copied[later],
			homeCount:    len(scope.CodexHomes),
		})
		return scope.Cleanup()
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(batches) != 2 {
		t.Fatalf("batches = %v, want 2", batches)
	}
	for _, batch := range batches {
		if batch.homeCount != 2 {
			t.Errorf("home count = %d, want 2", batch.homeCount)
		}
	}
	want := []batchSummary{
		{firstShared: true, secondShared: true, later: false, homeCount: 2},
		{firstShared: false, secondShared: false, later: true, homeCount: 2},
	}
	found := 0
	for _, expected := range want {
		for _, batch := range batches {
			if batch == expected {
				found++
				break
			}
		}
	}
	if found != len(want) {
		t.Errorf("batches = %v, want %v", batches, want)
	}
}

// --- helpers --------------------------------------------------------------

type fakeSessionCloner struct {
	copies int
	closes int
	copy   func(source, target string) error
}

func (c *fakeSessionCloner) Copy(source, target string) error {
	c.copies++
	return c.copy(source, target)
}

func (c *fakeSessionCloner) Close() error {
	c.closes++
	return nil
}

type scopeLimitedWriter struct {
	limit  int
	buffer bytes.Buffer
}

func (w *scopeLimitedWriter) Write(data []byte) (int, error) {
	length := len(data)
	if length > w.limit {
		length = w.limit
	}
	w.buffer.Write(data[:length])
	return length, nil
}

func writeScopeJSONL(t *testing.T, file string, rows []any) {
	t.Helper()
	lines := make([]string, 0, len(rows))
	for _, row := range rows {
		encoded, err := json.Marshal(row)
		if err != nil {
			t.Fatal(err)
		}
		lines = append(lines, string(encoded))
	}
	writeScopeRaw(t, file, strings.Join(lines, "\n")+"\n")
}

func writeScopeRaw(t *testing.T, file, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func writeScopeSizedFile(t *testing.T, file string, size int) {
	t.Helper()
	writeScopeRaw(t, file, strings.Repeat("x", size-1)+"\n")
}

func scopeTokenCountEvent(timestamp string) map[string]any {
	return map[string]any{
		"type":      "event_msg",
		"timestamp": timestamp,
		"payload": map[string]any{
			"type": "token_count",
			"info": map[string]any{
				"last_token_usage": map[string]any{
					"input_tokens":  10,
					"output_tokens": 0,
					"total_tokens":  10,
				},
			},
		},
	}
}

func scopeOversizedRows() []string {
	return []string{
		`{"type":"session_meta","id":"session"}`,
		`{"type":"turn_context","payload":{"model":"gpt-5"}}`,
		`{"type":"event_msg","timestamp":"2026-07-01T00:00:00.000Z","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":2,"output_tokens":3}}}}`,
		`{"type":"response_item","payload":"` + strings.Repeat("x", 4096) + `"}`,
	}
}

func setScopeModTime(t *testing.T, file, value string) {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(file, parsed, parsed); err != nil {
		t.Fatal(err)
	}
}

func scopeFileExists(file string) bool {
	_, err := os.Stat(file)
	return err == nil
}

func listScopeTempDirs(t *testing.T, root string) []string {
	t.Helper()
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "tokenboard-codex-home-") {
			names = append(names, entry.Name())
		}
	}
	return names
}

func containsScopeEntry(values []string, value string) bool {
	for _, item := range values {
		if item == value {
			return true
		}
	}
	return false
}
