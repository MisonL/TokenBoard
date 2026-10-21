package deepseekharness

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

// With no home variable set, the TS collector scans ~/.dsh. The Go side used
// to scan ~/sessions — defaultHome returned the user's home rather than the
// tool's directory under it — so a real machine collected nothing through Go
// while TS collected everything, and the shadow gate never saw it because
// every fixture sets DSH_HOME explicitly.
func TestSessionRootDefaultsToTheDSHDirectory(t *testing.T) {
	home := t.TempDir()
	for _, key := range []string{
		"DSH_HOME", "TOKENBOARD_DSH_HOME", "DSH_SESSION_ROOT", "TOKENBOARD_DSH_SESSION_ROOT",
	} {
		clearEnv(t, key)
	}
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	if want := filepath.Join(home, ".dsh", "sessions"); sessionRoot(Options{}) != want {
		t.Errorf("sessionRoot = %q, want %q", sessionRoot(Options{}), want)
	}
}

// TS picks the home and the session root with `??`: a set-but-empty variable
// wins, and the resulting path is relative. A fallback to the default would
// scan a different tree than the TS collector for the same environment.
func TestSessionRootHonorsAnEmptyHome(t *testing.T) {
	t.Setenv("TOKENBOARD_DSH_HOME", "")
	t.Setenv("DSH_HOME", "")
	t.Setenv("TOKENBOARD_DSH_SESSION_ROOT", "")
	t.Setenv("DSH_SESSION_ROOT", "")
	if got := sessionRoot(Options{}); got != filepath.Join("", "sessions") {
		t.Errorf("sessionRoot = %q, want %q", got, filepath.Join("", "sessions"))
	}
}

// An explicit session root wins over the home, as it does in TS.
func TestSessionRootPrefersAnExplicitRoot(t *testing.T) {
	t.Setenv("TOKENBOARD_DSH_SESSION_ROOT", "/explicit/root")
	if got := sessionRoot(Options{}); got != "/explicit/root" {
		t.Errorf("sessionRoot = %q, want /explicit/root", got)
	}
}

// TS chains the TokenBoard-prefixed variable first for both the home and the
// session root.
func TestSessionRootPrefersTheTokenBoardVariables(t *testing.T) {
	t.Setenv("DSH_SESSION_ROOT", "/plain/root")
	t.Setenv("TOKENBOARD_DSH_SESSION_ROOT", "/tokenboard/root")
	if got := sessionRoot(Options{}); got != "/tokenboard/root" {
		t.Errorf("sessionRoot = %q, want /tokenboard/root", got)
	}

	t.Setenv("TOKENBOARD_DSH_SESSION_ROOT", "")
	t.Setenv("DSH_SESSION_ROOT", "")
	t.Setenv("DSH_HOME", "/plain/home")
	t.Setenv("TOKENBOARD_DSH_HOME", "/tokenboard/home")
	if want := filepath.Join("/tokenboard/home", "sessions"); sessionRoot(Options{}) != want {
		t.Errorf("sessionRoot = %q, want %q", sessionRoot(Options{}), want)
	}
}
