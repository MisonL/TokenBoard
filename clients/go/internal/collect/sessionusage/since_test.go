package sessionusage

import "testing"

// TS gives the providers `options.since ?? env.TOKENBOARD_SINCE ?? …`, but the
// CLI has already resolved that chain before the provider is reached, so the
// window that arrives here is the final one. A set-but-empty TOKENBOARD_SINCE
// therefore arrives as an empty window and means full history rather than a
// second fallback to the default.
func TestReadSinceDateUsesTheWindowItIsGiven(t *testing.T) {
	t.Setenv("TOKENBOARD_SINCE", "2026-01-01")
	if got, err := ReadSinceDate("", "test"); err != nil || got != "" {
		t.Errorf("since = %q, %v; want full history", got, err)
	}

	if got, err := ReadSinceDate("20260501", "test"); err != nil || got != "2026-05-01" {
		t.Errorf("since = %q, %v; want 2026-05-01", got, err)
	}

	if got, err := ReadSinceDate("all", "test"); err != nil || got != "" {
		t.Errorf(`since = %q, %v; "all" must mean full history`, got, err)
	}
}
