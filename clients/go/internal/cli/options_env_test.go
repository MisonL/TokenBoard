package cli

import (
	"bytes"
	"strings"
	"testing"
)

// TS resolves the source with `??`, which only falls back on an unset value:
// an empty string is a value, and readSource rejects it. firstNonEmpty treated
// "" as unset and collected `all` instead, so a machine with
// `TOKENBOARD_SOURCE=` exported ran successfully here and exited with an error
// there. The two clients must agree on whether a run is well-formed.
func TestEmptySourceIsRejectedLikeTS(t *testing.T) {
	// The lookup cannot tell "unset" from "empty"; the implementation is what
	// has to, so this pins the empty case.
	empty := func(string) string { return "" }
	if _, err := parseArgs([]string{"preview", "--source", ""}, empty); err == nil {
		t.Error("an explicitly empty --source must be rejected")
	}
}

// An unset variable still takes the default: that is the case the fallback
// exists for. A lookup returning "" for a key is indistinguishable from unset
// through this type, so the default must survive.
func TestUnsetSourceTakesTheDefault(t *testing.T) {
	options, err := parseArgs([]string{"preview"}, func(string) string { return "" })
	if err != nil {
		t.Fatalf("parseArgs with nothing set: %v", err)
	}
	if options.Source != "all" {
		t.Errorf("source = %q, want all", options.Source)
	}
}

// The distinction only exists in the process environment, so this exercises
// Run rather than the injected form: an exported-but-empty variable is set,
// and TS rejects it instead of collecting everything.
func TestExportedEmptySourceIsAnError(t *testing.T) {
	t.Setenv("TOKENBOARD_STATE_DIR", t.TempDir())
	t.Setenv("TOKENBOARD_SOURCE", "")
	var stdout, stderr bytes.Buffer
	code := Run([]string{"preview"}, &stdout, &stderr)
	if code != ExitUsage {
		t.Fatalf("exit = %d, want %d; stderr: %s", code, ExitUsage, stderr.String())
	}
	if !strings.Contains(stderr.String(), "Invalid source") {
		t.Errorf("stderr = %q, want an invalid-source message", stderr.String())
	}
}

func TestExportedEmptyTimezoneIsAnError(t *testing.T) {
	t.Setenv("TOKENBOARD_STATE_DIR", t.TempDir())
	t.Setenv("TOKENBOARD_TIMEZONE", "")
	var stdout, stderr bytes.Buffer
	code := Run([]string{"preview"}, &stdout, &stderr)
	if code != ExitUsage {
		t.Fatalf("exit = %d, want %d; stderr: %s", code, ExitUsage, stderr.String())
	}
	if !strings.Contains(stderr.String(), "Invalid timezone") {
		t.Errorf("stderr = %q, want an invalid-timezone message", stderr.String())
	}
}
