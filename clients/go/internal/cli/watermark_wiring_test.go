package cli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
	"github.com/MisonL/TokenBoard/clients/go/internal/upload"
	"github.com/MisonL/TokenBoard/clients/go/internal/watermark"
)

func shanghai(t *testing.T) *time.Location {
	t.Helper()
	location, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatalf("location: %v", err)
	}
	return location
}

func writeWatermark(t *testing.T, dir, source, date, endpoint, tokenHash string) {
	t.Helper()
	if err := watermark.Record(dir, endpoint, tokenHash, map[string]string{source: date}, watermarkNow(t), shanghai(t)); err != nil {
		t.Fatalf("record: %v", err)
	}
}

func watermarkNow(t *testing.T) time.Time {
	t.Helper()
	return time.Date(2026, 11, 26, 10, 0, 0, 0, shanghai(t))
}

func baseOptions() Options {
	return Options{
		Command:     "sync",
		Source:      "all",
		Timezone:    "Asia/Shanghai",
		Endpoint:    "https://tb.example",
		UploadToken: "tb_test_token",
		Since:       "2026-11-19", // the injected seven-day default
	}
}

func TestAutoSinceOffKeepsTheInjectedDefault(t *testing.T) {
	dir := t.TempDir()
	writeWatermark(t, dir, "claude-code", "2026-11-10", "https://tb.example", watermark.TokenFingerprint("tb_test_token"))
	options := baseOptions()
	next := applyAutoSince(options, func(string) string { return "" }, dir, watermarkNow(t))
	if next.Since != options.Since {
		t.Fatalf("since changed without AUTO: %q", next.Since)
	}
}

func TestAutoSinceWidensToTheWatermark(t *testing.T) {
	dir := t.TempDir()
	tokenHash := watermark.TokenFingerprint("tb_test_token")
	writeWatermark(t, dir, "claude-code", "2026-11-10", "https://tb.example", tokenHash)
	env := func(key string) string {
		if key == "TOKENBOARD_SINCE_AUTO" {
			return "1"
		}
		return ""
	}
	options := applyAutoSince(baseOptions(), env, dir, watermarkNow(t))
	if options.Since != "2026-11-09" {
		t.Fatalf("since = %q want 2026-11-09 (watermark-1)", options.Since)
	}
}

func TestAutoSinceWithoutWatermarkKeepsTheDefault(t *testing.T) {
	env := func(key string) string {
		if key == "TOKENBOARD_SINCE_AUTO" {
			return "1"
		}
		return ""
	}
	options := baseOptions()
	next := applyAutoSince(options, env, t.TempDir(), watermarkNow(t))
	if next.Since != options.Since {
		t.Fatalf("since changed without a watermark: %q", next.Since)
	}
}

func TestAutoSinceIgnoresHookRuns(t *testing.T) {
	dir := t.TempDir()
	writeWatermark(t, dir, "claude-code", "2026-11-10", "https://tb.example", watermark.TokenFingerprint("tb_test_token"))
	env := func(key string) string {
		if key == "TOKENBOARD_SINCE_AUTO" {
			return "1"
		}
		return ""
	}
	options := baseOptions()
	options.HookMode = true
	next := applyAutoSince(options, env, dir, watermarkNow(t))
	if next.Since != options.Since {
		t.Fatalf("hook run since changed: %q", next.Since)
	}
}

func TestWatermarkRecordsOnlyDeliveredDates(t *testing.T) {
	dir := t.TempDir()
	options := baseOptions()
	outcome := collection{collectedSources: []contract.Source{contract.SourceClaudeCode, contract.SourceCodex}}
	result := upload.Result{
		Delivered: []contract.Snapshot{
			{Source: contract.SourceClaudeCode, UsageDate: "2026-11-24"},
			{Source: contract.SourceClaudeCode, UsageDate: "2026-11-20"},
		},
		Rejected: []upload.RejectedSnapshot{
			// Permanently unuploadable: counts as delivered for the watermark.
			{Snapshot: contract.Snapshot{Source: contract.SourceCodex, UsageDate: "2026-11-22"}, Issue: "before-history-window"},
		},
	}
	if err := recordDeliveredWatermarks(dir, outcome, result, options, watermarkNow(t)); err != nil {
		t.Fatalf("record: %v", err)
	}
	entries := watermark.Load(dir)
	if entries["claude-code"].UsageDate != "2026-11-24" {
		t.Fatalf("claude-code watermark = %q", entries["claude-code"].UsageDate)
	}
	if entries["codex"].UsageDate != "2026-11-22" {
		t.Fatalf("codex watermark = %q", entries["codex"].UsageDate)
	}
}

