package codex

import (
	"encoding/json"
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

// The homes are absolute paths, and "absolute" means something different on
// Windows (a drive letter is required), so the fixtures are built from a temp
// directory instead of POSIX literals.
func codexHomesFixture(t *testing.T, names ...string) []string {
	t.Helper()
	root := t.TempDir()
	homes := make([]string, 0, len(names))
	for _, name := range names {
		homes = append(homes, filepath.Join(root, name, ".codex"))
	}
	return homes
}

func TestResolveHomesPrefersExplicitHomes(t *testing.T) {
	home := t.TempDir()
	explicit := codexHomesFixture(t, "work", "personal")
	homes, err := ResolveHomes(ResolveHomesInput{
		ExplicitHomes: explicit,
		HomeDir:       home,
		JSONValue:     `["` + filepath.Join(t.TempDir(), "ignored", ".codex") + `"]`,
		LegacyValue:   filepath.Join(t.TempDir(), "ignored"),
	})
	if err != nil {
		t.Fatal(err)
	}
	// Order follows the input; only the normalization is asserted.
	if !reflect.DeepEqual(homes, explicit) {
		t.Errorf("homes = %v, want %v", homes, explicit)
	}
}

func TestResolveHomesParsesTheJSONList(t *testing.T) {
	first := filepath.Join(t.TempDir(), "a", ".codex")
	second := filepath.Join(t.TempDir(), "b", ".codex")
	encoded, err := json.Marshal([]string{first, " " + second + " "})
	if err != nil {
		t.Fatal(err)
	}
	homes, err := ResolveHomes(ResolveHomesInput{
		JSONValue: string(encoded),
		HomeDir:   t.TempDir(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(homes, []string{first, second}) {
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
	first := filepath.Join(t.TempDir(), "a", ".codex")
	second := filepath.Join(t.TempDir(), "b", ".codex")
	homes, err := ResolveHomes(ResolveHomesInput{
		LegacyValue: first + "," + second,
		HomeDir:     t.TempDir(),
		FileExists:  func(string) bool { return false },
	})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(homes, []string{first, second}) {
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
	root := t.TempDir()
	first := filepath.Join(root, "a", ".codex")
	second := filepath.Join(root, "c", ".codex")
	homes, err := ResolveHomes(ResolveHomesInput{
		ExplicitHomes: []string{
			first,
			first + string(filepath.Separator),
			filepath.Join(root, "b", "..", "a", ".codex"),
			second,
		},
		HomeDir: t.TempDir(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(homes, []string{first, second}) {
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
	root := t.TempDir()
	archive := filepath.Join(root, "a", "archive")
	roots, err := NormalizeSymlinkRoots([]string{
		archive,
		archive + string(filepath.Separator),
		filepath.Join(root, "a", "..", "a", "archive"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(roots, []string{archive}) {
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
	archive := filepath.Join(t.TempDir(), "archive")
	encoded, err := json.Marshal([]string{archive})
	if err != nil {
		t.Fatal(err)
	}
	roots, err := ParseSymlinkRootsJSON(string(encoded))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(roots, []string{archive}) {
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
