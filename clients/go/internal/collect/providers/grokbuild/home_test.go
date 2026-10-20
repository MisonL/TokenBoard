package grokbuild

import (
	"path/filepath"
	"testing"
)

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
	if roots := sessionRoots("", nil); roots[0] != "/tokenboard/grok/sessions" {
		t.Errorf("roots[0] = %q, want /tokenboard/grok/sessions", roots[0])
	}
}
