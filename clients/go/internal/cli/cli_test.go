package cli

import (
	"bytes"
	"strings"
	"testing"
)

func run(t *testing.T, args ...string) (int, string, string) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	code := Run(args, &stdout, &stderr)
	return code, stdout.String(), stderr.String()
}

func TestVersionExitsOK(t *testing.T) {
	code, stdout, _ := run(t, "version")
	if code != ExitOK {
		t.Errorf("version exit = %d, want 0", code)
	}
	if !strings.Contains(stdout, "tokenboard") {
		t.Errorf("version output %q lacks name", stdout)
	}
}

func TestUnknownCommandIsUsageError(t *testing.T) {
	code, _, stderr := run(t, "nonsense")
	if code != ExitUsage {
		t.Errorf("exit = %d, want %d", code, ExitUsage)
	}
	if !strings.Contains(stderr, "unknown command") {
		t.Errorf("stderr %q lacks diagnosis", stderr)
	}
}

func TestNoArgsShowsUsageOnStderr(t *testing.T) {
	code, stdout, stderr := run(t)
	if code != ExitUsage {
		t.Errorf("exit = %d, want %d", code, ExitUsage)
	}
	if stdout != "" {
		t.Errorf("usage must go to stderr, got stdout %q", stdout)
	}
	if !strings.Contains(stderr, "usage:") {
		t.Errorf("stderr %q lacks usage", stderr)
	}
}
