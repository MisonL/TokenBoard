package sessionusage

import "testing"

// TS resolves this with `??`, so a set-but-empty TOKENBOARD_SINCE is the value
// and the run covers full history; TOKENBOARD_DEFAULT_SINCE is only consulted
// when the first variable is unset. firstNonEmpty treated the empty string as
// absent and silently applied the default window instead.
func TestReadSinceDateHonorsAnEmptySince(t *testing.T) {
	t.Setenv("TOKENBOARD_SINCE", "")
	t.Setenv("TOKENBOARD_DEFAULT_SINCE", "2026-01-01")
	got, err := ReadSinceDate("", "test")
	if err != nil {
		t.Fatal(err)
	}
	if got != "" {
		t.Errorf("since = %q, want full history", got)
	}
}

// An unset first variable falls through to the default.
func TestReadSinceDateUsesTheDefaultWhenUnset(t *testing.T) {
	t.Setenv("TOKENBOARD_DEFAULT_SINCE", "2026-01-01")
	got, err := ReadSinceDate("", "test")
	if err != nil {
		t.Fatal(err)
	}
	if got != "2026-01-01" {
		t.Errorf("since = %q, want 2026-01-01", got)
	}
}
