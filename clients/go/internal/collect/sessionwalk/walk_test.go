package sessionwalk

// Ports packages/collector/src/providers/session-file-walk.test.ts. The walker
// enumerates a tree another program owns, so the tests pin the same three
// properties the TS suite pins: the stable relative ordering, the ceilings
// (depth and per-directory entries), and the symlink refusals.

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
)

func writeFixtureFile(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("create fixture directory: %v", err)
	}
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatalf("write fixture file: %v", err)
	}
}

func requirePaths(t *testing.T, got []string, want ...string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("paths = %q, want %q", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("paths = %q, want %q", got, want)
		}
	}
}

func TestResolveReturnsNoFilesWhenTheRootDirectoryDisappears(t *testing.T) {
	root := t.TempDir()
	if err := os.RemoveAll(root); err != nil {
		t.Fatalf("remove root: %v", err)
	}

	files, ok, err := Resolve(root, Options{})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if ok {
		t.Fatal("a missing root must report the source as unavailable")
	}
	if len(files.Paths) != 0 {
		t.Fatalf("paths = %q, want none", files.Paths)
	}
}

func TestResolveWalksNestedJSONLPathsInStableRelativeOrder(t *testing.T) {
	root := t.TempDir()
	// Written in reverse order so the result cannot come from the directory
	// listing's own order.
	writeFixtureFile(t, filepath.Join(root, "b.jsonl"))
	writeFixtureFile(t, filepath.Join(root, "a.jsonl"))

	files, ok, err := Resolve(root, Options{})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if !ok {
		t.Fatal("root must resolve")
	}
	requirePaths(t, files.Paths, "a.jsonl", "b.jsonl")
}

func TestResolvePreservesLiteralBackslashesInPOSIXSessionFileNames(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows treats a backslash as a path separator, so this file name cannot exist there")
	}
	root := t.TempDir()
	writeFixtureFile(t, filepath.Join(root, `literal\name.jsonl`))

	files, ok, err := Resolve(root, Options{})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if !ok {
		t.Fatal("root must resolve")
	}
	requirePaths(t, files.Paths, `literal\name.jsonl`)
}

func TestResolveOrdersNestedAndSiblingJSONLPathsByCompleteRelativePath(t *testing.T) {
	root := t.TempDir()
	writeFixtureFile(t, filepath.Join(root, "a", "nested.jsonl"))
	writeFixtureFile(t, filepath.Join(root, "a.jsonl"))

	files, ok, err := Resolve(root, Options{})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if !ok {
		t.Fatal("root must resolve")
	}
	// "a.jsonl" sorts before the directory's "a/" sort key.
	requirePaths(t, files.Paths, "a.jsonl", "a/nested.jsonl")
}

func TestResolveRecursesIntoDirectoriesWhoseNamesEndWithJSONL(t *testing.T) {
	root := t.TempDir()
	writeFixtureFile(t, filepath.Join(root, "sessions.jsonl", "nested.jsonl"))

	files, ok, err := Resolve(root, Options{})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if !ok {
		t.Fatal("root must resolve")
	}
	requirePaths(t, files.Paths, "sessions.jsonl/nested.jsonl")
}

func TestResolveAllowsACallerSuppliedSymbolicLinkRoot(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("creating a symlink on Windows needs developer mode or an elevated process")
	}
	root := t.TempDir()
	outside := filepath.Join(root, "outside")
	linkedRoot := filepath.Join(root, "linked-root")
	writeFixtureFile(t, filepath.Join(outside, "outside.jsonl"))
	if err := os.Symlink(outside, linkedRoot); err != nil {
		t.Fatalf("create symlink: %v", err)
	}

	files, ok, err := Resolve(linkedRoot, Options{})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if !ok {
		t.Fatal("a caller-supplied symlinked root must resolve")
	}
	requirePaths(t, files.Paths, "outside.jsonl")
}

