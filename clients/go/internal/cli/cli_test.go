package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func run(t *testing.T, env map[string]string, args ...string) (int, string, string) {
	t.Helper()
	lookup := func(key string) string { return env[key] }
	var stdout, stderr bytes.Buffer
	code := RunWithEnv(context.Background(), args, lookup, &stdout, &stderr)
	return code, stdout.String(), stderr.String()
}

func TestVersionExitsOK(t *testing.T) {
	code, stdout, _ := run(t, nil, "version")
	if code != ExitOK || !strings.Contains(stdout, "tokenboard") {
		t.Errorf("code=%d stdout=%q", code, stdout)
	}
}

func TestUnknownCommandIsUsageError(t *testing.T) {
	code, stdout, stderr := run(t, nil, "nonsense")
	if code != ExitUsage {
		t.Errorf("exit = %d, want %d", code, ExitUsage)
	}
	if stdout != "" {
		t.Errorf("usage must not touch stdout: %q", stdout)
	}
	if !strings.Contains(stderr, "Usage:") {
		t.Errorf("stderr %q lacks usage", stderr)
	}
}

func TestNoArgsShowsUsageOnStderr(t *testing.T) {
	code, stdout, stderr := run(t, nil)
	if code != ExitUsage {
		t.Errorf("exit = %d", code)
	}
	if stdout != "" || !strings.Contains(stderr, "Usage:") {
		t.Errorf("stdout=%q stderr=%q", stdout, stderr)
	}
}

func TestInvalidSourceIsUsageError(t *testing.T) {
	code, _, stderr := run(t, nil, "preview", "--source", "kimi")
	if code != ExitUsage || !strings.Contains(stderr, "Invalid source") {
		t.Errorf("code=%d stderr=%q", code, stderr)
	}
}

func TestPreviewWithNoProvidersPrintsEmptyArray(t *testing.T) {
	code, stdout, _ := run(t, map[string]string{"TOKENBOARD_TIMEZONE": "UTC"}, "preview", "--source", "pi")
	if code != ExitOK {
		t.Fatalf("code = %d", code)
	}
	if strings.TrimSpace(stdout) != "[]" {
		t.Errorf("preview output %q, want []", stdout)
	}
}

func TestSyncRequiresEndpointAndToken(t *testing.T) {
	code, _, stderr := run(t, map[string]string{"TOKENBOARD_TIMEZONE": "UTC"}, "sync")
	if code != ExitFailure {
		t.Errorf("code = %d", code)
	}
	if !strings.Contains(stderr, "TOKENBOARD_ENDPOINT") || !strings.Contains(stderr, "TOKENBOARD_UPLOAD_TOKEN") {
		t.Errorf("stderr %q lacks both missing names", stderr)
	}
}

func TestSyncUploadsAndReportsCounts(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"upserted": 0})
	}))
	defer server.Close()

	stateDir := t.TempDir()
	_ = os.Chmod(stateDir, 0o700)
	code, stdout, stderr := run(t, map[string]string{
		"TOKENBOARD_TIMEZONE":     "UTC",
		"TOKENBOARD_STATE_DIR":    stateDir,
		"TOKENBOARD_ENDPOINT":     server.URL,
		"TOKENBOARD_UPLOAD_TOKEN": "tb_x",
	}, "sync", "--source", "pi")
	if code != ExitOK {
		t.Fatalf("code = %d stderr=%q", code, stderr)
	}
	var result map[string]any
	if err := json.Unmarshal([]byte(stdout), &result); err != nil {
		t.Fatalf("stdout not JSON: %q", stdout)
	}
	if _, ok := result["upserted"]; !ok {
		t.Errorf("result lacks upserted: %v", result)
	}
}

func TestSyncTransientFailureExits75(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()

	stateDir := t.TempDir()
	_ = os.Chmod(stateDir, 0o700)
	code, _, _ := run(t, map[string]string{
		"TOKENBOARD_TIMEZONE":     "UTC",
		"TOKENBOARD_STATE_DIR":    stateDir,
		"TOKENBOARD_ENDPOINT":     server.URL,
		"TOKENBOARD_UPLOAD_TOKEN": "tb_x",
	}, "sync", "--source", "pi")
	if code != ExitTransient {
		t.Errorf("transient 503 must exit %d, got %d", ExitTransient, code)
	}
}

func TestSyncHookModeTransientFailureExits1(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()

	stateDir := t.TempDir()
	_ = os.Chmod(stateDir, 0o700)
	code, _, _ := run(t, map[string]string{
		"TOKENBOARD_TIMEZONE":     "UTC",
		"TOKENBOARD_STATE_DIR":    stateDir,
		"TOKENBOARD_ENDPOINT":     server.URL,
		"TOKENBOARD_UPLOAD_TOKEN": "tb_x",
		"TOKENBOARD_HOOK_MODE":    "1",
	}, "sync", "--source", "pi")
	if code != ExitFailure {
		t.Errorf("hook mode must not defer: got %d", code)
	}
}

