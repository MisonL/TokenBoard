package codex

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// Port of the homes/symlink-roots half of the TS Codex suites: which Codex
// homes a run reads, and which symlinked roots it may follow.

func TestResolveHomesUsesTheDefaultWhenNothingIsConfigured(t *testing.T) {
	home := t.TempDir()
	homes, err := ResolveHomes(ResolveHomesInput{HomeDir: home})
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(home, ".codex")
	if !reflect.DeepEqual(homes, []string{want}) {
		t.Errorf("homes = %v, want [%s]", homes, want)
	}
}

func TestResolveHomesPrefersExplicitHomes(t *testing.T) {
	home := t.TempDir()
	homes, err := ResolveHomes(ResolveHomesInput{
		ExplicitHomes: []string{"/work/.codex", "/personal/.codex"},
		HomeDir:       home,
		JSONValue:     `["/ignored/.codex"]`,
		LegacyValue:   "/ignored",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"/personal/.codex", "/work/.codex"}
	// Order follows the input; only the normalization is asserted.
	if !reflect.DeepEqual(homes, []string{"/work/.codex", "/personal/.codex"}) {
		t.Errorf("homes = %v, want %v", homes, want)
	}
}

func TestResolveHomesParsesTheJSONList(t *testing.T) {
	homes, err := ResolveHomes(ResolveHomesInput{
		JSONValue: `["/a/.codex", " /b/.codex "]`,
		HomeDir:   t.TempDir(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(homes, []string{"/a/.codex", "/b/.codex"}) {
		t.Errorf("homes = %v", homes)
	}
}

func TestResolveHomesRejectsMalformedJSON(t *testing.T) {
	cases := []string{
		`not json`,
		`[]`,
		`[""]`,
		`[1]`,
		`{"homes":["/a"]}`,
	}
	for _, value := range cases {
		if _, err := ResolveHomes(ResolveHomesInput{JSONValue: value, HomeDir: t.TempDir()}); err == nil {
			t.Errorf("ResolveHomes(%q) must fail", value)
		}
	}
}

func TestResolveHomesSplitsTheLegacyCommaList(t *testing.T) {
	homes, err := ResolveHomes(ResolveHomesInput{
		LegacyValue: "/a/.codex,/b/.codex",
		HomeDir:     t.TempDir(),
		FileExists:  func(string) bool { return false },
	})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(homes, []string{"/a/.codex", "/b/.codex"}) {
		t.Errorf("homes = %v", homes)
	}
}

// A path that genuinely contains a comma cannot be told apart from the list
// separator, so the run refuses rather than guessing.
func TestResolveHomesRejectsAnAmbiguousCommaPath(t *testing.T) {
	commaPath := "/tmp/a,b/.codex"
	_, err := ResolveHomes(ResolveHomesInput{
		LegacyValue: commaPath,
		HomeDir:     t.TempDir(),
		FileExists:  func(path string) bool { return path == commaPath },
	})
	if err == nil || !strings.Contains(err.Error(), "CODEX_HOME is ambiguous") {
		t.Fatalf("err = %v", err)
	}
}

func TestResolveHomesDedupesAndNormalizes(t *testing.T) {
	homes, err := ResolveHomes(ResolveHomesInput{
		ExplicitHomes: []string{"/a/.codex", "/a/.codex/", "/b/../a/.codex", "/c/.codex"},
		HomeDir:       t.TempDir(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(homes, []string{"/a/.codex", "/c/.codex"}) {
		t.Errorf("homes = %v", homes)
	}
}

func TestResolveHomesFallsBackWhenEveryEntryIsBlank(t *testing.T) {
	home := t.TempDir()
	homes, err := ResolveHomes(ResolveHomesInput{ExplicitHomes: []string{"  ", ""}, HomeDir: home})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(homes, []string{filepath.Join(home, ".codex")}) {
		t.Errorf("homes = %v", homes)
	}
}

func TestNormalizeSymlinkRootsRejectsRelativePaths(t *testing.T) {
	_, err := NormalizeSymlinkRoots([]string{"relative/archive"})
	if err == nil || !strings.Contains(err.Error(), "expected absolute paths") {
		t.Fatalf("err = %v", err)
	}
}

func TestNormalizeSymlinkRootsRejectsEmptyLists(t *testing.T) {
	if _, err := NormalizeSymlinkRoots([]string{}); err == nil {
		t.Fatal("an empty list must be rejected")
	}
	if _, err := NormalizeSymlinkRoots([]string{"  "}); err == nil {
		t.Fatal("a blank entry must be rejected")
	}
	roots, err := NormalizeSymlinkRoots(nil)
	if err != nil || roots != nil {
		t.Errorf("nil must mean unset: %v, %v", roots, err)
	}
}

func TestNormalizeSymlinkRootsDedupesAndResolves(t *testing.T) {
	roots, err := NormalizeSymlinkRoots([]string{"/a/archive", "/a/archive/", "/a/../a/archive"})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(roots, []string{"/a/archive"}) {
		t.Errorf("roots = %v", roots)
	}
}

func TestParseSymlinkRootsJSONRejectsBadValues(t *testing.T) {
	if _, err := ParseSymlinkRootsJSON(`not json`); err == nil {
		t.Fatal("invalid JSON must fail")
	}
	if _, err := ParseSymlinkRootsJSON(`"a string"`); err == nil {
		t.Fatal("a non-array must fail")
	}
	roots, err := ParseSymlinkRootsJSON(`["/archive"]`)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(roots, []string{"/archive"}) {
		t.Errorf("roots = %v", roots)
	}
}

// The homes resolver must not follow symlinks: a profile home that is itself
// a symlink is the provider's business, not the resolver's.
func TestResolveHomesKeepsTheConfiguredPath(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "real-home")
	if err := os.MkdirAll(target, 0o700); err != nil {
		t.Fatal(err)
	}
	linked := filepath.Join(root, "linked-home")
	if err := os.Symlink(target, linked); err != nil {
		t.Fatal(err)
	}
	homes, err := ResolveHomes(ResolveHomesInput{ExplicitHomes: []string{linked}, HomeDir: root})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(homes, []string{linked}) {
		t.Errorf("homes = %v, want the configured symlink path", homes)
	}
}
