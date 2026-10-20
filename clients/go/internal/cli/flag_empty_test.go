package cli

import (
	"os"
	"strings"
	"testing"
)

// The TS parser rejects an empty flag value: readFlags throws "Missing value
// for --key" when the next argument is "", so `--endpoint ""` never reaches
// the `??` resolution at all.
//
// Go accepted the empty value and left each flag's own resolution to decide
// what it meant. That put the same spelling in two places with two answers:
// the CLI adopted the empty value while the providers read the environment
// again, so an explicitly empty --until still ended up bounded by
// TOKENBOARD_UNTIL. The parser now refuses the empty value, which is where
// the two sides actually disagree.
func TestAnEmptyFlagValueIsAUsageError(t *testing.T) {
	cases := []struct {
		flag string
		args []string
	}{
		{flag: "endpoint", args: []string{"sync", "--endpoint", ""}},
		{flag: "token", args: []string{"sync", "--token", ""}},
		{flag: "since", args: []string{"sync", "--since", ""}},
		{flag: "until", args: []string{"sync", "--source", "claude-code", "--until", ""}},
	}
	for _, testCase := range cases {
		_, err := parseArgs(testCase.args, os.Getenv)
		if err == nil {
			t.Errorf("parseArgs(%v) must fail", testCase.args)
			continue
		}
		if !strings.Contains(err.Error(), "Missing value for --"+testCase.flag) {
			t.Errorf("parseArgs(%v) = %v, want a missing-value error", testCase.args, err)
		}
	}
}

// The Go extension `--key=value` follows the same rule: an empty value is not
// a value, so it is refused the same way.
func TestAnEmptyKeyValueFormIsAUsageError(t *testing.T) {
	_, err := parseArgs([]string{"sync", "--endpoint="}, os.Getenv)
	if err == nil || !strings.Contains(err.Error(), "Missing value for --endpoint") {
		t.Fatalf("err = %v, want a missing-value error", err)
	}
}

// A flag with a real value is still adopted over the environment.
func TestAFlagWithAValueIsAdoptedOverTheEnvironment(t *testing.T) {
	t.Setenv("TOKENBOARD_ENDPOINT", "https://scheduler.example/api/v1/ingest")
	t.Setenv("TOKENBOARD_UPLOAD_TOKEN", "scheduler-token")
	t.Setenv("TOKENBOARD_SINCE", "20260101")
	options, err := parseArgs(
		[]string{"sync", "--endpoint", "https://operator.example/api/v1/ingest", "--token", "operator-token", "--since", "20260202"},
		os.Getenv,
	)
	if err != nil {
		t.Fatalf("parseArgs: %v", err)
	}
	if options.Endpoint != "https://operator.example/api/v1/ingest" {
		t.Errorf("endpoint = %q", options.Endpoint)
	}
	if options.UploadToken != "operator-token" {
		t.Errorf("token = %q", options.UploadToken)
	}
	if options.Since != "20260202" {
		t.Errorf("since = %q", options.Since)
	}
}

// The environment chain behind --since uses ordinary fallback, so an empty
// TOKENBOARD_SINCE falls through to TOKENBOARD_DEFAULT_SINCE.
func TestSinceEnvironmentChainUsesOrdinaryFallback(t *testing.T) {
	t.Setenv("TOKENBOARD_SINCE", "")
	t.Setenv("TOKENBOARD_DEFAULT_SINCE", "2026-01-01")
	options, err := parseArgs([]string{"sync"}, os.Getenv)
	if err != nil {
		t.Fatalf("parseArgs: %v", err)
	}
	if options.Since != "2026-01-01" {
		t.Errorf("since = %q, want the environment default", options.Since)
	}
}

// End to end: the rejection is the exit code the user sees, not just a parse
// error. A TOKENBOARD_UNTIL beside the empty flag must not rescue it either —
// that was the divergence this whole fix exists to close.
func TestAnEmptyFlagValueExitsWithUsageAndIgnoresTheEnvironment(t *testing.T) {
	code, stdout, stderr := run(t, map[string]string{
		"TOKENBOARD_UNTIL":    "20260131",
		"TOKENBOARD_ENDPOINT": "https://example.invalid/ingest",
		"TOKENBOARD_TOKEN":    "token",
	}, "sync", "--source", "claude-code", "--until", "")
	if code != ExitUsage {
		t.Errorf("exit = %d, want %d; stderr: %s", code, ExitUsage, stderr)
	}
	if !strings.Contains(stderr, "Missing value for --until") {
		t.Errorf("stderr = %q, want the missing-value message", stderr)
	}
	if stdout != "" {
		t.Errorf("stdout = %q, want nothing on a usage error", stdout)
	}
}
