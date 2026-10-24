package grokbuild

import (
	"os"
	"path/filepath"
	"testing"
)

// clearEnv unsets a variable for the duration of the test. t.Setenv cannot
// express "unset", and the default-home path only runs when the variable is
// genuinely absent: an exported-but-empty one is a home of its own.
func clearEnv(t *testing.T, key string) {
	t.Helper()
	value, had := os.LookupEnv(key)
	if err := os.Unsetenv(key); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if had {
			_ = os.Setenv(key, value)
		} else {
			_ = os.Unsetenv(key)
		}
	})
}

// With no home variable set, the TS collector scans ~/.grok. The Go side used
// to scan ~/sessions — defaultHome returned the user's home rather than the
// tool's directory under it — so a real machine collected nothing through Go
// while TS collected everything, and the shadow gate never saw it because
// every fixture sets GROK_HOME explicitly.
func TestSessionRootsDefaultToTheGrokDirectory(t *testing.T) {
	home := t.TempDir()
	clearEnv(t, "GROK_HOME")
	clearEnv(t, "TOKENBOARD_GROK_HOME")
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	roots := sessionRoots("", nil)
	want := []string{
		filepath.Join(home, ".grok", "sessions"),
		filepath.Join(home, ".grok", "archived_sessions"),
	}
	if len(roots) != len(want) {
		t.Fatalf("roots = %v, want %v", roots, want)
	}
	for index := range want {
		if roots[index] != want[index] {
			t.Errorf("roots[%d] = %q, want %q", index, roots[index], want[index])
		}
	}
}

// TS picks the home with `??`, so an exported-but-empty variable *is* the
// home: the roots resolve relative to the working directory. firstNonEmpty
// skipped it and fell back to ~/.grok, so the two clients scanned different
// trees for the same environment. The distinction only exists in the process
// environment, so this drives it through t.Setenv.
func TestSessionRootsHonorAnEmptyHome(t *testing.T) {
	t.Setenv("TOKENBOARD_GROK_HOME", "")
	t.Setenv("GROK_HOME", "")
	roots := sessionRoots("", nil)
	want := []string{filepath.Join("", "sessions"), filepath.Join("", "archived_sessions")}
	if len(roots) != len(want) {
		t.Fatalf("roots = %v, want %v", roots, want)
	}
	for index := range want {
		if roots[index] != want[index] {
			t.Errorf("roots[%d] = %q, want %q", index, roots[index], want[index])
		}
	}
}

// TS chains TOKENBOARD_GROK_HOME before GROK_HOME, so the TokenBoard-specific
// variable wins when both are set.
func TestSessionRootsPreferTheTokenBoardHome(t *testing.T) {
	t.Setenv("TOKENBOARD_GROK_HOME", "/tokenboard/grok")
	t.Setenv("GROK_HOME", "/plain/grok")
	roots := sessionRoots("", nil)
	if want := filepath.Join("/tokenboard/grok", "sessions"); roots[0] != want {
		t.Errorf("roots[0] = %q, want %q", roots[0], want)
	}
}
