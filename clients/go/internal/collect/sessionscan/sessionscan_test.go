package sessionscan

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// The scanner reads roots outside TokenBoard's control, so an over-large
// directory listing must be *reported* through OnSkipped rather than loaded
// whole: a single abnormal directory must not be able to exhaust memory just
// by existing. This is the one property the TS suite covers, so it is covered
// here too; the other skip reasons are exercised through the providers.
func TestReportsADirectoryWhoseListingExceedsTheEntryCap(t *testing.T) {
	root := t.TempDir()
	overfull := filepath.Join(root, "sessions")
	if err := os.Mkdir(overfull, 0o700); err != nil {
		t.Fatal(err)
	}
	// Just past the cap: the scan must stop at the boundary rather than read
	// the whole listing into memory before sorting it. The cap is lowered for
	// the test so it does not have to create MaxScanDirectoryEntries files.
	const cap = 16
	for index := 0; index <= cap; index++ {
		name := filepath.Join(overfull, fmt.Sprintf("%05d.jsonl", index))
		if err := os.WriteFile(name, []byte("{}\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	var skipped []string
	err := Scan(root, Options{
		Matches:             func(string) bool { return true },
		MaxDirectoryEntries: cap,
		OnSkipped:           func(_, reason string) { skipped = append(skipped, reason) },
	}, func(ScannedSessionFile) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	if len(skipped) != 1 || skipped[0] != "max-entries" {
		t.Fatalf("skipped = %v, want [max-entries]", skipped)
	}
}

// The default cap is what protects a real home directory; the option above is
// only a test seam, so the signed-off value is asserted directly.
func TestDefaultScanBounds(t *testing.T) {
	if MaxScanDirectoryEntries != 10_000 {
		t.Errorf("MaxScanDirectoryEntries = %d, want 10000", MaxScanDirectoryEntries)
	}
	if MaxScanDepth != 8 {
		t.Errorf("MaxScanDepth = %d, want 8", MaxScanDepth)
	}
	if MaxSessionFileBytes != 256*1024*1024 {
		t.Errorf("MaxSessionFileBytes = %d, want %d", MaxSessionFileBytes, 256*1024*1024)
	}
}

// Depth and symlink handling are what keep a root outside TokenBoard's control
// from recursing forever; a cycle is the sharpest case.
func TestDoesNotFollowSymlinkedDirectories(t *testing.T) {
	root := t.TempDir()
	if err := os.Symlink(root, filepath.Join(root, "loop")); err != nil {
		t.Skip("directory symlinks unavailable")
	}
	filePath := filepath.Join(root, "session.jsonl")
	if err := os.WriteFile(filePath, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	var files []string
	var skipped []string
	err := Scan(root, Options{
		Matches:   func(name string) bool { return name == "session.jsonl" },
		OnSkipped: func(_, reason string) { skipped = append(skipped, reason) },
	}, func(file ScannedSessionFile) error {
		files = append(files, filepath.Base(file.Path))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 1 || files[0] != "session.jsonl" {
		t.Fatalf("files = %v, want [session.jsonl]", files)
	}
	if len(skipped) != 1 || skipped[0] != "symlink" {
		t.Fatalf("skipped = %v, want [symlink]", skipped)
	}
}

// Entries are visited by name so a repeated scan reports its diagnostics in a
// stable order; a map iteration order would make the skip trace irreproducible.
func TestVisitsEntriesInNameOrder(t *testing.T) {
	root := t.TempDir()
	names := []string{"c.jsonl", "a.jsonl", "b.jsonl", "a-sub"}
	for _, name := range names {
		if name == "a-sub" {
			if err := os.Mkdir(filepath.Join(root, name), 0o700); err != nil {
				t.Fatal(err)
			}
			continue
		}
		if err := os.WriteFile(filepath.Join(root, name), []byte("{}\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	var visited []string
	err := Scan(root, Options{
		Matches:   func(name string) bool { return strings.HasSuffix(name, ".jsonl") },
		OnSkipped: func(string, string) {},
	}, func(file ScannedSessionFile) error {
		visited = append(visited, filepath.Base(file.Path))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(visited) != 3 || visited[0] != "a.jsonl" || visited[1] != "b.jsonl" || visited[2] != "c.jsonl" {
		t.Fatalf("visited = %v, want [a.jsonl b.jsonl c.jsonl]", visited)
	}
}

// A missing root is not an error: the tool simply is not installed, and the
// provider reports that as "no sessions", not as a scan failure.
func TestTreatsAMissingRootAsNoFiles(t *testing.T) {
	var visited int
	err := Scan(filepath.Join(t.TempDir(), "absent"), Options{
		Matches:   func(string) bool { return true },
		OnSkipped: func(string, string) {},
	}, func(ScannedSessionFile) error { visited++; return nil })
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if visited != 0 {
		t.Errorf("visited = %d, want 0", visited)
	}
}

// An unreadable directory is skipped but never silently: a whole root that
// is unreadable would otherwise look like an uninstalled tool and its usage
// would vanish without a trace.
func TestReportsAnUnreadableDirectoryInsteadOfSkippingItSilently(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("chmod 0o000 does not deny directory listing on Windows")
	}
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "session.jsonl"), []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	locked := filepath.Join(root, "locked")
	if err := os.Mkdir(locked, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(locked, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(locked, 0o700) })

	var skipped []string
	var visited int
	err := Scan(root, Options{
		Matches:   func(name string) bool { return name == "session.jsonl" },
		OnSkipped: func(_, reason string) { skipped = append(skipped, reason) },
	}, func(ScannedSessionFile) error { visited++; return nil })
	if err != nil {
		t.Fatal(err)
	}
	if visited != 1 {
		t.Errorf("visited = %d, want 1", visited)
	}
	if len(skipped) != 1 || skipped[0] != "unreadable" {
		t.Fatalf("skipped = %v, want [unreadable]", skipped)
	}
}

// Oversized files are skipped with their reason, so a single pathological
// session cannot make the scan load it whole.
func TestReportsAnOversizedFileInsteadOfVisitingIt(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "session.jsonl"), []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	huge := filepath.Join(root, "huge.jsonl")
	if err := os.WriteFile(huge, []byte(strings.Repeat("x", 32)), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(huge, MaxSessionFileBytes+1); err != nil {
		t.Fatal(err)
	}

	var skipped []string
	var visited []string
	err := Scan(root, Options{
		Matches:   func(string) bool { return true },
		OnSkipped: func(_, reason string) { skipped = append(skipped, reason) },
	}, func(file ScannedSessionFile) error {
		visited = append(visited, filepath.Base(file.Path))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(visited) != 1 || visited[0] != "session.jsonl" {
		t.Fatalf("visited = %v, want [session.jsonl]", visited)
	}
	if len(skipped) != 1 || skipped[0] != "max-size" {
		t.Fatalf("skipped = %v, want [max-size]", skipped)
	}
}