func TestResolveRejectsSymbolicLinkEntriesBelowASessionRoot(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("creating a symlink on Windows needs developer mode or an elevated process")
	}
	root := t.TempDir()
	outside := filepath.Join(root, "outside")
	writeFixtureFile(t, filepath.Join(outside, "outside.jsonl"))
	if err := os.Symlink(filepath.Join(outside, "outside.jsonl"), filepath.Join(root, "linked.jsonl")); err != nil {
		t.Fatalf("create symlink: %v", err)
	}

	_, _, err := Resolve(root, Options{})
	if err == nil {
		t.Fatal("a symlink below the session root must be refused")
	}
	if !regexp.MustCompile(`(?i)session entry.*symbolic links`).MatchString(err.Error()) {
		t.Fatalf("error = %q, want the session-entry symlink refusal", err.Error())
	}
}

// The codex/claude session tree lives outside TokenBoard's control, and every
// sibling scanner caps what it will walk (bounded-session-scan: depth 8;
// antigravity: 10k entries). This walker had neither — a symlink cycle it
// already rejects, but a deliberately deep tree or an unbounded directory
// listing had no ceiling at all.
func TestResolveStopsDescendingPastTheDepthCap(t *testing.T) {
	root := t.TempDir()
	// Depth 9: the cap is 8 levels below the root, so the ninth directory must
	// be refused rather than recursed into.
	current := root
	for level := 1; level <= 9; level++ {
		current = filepath.Join(current, fmt.Sprintf("d%d", level))
		if err := os.Mkdir(current, 0o700); err != nil {
			t.Fatalf("create depth fixture: %v", err)
		}
	}
	writeFixtureFile(t, filepath.Join(current, "deep.jsonl"))

	_, _, err := Resolve(root, Options{MaxDepth: 8})
	if err == nil {
		t.Fatal("a tree deeper than the cap must be refused")
	}
	if !strings.Contains(strings.ToLower(err.Error()), "depth") {
		t.Fatalf("error = %q, want the depth-limit refusal", err.Error())
	}
}

func TestResolveYieldsFilesExactlyAtTheDepthCap(t *testing.T) {
	root := t.TempDir()
	current := root
	for level := 1; level <= 8; level++ {
		current = filepath.Join(current, fmt.Sprintf("d%d", level))
		if err := os.Mkdir(current, 0o700); err != nil {
			t.Fatalf("create depth fixture: %v", err)
		}
	}
	writeFixtureFile(t, filepath.Join(current, "at-cap.jsonl"))

	files, ok, err := Resolve(root, Options{MaxDepth: 8})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if !ok {
		t.Fatal("root must resolve")
	}
	requirePaths(t, files.Paths, "d1/d2/d3/d4/d5/d6/d7/d8/at-cap.jsonl")
}

func TestResolveStopsListingOnceASingleDirectoryExceedsTheEntryCap(t *testing.T) {
	root := t.TempDir()
	writeFixtureFile(t, filepath.Join(root, "a.jsonl"))
	writeFixtureFile(t, filepath.Join(root, "b.jsonl"))
	writeFixtureFile(t, filepath.Join(root, "c.jsonl"))
	writeFixtureFile(t, filepath.Join(root, "extra", "d.jsonl"))

	// The root listing holds four entries; a cap of three must fail the walk
	// rather than silently truncate its result. The cap is per directory, so a
	// cap of four admits both the root listing and the smaller nested one.
	_, _, err := Resolve(root, Options{MaxEntries: 3})
	if err == nil {
		t.Fatal("a listing past the entry cap must be refused")
	}
	if !strings.Contains(strings.ToLower(err.Error()), "entr") {
		t.Fatalf("error = %q, want the entry-limit refusal", err.Error())
	}

	files, ok, err := Resolve(root, Options{MaxEntries: 4})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if !ok {
		t.Fatal("root must resolve")
	}
	requirePaths(t, files.Paths, "a.jsonl", "b.jsonl", "c.jsonl", "extra/d.jsonl")
}

// The default ceilings are what protect a real session tree; the options above
// are only a test seam, so the signed-off values are asserted directly.
func TestDefaultWalkBounds(t *testing.T) {
	if MaxWalkDepth != 8 {
		t.Errorf("MaxWalkDepth = %d, want 8", MaxWalkDepth)
	}
	if MaxWalkEntries != 10_000 {
		t.Errorf("MaxWalkEntries = %d, want 10000", MaxWalkEntries)
	}
}