func TestWatermarkSkipsASourceWithPendingRows(t *testing.T) {
	dir := t.TempDir()
	options := baseOptions()
	outcome := collection{collectedSources: []contract.Source{contract.SourceClaudeCode, contract.SourceCodex}}
	result := upload.Result{
		Delivered: []contract.Snapshot{{Source: contract.SourceClaudeCode, UsageDate: "2026-11-24"}},
		// A blocked row still has an undelivered date; advancing past it would
		// lose that date for good.
		Blocked: []upload.BlockedSnapshot{{Snapshot: contract.Snapshot{Source: contract.SourceCodex, UsageDate: "2026-11-21"}, Code: "invalid-value"}},
	}
	if err := recordDeliveredWatermarks(dir, outcome, result, options, watermarkNow(t)); err != nil {
		t.Fatalf("record: %v", err)
	}
	entries := watermark.Load(dir)
	if _, ok := entries["codex"]; ok {
		t.Fatal("a source with a blocked row must not advance its watermark")
	}
	if entries["claude-code"].UsageDate != "2026-11-24" {
		t.Fatalf("claude-code watermark = %q", entries["claude-code"].UsageDate)
	}
}

func TestWatermarkSkipsASourceWithTooFarFutureRows(t *testing.T) {
	dir := t.TempDir()
	options := baseOptions()
	outcome := collection{collectedSources: []contract.Source{contract.SourceCodex}}
	result := upload.Result{
		Delivered: []contract.Snapshot{{Source: contract.SourceCodex, UsageDate: "2026-11-20"}},
		Rejected: []upload.RejectedSnapshot{
			{Snapshot: contract.Snapshot{Source: contract.SourceCodex, UsageDate: "2026-11-27"}, Issue: "too-far-future"},
		},
	}
	if err := recordDeliveredWatermarks(dir, outcome, result, options, watermarkNow(t)); err != nil {
		t.Fatalf("record: %v", err)
	}
	if entries := watermark.Load(dir); len(entries) != 0 {
		t.Fatalf("a future-dated drop must withhold the source, got %+v", entries)
	}
}

// End to end through the real CLI path: a successful sync writes the
// watermark, and a preview (nothing delivered) leaves it alone.
func TestWatermarkIsWrittenAfterASuccessfulSyncOnly(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/check") {
			_ = json.NewEncoder(w).Encode(map[string]any{"existing": []any{}})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"upserted": 1})
	}))
	defer server.Close()

	stateDir := t.TempDir()
	env := map[string]string{
		"TOKENBOARD_TIMEZONE":     "UTC",
		"TOKENBOARD_STATE_DIR":    stateDir,
		"TOKENBOARD_ENDPOINT":     server.URL,
		"TOKENBOARD_UPLOAD_TOKEN": "tb_x",
		"TOKENBOARD_GROK_HOME":    grokHomeFixture(t),
		"TOKENBOARD_SINCE_AUTO":   "1",
	}
	if code, _, stderr := run(t, env, "preview", "--source", "grok-build"); code != ExitOK {
		t.Fatalf("preview failed: %d %s", code, stderr)
	}
	if entries := watermark.Load(stateDir); len(entries) != 0 {
		t.Fatalf("preview must not write a watermark: %+v", entries)
	}
	if code, _, stderr := run(t, env, "sync", "--source", "grok-build"); code != ExitOK {
		t.Fatalf("sync failed: %d %s", code, stderr)
	}
	entries := watermark.Load(stateDir)
	entry, ok := entries["grok-build"]
	if !ok {
		t.Fatalf("sync did not record a watermark: %+v", entries)
	}
	if entry.Endpoint != server.URL || entry.TokenHash != watermark.TokenFingerprint("tb_x") {
		t.Fatalf("entry scoped wrongly: %+v", entry)
	}
}
