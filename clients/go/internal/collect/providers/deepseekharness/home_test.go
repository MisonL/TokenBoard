package deepseekharness

import (
	"path/filepath"
	"testing"
)

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