func TestSyncNonTransientFailureExits1AndRecordsBackoff(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()

	stateDir := t.TempDir()
	_ = os.Chmod(stateDir, 0o700)
	code, _, stderr := run(t, map[string]string{
		"TOKENBOARD_TIMEZONE":     "UTC",
		"TOKENBOARD_STATE_DIR":    stateDir,
		"TOKENBOARD_ENDPOINT":     server.URL,
		"TOKENBOARD_UPLOAD_TOKEN": "tb_x",
	}, "sync", "--source", "pi")
	if code != ExitFailure {
		t.Errorf("401 must be a plain failure, got %d", code)
	}
	if !strings.Contains(stderr, "consecutive non-transient failures") {
		t.Errorf("stderr %q lacks backoff note", stderr)
	}
	if _, err := os.Stat(filepath.Join(stateDir, "upload-backoff.json")); err != nil {
		t.Errorf("backoff state not recorded: %v", err)
	}
}

func TestSyncReportsActivePause(t *testing.T) {
	stateDir := t.TempDir()
	_ = os.Chmod(stateDir, 0o700)
	// Five consecutive failures create a pause.
	for i := 0; i < 5; i++ {
		viaUploadFailure(t, stateDir)
	}
	code, _, stderr := run(t, map[string]string{
		"TOKENBOARD_TIMEZONE":     "UTC",
		"TOKENBOARD_STATE_DIR":    stateDir,
		"TOKENBOARD_ENDPOINT":     "http://127.0.0.1:1",
		"TOKENBOARD_UPLOAD_TOKEN": "tb_x",
	}, "sync", "--source", "pi")
	if code != ExitOK {
		t.Errorf("paused run should not fail the sync: %d", code)
	}
	if !strings.Contains(stderr, "paused until") {
		t.Errorf("stderr %q lacks pause notice", stderr)
	}
}

func viaUploadFailure(t *testing.T, stateDir string) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer server.Close()
	code, _, _ := run(t, map[string]string{
		"TOKENBOARD_TIMEZONE":     "UTC",
		"TOKENBOARD_STATE_DIR":    stateDir,
		"TOKENBOARD_ENDPOINT":     server.URL,
		"TOKENBOARD_UPLOAD_TOKEN": "tb_x",
	}, "sync", "--source", "pi")
	if code != ExitFailure {
		t.Fatalf("seed failure run exited %d", code)
	}
}

func TestHookModeScansOnlyHookSources(t *testing.T) {
	sources := expandSources("all", true)
	if len(sources) != 2 {
		t.Fatalf("hook mode sources %v", sources)
	}
	for _, source := range sources {
		if source != "claude-code" && source != "codex" {
			t.Errorf("hook mode must not scan %s", source)
		}
	}
}

func TestUntilRejectedForWarmHooksAndHookMode(t *testing.T) {
	env := map[string]string{"TOKENBOARD_TIMEZONE": "UTC"}
	code, _, stderr := run(t, env, "warm-hooks", "--source", "codex", "--until", "2026-05-09")
	if code != ExitUsage || !strings.Contains(stderr, "until") {
		t.Errorf("warm-hooks --until: code=%d stderr=%q", code, stderr)
	}
	env["TOKENBOARD_HOOK_MODE"] = "1"
	code, _, stderr = run(t, env, "sync", "--source", "codex", "--until", "2026-05-09")
	if code != ExitUsage || !strings.Contains(stderr, "until") {
		t.Errorf("hook --until: code=%d stderr=%q", code, stderr)
	}
	// A non-Claude/Codex source rejects it too.
	delete(env, "TOKENBOARD_HOOK_MODE")
	code, _, stderr = run(t, env, "preview", "--source", "pi", "--until", "2026-05-09")
	if code != ExitUsage || !strings.Contains(stderr, "until") {
		t.Errorf("pi --until: code=%d stderr=%q", code, stderr)
	}
}

func TestInvalidTimezoneIsUsageError(t *testing.T) {
	code, _, stderr := run(t, map[string]string{"TOKENBOARD_TIMEZONE": "Mars/Olympus"}, "preview", "--source", "pi")
	if code != ExitUsage || !strings.Contains(stderr, "Invalid timezone") {
		t.Errorf("code=%d stderr=%q", code, stderr)
	}
}

func TestWarmHooksReportsPlannedSources(t *testing.T) {
	code, stdout, _ := run(t, map[string]string{"TOKENBOARD_TIMEZONE": "UTC"}, "warm-hooks")
	if code != ExitOK {
		t.Fatalf("code=%d", code)
	}
	if !strings.Contains(stdout, "claude-code") || !strings.Contains(stdout, "codex") {
		t.Errorf("warm-hooks output %q", stdout)
	}
}

