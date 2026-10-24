package sessioncursor

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// The hook-incremental contract the Codex provider builds on: the pending
// bookkeeping, the reconciliation file entries, and the pending-only path.

// InstallContextPricingMarkerForTests swaps the Codex marker for the duration
// of one test. The provider installs the real one at init; tests that write a
// Codex cursor need a stand-in.
func InstallContextPricingMarkerForTests(marker func([]Snapshot) []Snapshot) func() {
	previous := ContextPricingMarker
	ContextPricingMarker = marker
	return func() { ContextPricingMarker = previous }
}

func writeSessionFile(t *testing.T, root, relativePath string, rows ...string) string {
	t.Helper()
	path := filepath.Join(root, relativePath)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	content := strings.Join(rows, "\n") + "\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func hookInput(root, stateDir string) HookInput {
	return HookInput{
		Source:      contract.SourceClaudeCode,
		SessionsDir: filepath.Join(root, "sessions"),
		StateDir:    stateDir,
		CursorName:  "claude-code-cursor.json",
		Timezone:    "Asia/Shanghai",
		CollectedAt: "2026-05-22T10:00:00.000Z",
		Now:         func() time.Time { return time.Date(2026, 5, 22, 10, 0, 0, 0, time.UTC) },
	}
}

func assistantRow(timestamp, model string, input, output int) string {
	return `{"type":"assistant","timestamp":"` + timestamp + `","message":{"model":"` + model +
		`","usage":{"input_tokens":` + itoa(input) + `,"output_tokens":` + itoa(output) + `}}}`
}

func codexTokenRow(timestamp, model string, totalTokens int) string {
	return `{"type":"event_msg","timestamp":"` + timestamp + `","payload":{"type":"token_count","info":{"model":"` +
		model + `","last_token_usage":{"input_tokens":` + itoa(totalTokens) +
		`,"output_tokens":0,"total_tokens":` + itoa(totalTokens) + `}}}}`
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	digits := []byte{}
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	return string(digits)
}

func TestHookIncrementalReportsReconciliationFileEntries(t *testing.T) {
	root := t.TempDir()
	stateDir := t.TempDir()
	writeSessionFile(t, root, "sessions/project-a/session.jsonl",
		assistantRow("2026-05-22T02:00:00.000Z", "claude-sonnet-4-5", 8, 13))

	input := hookInput(root, stateDir)
	input.IncludeReconciliationFileEntries = true
	result, err := CollectHookIncremental(input)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.ReconciliationFileEntries) != 1 {
		t.Fatalf("entries = %+v", result.ReconciliationFileEntries)
	}
	entry := result.ReconciliationFileEntries[0]
	if entry.RelativePath != "project-a/session.jsonl" || len(entry.SHA256) != 128 {
		t.Errorf("entry = %+v", entry)
	}
	if len(result.PendingSnapshotEntries) != 0 {
		t.Errorf("pending entries must be omitted unless asked for: %+v", result.PendingSnapshotEntries)
	}
}

// A pending entry is reported once its file stops changing: the Codex reusable
// path reuses the stored snapshots instead of re-reading, and the caller needs
// them to acknowledge exactly what it uploaded.
func TestHookIncrementalReportsPendingSnapshotEntriesWhenAsked(t *testing.T) {
	root := t.TempDir()
	stateDir := t.TempDir()
	writeSessionFile(t, root, "sessions/project-a/session.jsonl",
		codexTokenRow("2026-05-22T02:00:00.000Z", "gpt-5", 21))

	restore := InstallContextPricingMarkerForTests(func(snapshots []Snapshot) []Snapshot { return snapshots })
	defer restore()

	input := hookInput(root, stateDir)
	input.Source = contract.SourceCodex
	input.CursorName = "codex-cursor.json"
	input.IncludePendingSnapshotEntries = true
	if _, err := CollectHookIncremental(input); err != nil {
		t.Fatal(err)
	}

	second := input
	result, err := CollectHookIncremental(second)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.PendingSnapshotEntries) != 1 {
		t.Fatalf("pending entries = %+v", result.PendingSnapshotEntries)
	}
	if result.PendingSnapshotEntries[0].Snapshot.Model != "gpt-5" {
		t.Errorf("entry = %+v", result.PendingSnapshotEntries[0])
	}
}

