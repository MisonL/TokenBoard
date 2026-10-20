package cli

import (
	"os"
	"testing"
)

// TS resolves these with `??`: a flag given an empty value is the value, and
// the run then fails the required-config check. firstNonEmpty fell through to
// the environment, so `--endpoint ""` silently used whatever the scheduler had
// exported — a different server than the operator asked for.
func TestAnEmptyEndpointFlagDoesNotFallThrough(t *testing.T) {
	t.Setenv("TOKENBOARD_ENDPOINT", "https://scheduler.example/api/v1/ingest")
	options, err := parseArgs([]string{"sync", "--endpoint", ""}, func(string) string { return "" })
	if err != nil {
		t.Fatalf("parseArgs: %v", err)
	}
	if options.Endpoint != "" {
		t.Errorf("endpoint = %q, want the empty flag value", options.Endpoint)
	}
	if missing := requiredSyncConfig(options); len(missing) == 0 {
		t.Error("an empty endpoint must count as missing configuration")
	}
}

func TestAnEmptyTokenFlagDoesNotFallThrough(t *testing.T) {
	t.Setenv("TOKENBOARD_UPLOAD_TOKEN", "scheduler-token")
	options, err := parseArgs([]string{"sync", "--token", ""}, func(string) string { return "" })
	if err != nil {
		t.Fatalf("parseArgs: %v", err)
	}
	if options.UploadToken != "" {
		t.Errorf("token = %q, want the empty flag value", options.UploadToken)
	}
}

// --since combines both rules: the flag is adopted by `??` when given (an
// empty flag stays empty), and the environment chain behind it uses `||`, so
// empty variables fall through to TOKENBOARD_DEFAULT_SINCE.
func TestSinceFlagIsAdoptedWhenGiven(t *testing.T) {
	t.Setenv("TOKENBOARD_SINCE", "")
	t.Setenv("TOKENBOARD_DEFAULT_SINCE", "2026-01-01")
	options, err := parseArgs([]string{"sync", "--since", ""}, func(string) string { return "" })
	if err != nil {
		t.Fatalf("parseArgs: %v", err)
	}
	if options.Since != "" {
		t.Errorf("since = %q, want the empty flag value", options.Since)
	}
}

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
