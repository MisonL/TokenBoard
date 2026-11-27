package cli

import (
	"bytes"
	"strings"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/upload"
)

// An unrecognized status is a server-supplied string kept verbatim in the log line; a
// control character in it would forge entries in the sync log, and an unbounded one
// would bloat it. Both must be neutralized before the message is built (the TS
// collector pins the same behaviour in cli.test.ts).
func TestReportWithheldOutcomesSanitizesStatuses(t *testing.T) {
	var buffer bytes.Buffer
	reportWithheldOutcomes(&buffer, []upload.WithheldSnapshot{
		{Status: "st\nale"},
		{Status: strings.Repeat("z", 40)},
	})

	out := buffer.String()
	if got := strings.Count(out, "\n"); got != 1 {
		t.Fatalf("output spans %d lines, want a single summary line:\n%s", got, out)
	}
	if !strings.Contains(out, "st_ale x1") {
		t.Fatalf("newline injection not neutralized:\n%s", out)
	}
	if !strings.Contains(out, strings.Repeat("z", 32)+" x1") {
		t.Fatalf("long status not truncated to 32 runes:\n%s", out)
	}
	if strings.Contains(out, strings.Repeat("z", 33)) {
		t.Fatalf("status longer than 32 runes leaked:\n%s", out)
	}
}

// `stale` is the only status that means the server holds a newer measurement — which on
// a working clock cannot happen. The clock hint must fire for exactly that status, and
// `st_ale` (a sanitized unrecognized value) must not stand in for it.
func TestReportWithheldOutcomesWarnsOnlyForStale(t *testing.T) {
	var plain bytes.Buffer
	reportWithheldOutcomes(&plain, []upload.WithheldSnapshot{{Status: "quarantined"}})
	if strings.Contains(plain.String(), "check this machine") {
		t.Fatalf("non-stale status raised the clock warning:\n%s", plain.String())
	}

	var stale bytes.Buffer
	reportWithheldOutcomes(&stale, []upload.WithheldSnapshot{{Status: "stale"}})
	if !strings.Contains(stale.String(), "check this machine") {
		t.Fatalf("stale status did not raise the clock warning:\n%s", stale.String())
	}
}

func TestSanitizeOutcomeStatus(t *testing.T) {
	for input, want := range map[string]string{
		"stale":                 "stale",
		"protected":             "protected",
		"st\nale":               "st_ale",
		"tab\tand space status": "tab_and_space_status",
		"quarantined":           "quarantined",
		strings.Repeat("z", 40): strings.Repeat("z", 32),
	} {
		if got := sanitizeOutcomeStatus(input); got != want {
			t.Errorf("sanitizeOutcomeStatus(%q) = %q, want %q", input, got, want)
		}
	}
}