// The pending-only path reads the cursor without touching the session tree,
// which is what the Codex provider uses when no file changed.
func TestHookIncrementalSkipSessionScanReadsPendingEntries(t *testing.T) {
	root := t.TempDir()
	stateDir := t.TempDir()
	writeSessionFile(t, root, "sessions/project-a/session.jsonl",
		assistantRow("2026-05-22T02:00:00.000Z", "claude-sonnet-4-5", 8, 13))

	first := hookInput(root, stateDir)
	first.IncludePendingSnapshotEntries = true
	if _, err := CollectHookIncremental(first); err != nil {
		t.Fatal(err)
	}

	input := hookInput(root, stateDir)
	input.SkipSessionScan = true
	input.IncludePendingSnapshotEntries = true
	input.IncludeReconciliationFileEntries = true
	result, err := CollectHookIncremental(input)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Changed || len(result.CachedSnapshots) != 1 {
		t.Errorf("result = %+v", result)
	}
	if len(result.PendingSnapshotEntries) != 1 {
		t.Errorf("pending entries = %+v", result.PendingSnapshotEntries)
	}
	if result.ReconciliationFileEntries == nil || len(result.ReconciliationFileEntries) != 0 {
		t.Errorf("the pending-only path reconciles nothing: %+v", result.ReconciliationFileEntries)
	}
}

func TestHookIncrementalSkipSessionScanDropsSnapshotlessPendingEntries(t *testing.T) {
	stateDir := t.TempDir()
	pending := true
	cursor := NewState("claude-code")
	cursor.Files["project-a/empty.jsonl"] = Entry{
		Size:          1,
		MtimeMs:       1,
		SHA256:        "abc",
		Snapshots:     []Snapshot{},
		PendingUpload: &pending,
		UpdatedAt:     "2026-05-22T10:00:00.000Z",
	}
	cursorPath := filepath.Join(stateDir, "claude-code-cursor.json")
	if err := Write(cursorPath, cursor); err != nil {
		t.Fatal(err)
	}

	input := HookInput{
		Source:          contract.SourceClaudeCode,
		StateDir:        stateDir,
		CursorName:      "claude-code-cursor.json",
		CollectedAt:     "2026-05-22T10:00:00.000Z",
		SkipSessionScan: true,
	}
	result, err := CollectHookIncremental(input)
	if err != nil {
		t.Fatal(err)
	}
	if result.Changed || len(result.CachedSnapshots) != 0 {
		t.Errorf("result = %+v", result)
	}
	rewritten, err := Read(cursorPath, "claude-code")
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := rewritten.Files["project-a/empty.jsonl"]; ok {
		t.Error("a pending entry with no snapshots must be dropped")
	}
}

