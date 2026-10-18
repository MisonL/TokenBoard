package codex

// Port of codex-subagent-usage-paths.test.ts.

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

func TestRejectsASymbolicLinkChildSessionBeforeReadingIt(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symbolic links are not portable on Windows")
	}
	home := t.TempDir()
	outsideDir := t.TempDir()
	outsideFile := filepath.Join(outsideDir, "outside-child.jsonl")
	linkedFile := filepath.Join(home, "sessions", "2026", "05", "25", "rollout-child-thread.jsonl")
	writeJSONL(t, outsideFile, []map[string]any{
		subagentChildSessionMeta("child-thread", "parent-thread", "2026-05-25T01:00:00.000Z"),
	})
	if err := os.MkdirAll(filepath.Dir(linkedFile), 0o755); err != nil {
		t.Fatalf("mkdir sessions tree: %v", err)
	}
	if err := os.Symlink(outsideFile, linkedFile); err != nil {
		t.Fatalf("symlink child: %v", err)
	}

	reads := 0
	_, err := ApplyCodexSubagentUsageCorrections(subagentPathInput(home, func() {
		reads++
	}))
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "symbolic links are not supported") {
		t.Fatalf("error = %v, want a symbolic-link rejection", err)
	}
	if reads != 0 {
		t.Fatalf("child reads = %d, want 0", reads)
	}
}

func TestRejectsAnIntermediateSymbolicLinkBeforeReadingAChildSession(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symbolic links are not portable on Windows")
	}
	home := t.TempDir()
	outsideDir := t.TempDir()
	outsideFile := filepath.Join(outsideDir, "05", "25", "rollout-child-thread.jsonl")
	linkedDirectory := filepath.Join(home, "sessions", "2026")
	writeJSONL(t, outsideFile, []map[string]any{
		subagentChildSessionMeta("child-thread", "parent-thread", "2026-05-25T01:00:00.000Z"),
	})
	if err := os.MkdirAll(filepath.Join(home, "sessions"), 0o755); err != nil {
		t.Fatalf("mkdir sessions: %v", err)
	}
	if err := os.Symlink(outsideDir, linkedDirectory); err != nil {
		t.Fatalf("symlink directory: %v", err)
	}

	reads := 0
	_, err := ApplyCodexSubagentUsageCorrections(subagentPathInput(home, func() {
		reads++
	}))
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "symbolic links are not supported") {
		t.Fatalf("error = %v, want a symbolic-link rejection", err)
	}
	if reads != 0 {
		t.Fatalf("child reads = %d, want 0", reads)
	}
}

func TestReadsAnAllowedRootSymlinkThroughItsValidatedTarget(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symbolic links are not portable on Windows")
	}
	home := t.TempDir()
	targetRoot := t.TempDir()
	linkedRoot := filepath.Join(home, "archived_sessions")
	targetFile := filepath.Join(targetRoot, "2026", "05", "25", "rollout-child-thread.jsonl")
	writeJSONL(t, targetFile, []map[string]any{
		subagentChildSessionMeta("child-thread", "parent-thread", "2026-05-25T01:00:00.000Z"),
	})
	if err := os.Symlink(targetRoot, linkedRoot); err != nil {
		t.Fatalf("symlink root: %v", err)
	}

	reads := []string{}
	got := subagentApply(t, SubagentCorrectionInput{
		Snapshots:         []contract.Snapshot{subagentCodexSnapshot()},
		Sessions:          subagentInheritedSessionResult(),
		CodexHomes:        []string{home},
		Timezone:          "Asia/Shanghai",
		CodexSymlinkRoots: []string{targetRoot},
		ReadChildUsageByDate: func(filePath, _, _ string, _ func(string), _ string) ([]DatedUsage, error) {
			reads = append(reads, filePath)
			return nil, nil
		},
	})

	resolvedTarget, err := filepath.EvalSymlinks(targetFile)
	if err != nil {
		t.Fatalf("realpath target: %v", err)
	}
	if len(reads) != 1 || reads[0] != resolvedTarget {
		t.Fatalf("child reads = %v, want [%s]", reads, resolvedTarget)
	}
	// The read returned no usage, so the snapshot is untouched.
	subagentAssertSnapshot(t, got[0], subagentExpectedSnapshot{
		Input: 1100, Output: 120, CacheRead: 1950, Total: 3170,
	})
}

func subagentPathInput(home string, onRead func()) SubagentCorrectionInput {
	return SubagentCorrectionInput{
		Snapshots:  []contract.Snapshot{subagentCodexSnapshot()},
		Sessions:   subagentInheritedSessionResult(),
		CodexHomes: []string{home},
		Timezone:   "Asia/Shanghai",
		ReadChildUsageByDate: func(string, string, string, func(string), string) ([]DatedUsage, error) {
			onRead()
			return nil, nil
		},
	}
}