// A request deadline must defer (75), not count as a plain failure: the
// scheduled runner retries transient exits on its next tick.
func TestSyncRequestTimeoutExits75(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(400 * time.Millisecond)
		_ = json.NewEncoder(w).Encode(map[string]any{"upserted": 0})
	}))
	defer server.Close()

	stateDir := t.TempDir()
	_ = os.Chmod(stateDir, 0o700)
	t.Setenv("TOKENBOARD_FETCH_TIMEOUT_MS", "80")
	code, _, stderr := run(t, map[string]string{
		"TOKENBOARD_TIMEZONE":     "UTC",
		"TOKENBOARD_STATE_DIR":    stateDir,
		"TOKENBOARD_ENDPOINT":     server.URL,
		"TOKENBOARD_UPLOAD_TOKEN": "tb_x",
	}, "sync", "--source", "pi")
	if code != ExitTransient {
		t.Errorf("timeout must exit %d, got %d (stderr %q)", ExitTransient, code, stderr)
	}
	if !strings.Contains(stderr, "request timed out") {
		t.Errorf("stderr must name the timeout: %q", stderr)
	}
}

// warm-hooks reports every concrete source as warmed, matching the TS
// expandSources — including non-hook sources whose warm step is a no-op.
func TestWarmHooksReportsConcreteNonHookSource(t *testing.T) {
	stateDir := t.TempDir()
	_ = os.Chmod(stateDir, 0o700)
	code, stdout, _ := run(t, map[string]string{
		"TOKENBOARD_TIMEZONE":  "UTC",
		"TOKENBOARD_STATE_DIR": stateDir,
	}, "warm-hooks", "--source", "pi")
	if code != ExitOK {
		t.Fatalf("code=%d", code)
	}
	if !strings.Contains(stdout, `"pi"`) || strings.Contains(stdout, "null") {
		t.Errorf("warm-hooks output %q", stdout)
	}
}

// A bare flag with no value must be a usage error, never a silent fallback
// to the environment default.
func TestBareFlagIsMissingValueError(t *testing.T) {
	stateDir := t.TempDir()
	_ = os.Chmod(stateDir, 0o700)
	code, _, stderr := run(t, map[string]string{
		"TOKENBOARD_TIMEZONE":  "UTC",
		"TOKENBOARD_STATE_DIR": stateDir,
		"TOKENBOARD_SOURCE":    "pi",
	}, "preview", "--source")
	if code != ExitUsage || !strings.Contains(stderr, "Missing value for --source") {
		t.Errorf("code=%d stderr=%q", code, stderr)
	}
}

// cursorScopeFromEndpoint mirrors the TS new URL(endpoint).origin: lowercased
// host, default port dropped, path/query stripped; empty for no endpoint.
func TestCursorScopeFromEndpoint(t *testing.T) {
	cases := []struct {
		endpoint string
		want     string
		wantErr  bool
	}{
		{"https://TB.Example/a/b?x=1", "https://tb.example", false},
		{"https://tokenboard.example", "https://tokenboard.example", false},
		{"https://h.example:8443/x", "https://h.example:8443", false},
		{"http://h.example:80/x", "http://h.example", false},
		{"https://h.example:443", "https://h.example", false},
		{"", "", false},
		{"not a url", "", true},
		{"/only/a/path", "", true},
	}
	for _, tc := range cases {
		got, err := cursorScopeFromEndpoint(tc.endpoint)
		if (err != nil) != tc.wantErr {
			t.Errorf("%q: err=%v wantErr=%v", tc.endpoint, err, tc.wantErr)
			continue
		}
		if !tc.wantErr && got != tc.want {
			t.Errorf("%q: got %q want %q", tc.endpoint, got, tc.want)
		}
	}
}

// An unparseable endpoint aborts the sync rather than silently unscooping the
// cursor, matching the TS new URL() throw.
func TestSyncRejectsInvalidEndpoint(t *testing.T) {
	stateDir := t.TempDir()
	_ = os.Chmod(stateDir, 0o700)
	code, _, stderr := run(t, map[string]string{
		"TOKENBOARD_TIMEZONE":     "UTC",
		"TOKENBOARD_STATE_DIR":    stateDir,
		"TOKENBOARD_ENDPOINT":     "not a url",
		"TOKENBOARD_UPLOAD_TOKEN": "tb_x",
	}, "sync", "--source", "pi")
	if code != ExitFailure || !strings.Contains(stderr, "Invalid endpoint URL") {
		t.Errorf("code=%d stderr=%q", code, stderr)
	}
}