// A pending file whose content did not change is reusable: its snapshots ride
// along instead of being re-read. The result exposes them only when the run
// also has changed files (the TS shape), so the scan-level assertion is what
// pins the reuse itself.
func TestHookIncrementalMarksReusablePendingFiles(t *testing.T) {
	root := t.TempDir()
	stateDir := t.TempDir()
	writeSessionFile(t, root, "sessions/project-a/session.jsonl",
		codexTokenRow("2026-05-22T02:00:00.000Z", "gpt-5", 21))

	restore := InstallContextPricingMarkerForTests(func(snapshots []Snapshot) []Snapshot { return snapshots })
	defer restore()

	input := HookInput{
		Source:      contract.SourceCodex,
		SessionsDir: filepath.Join(root, "sessions"),
		StateDir:    stateDir,
		CursorName:  "codex-cursor.json",
		Timezone:    "Asia/Shanghai",
		CollectedAt: "2026-05-22T10:00:00.000Z",
		Now:         func() time.Time { return time.Date(2026, 5, 22, 10, 0, 0, 0, time.UTC) },
	}
	if _, err := CollectHookIncremental(input); err != nil {
		t.Fatal(err)
	}

	scan, err := CollectChangedSessionFiles(ScanInput{
		Source:      contract.SourceCodex,
		SessionsDir: filepath.Join(root, "sessions"),
		CursorPath:  filepath.Join(stateDir, "codex-cursor.json"),
		Now:         input.Now,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(scan.Files) != 0 {
		t.Fatalf("the unchanged file must not be re-read: %+v", scan.Files)
	}
	if len(scan.ReusablePendingFiles) != 1 {
		t.Fatalf("reusable files = %+v", scan.ReusablePendingFiles)
	}
	if scan.ReusablePendingFiles[0].Snapshots[0].Model != "gpt-5" {
		t.Errorf("reusable snapshots = %+v", scan.ReusablePendingFiles[0].Snapshots)
	}

	// The hook run still re-emits the carried snapshots so they upload.
	second, err := CollectHookIncremental(input)
	if err != nil {
		t.Fatal(err)
	}
	if !second.Changed || len(second.CachedSnapshots) != 1 {
		t.Errorf("second run = %+v", second)
	}
}

// When the run also has a changed file, the reusable subset is reported
// alongside the cached snapshots so the caller knows which ones ccusage
// already covered.
func TestHookIncrementalReportsReusablePendingSnapshotsWithChanges(t *testing.T) {
	root := t.TempDir()
	stateDir := t.TempDir()
	writeSessionFile(t, root, "sessions/project-a/one.jsonl",
		codexTokenRow("2026-05-22T02:00:00.000Z", "gpt-5", 21))

	restore := InstallContextPricingMarkerForTests(func(snapshots []Snapshot) []Snapshot { return snapshots })
	defer restore()

	input := HookInput{
		Source:      contract.SourceCodex,
		SessionsDir: filepath.Join(root, "sessions"),
		StateDir:    stateDir,
		CursorName:  "codex-cursor.json",
		Timezone:    "Asia/Shanghai",
		CollectedAt: "2026-05-22T10:00:00.000Z",
		Now:         func() time.Time { return time.Date(2026, 5, 22, 10, 0, 0, 0, time.UTC) },
	}
	if _, err := CollectHookIncremental(input); err != nil {
		t.Fatal(err)
	}
	writeSessionFile(t, root, "sessions/project-a/two.jsonl",
		codexTokenRow("2026-05-23T02:00:00.000Z", "gpt-5", 7))

	result, err := CollectHookIncremental(input)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.ReusablePendingSnapshots) != 1 {
		t.Fatalf("reusable snapshots = %+v", result.ReusablePendingSnapshots)
	}
	if result.ReusablePendingSnapshots[0].UsageDate != "2026-05-22" {
		t.Errorf("reusable snapshot = %+v", result.ReusablePendingSnapshots[0])
	}
}

func TestAssertHookReconciliationSnapshotsAcceptsModelWildcard(t *testing.T) {
	err := AssertHookReconciliationSnapshots("Claude", []string{"2026-05-22"},
		[]HookKey{{UsageDate: "2026-05-22"}},
		[]contract.Snapshot{{UsageDate: "2026-05-22", Model: "any-model"}})
	if err != nil {
		t.Errorf("err = %v", err)
	}
}

func TestAssertHookReconciliationSnapshotsRequiresEverySpecificModel(t *testing.T) {
	err := AssertHookReconciliationSnapshots("Claude", nil,
		[]HookKey{{UsageDate: "2026-05-22", Model: "claude-sonnet-4-5"}},
		[]contract.Snapshot{{UsageDate: "2026-05-22", Model: "claude-opus-4-1"}})
	if err == nil || !strings.Contains(err.Error(), "2026-05-22/claude-sonnet-4-5") {
		t.Fatalf("err = %v", err)
	}
}

// File acknowledgement is the Codex contract: the exact (path, digest)
// revision the upload covered is cleared, and the Codex pending-correction
// marker goes with it.
func TestAcknowledgePendingUploadsClearsAnAcknowledgedCodexFile(t *testing.T) {
	stateDir := t.TempDir()
	pending := true
	cursor := NewState("codex")
	cursor.Files["2026/05/22/session.jsonl"] = Entry{
		Size:          1,
		MtimeMs:       1,
		SHA256:        "abc",
		Snapshots:     []Snapshot{{Source: "codex", UsageDate: "2026-05-22", Model: "gpt-5", CodexContextPricingPending: true}},
		PendingUpload: &pending,
		UpdatedAt:     "2026-05-22T10:00:00.000Z",
	}
	cursorPath := filepath.Join(stateDir, "codex-cursor.json")
	if err := Write(cursorPath, cursor); err != nil {
		t.Fatal(err)
	}
	if err := AcknowledgePendingUploads(AcknowledgeInput{
		StateDir:          stateDir,
		Source:            contract.SourceCodex,
		AcknowledgedFiles: []AcknowledgedFile{{RelativePath: "2026/05/22/session.jsonl", SHA256: "abc"}},
	}); err != nil {
		t.Fatal(err)
	}
	entry := readCursorFiles(t, cursorPath)["2026/05/22/session.jsonl"]
	if entry.PendingUpload == nil || *entry.PendingUpload {
		t.Error("the acknowledged entry must be cleared")
	}
	if entry.Snapshots[0].CodexContextPricingPending {
		t.Error("the pending-correction marker must be cleared with the acknowledgement")
	}
}

// A different digest means the file changed after the upload: its new bytes
// never reached the server, so it stays pending.
func TestAcknowledgePendingUploadsKeepsAChangedCodexFile(t *testing.T) {
	stateDir := t.TempDir()
	pending := true
	cursor := NewState("codex")
	cursor.Files["2026/05/22/session.jsonl"] = Entry{
		Size: 2, MtimeMs: 2, SHA256: "newer",
		Snapshots:     []Snapshot{{Source: "codex", UsageDate: "2026-05-22", Model: "gpt-5"}},
		PendingUpload: &pending,
		UpdatedAt:     "2026-05-22T10:00:00.000Z",
	}
	cursorPath := filepath.Join(stateDir, "codex-cursor.json")
	if err := Write(cursorPath, cursor); err != nil {
		t.Fatal(err)
	}
	if err := AcknowledgePendingUploads(AcknowledgeInput{
		StateDir:          stateDir,
		Source:            contract.SourceCodex,
		AcknowledgedFiles: []AcknowledgedFile{{RelativePath: "2026/05/22/session.jsonl", SHA256: "older"}},
	}); err != nil {
		t.Fatal(err)
	}
	entry := readCursorFiles(t, cursorPath)["2026/05/22/session.jsonl"]
	if entry.PendingUpload == nil || !*entry.PendingUpload {
		t.Error("the unacknowledged revision must stay pending")
	}
}

// The two acknowledgement forms are mutually exclusive, and only Codex takes
// file acknowledgements; mixing them would silently pick one.
func TestAcknowledgePendingUploadsRejectsMixedOrForeignFileAcknowledgements(t *testing.T) {
	stateDir := t.TempDir()
	if err := AcknowledgePendingUploads(AcknowledgeInput{
		StateDir:           stateDir,
		Source:             contract.SourceCodex,
		AcknowledgedGroups: map[string]bool{"codex\x002026-05-22\x00Asia/Shanghai\x00gpt-5": true},
		AcknowledgedFiles:  []AcknowledgedFile{{RelativePath: "a", SHA256: "b"}},
	}); err == nil || !strings.Contains(err.Error(), "cannot be supplied together") {
		t.Fatalf("err = %v", err)
	}
	if err := AcknowledgePendingUploads(AcknowledgeInput{
		StateDir:          stateDir,
		Source:            contract.SourceClaudeCode,
		AcknowledgedFiles: []AcknowledgedFile{{RelativePath: "a", SHA256: "b"}},
	}); err == nil || !strings.Contains(err.Error(), "only supported for Codex") {
		t.Fatalf("err = %v", err)
	}
}

func readCursorFiles(t *testing.T, path string) map[string]Entry {
	t.Helper()
	cursor, err := Read(path, "codex")
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return cursor.Files
}
