package watermark

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func loc(t *testing.T) *time.Location {
	t.Helper()
	location, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatalf("load location: %v", err)
	}
	return location
}

// now is an arbitrary instant in Asia/Shanghai's 2026-11-26.
func nowIn(t *testing.T) time.Time {
	t.Helper()
	return time.Date(2026, 11, 26, 10, 0, 0, 0, loc(t))
}

func writeFile(t *testing.T, stateDir string, content string) {
	t.Helper()
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(stateDir, FileName), []byte(content), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func TestEffectiveSinceWithoutFileIsAbsent(t *testing.T) {
	dir := t.TempDir()
	since, ok := EffectiveSince(dir, []string{"claude-code"}, "https://tb.example", "hash", nowIn(t), loc(t))
	if ok || since != "" {
		t.Fatalf("expected no watermark, got %q/%v", since, ok)
	}
}

func TestNineDayOldWatermarkLooksBackTenDays(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, `{
  "schemaVersion": "tokenboard-delivered-watermark/v1",
  "sources": {
    "claude-code": {"usageDate":"2026-11-17","endpoint":"https://tb.example","tokenHash":"hash","updatedAt":"2026-11-17T03:00:00Z"}
  }
}`)
	since, ok := EffectiveSince(dir, []string{"claude-code"}, "https://tb.example", "hash", nowIn(t), loc(t))
	if !ok {
		t.Fatal("expected a watermark")
	}
	// watermark-1 = 2026-11-16, which is inside [today-30, today-7].
	if since != "2026-11-16" {
		t.Fatalf("since = %q want 2026-11-16", since)
	}
}

func TestFortyDayOldWatermarkIsClampedToThirtyDays(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, `{
  "schemaVersion": "tokenboard-delivered-watermark/v1",
  "sources": {
    "claude-code": {"usageDate":"2026-10-17","endpoint":"https://tb.example","tokenHash":"hash"}
  }
}`)
	since, ok := EffectiveSince(dir, []string{"claude-code"}, "https://tb.example", "hash", nowIn(t), loc(t))
	if !ok {
		t.Fatal("expected a watermark")
	}
	if since != "2026-10-27" {
		t.Fatalf("since = %q want 2026-10-27 (today-30)", since)
	}
}

func TestRecentWatermarkFallsBackToTheSevenDayFloor(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, `{
  "schemaVersion": "tokenboard-delivered-watermark/v1",
  "sources": {
    "claude-code": {"usageDate":"2026-11-24","endpoint":"https://tb.example","tokenHash":"hash"}
  }
}`)
	since, ok := EffectiveSince(dir, []string{"claude-code"}, "https://tb.example", "hash", nowIn(t), loc(t))
	if !ok {
		t.Fatal("expected a watermark")
	}
	if since != "2026-11-19" {
		t.Fatalf("since = %q want 2026-11-19 (today-7)", since)
	}
}

func TestCorruptOrFutureWatermarksCountAsAbsent(t *testing.T) {
	future := `{"schemaVersion":"tokenboard-delivered-watermark/v1","sources":{"claude-code":{"usageDate":"2026-12-01","endpoint":"https://tb.example","tokenHash":"hash"}}}`
	inputs := map[string]string{
		"corrupt":       `{"schemaVersion": `,
		"wrong version": `{"schemaVersion":"other/v9","sources":{"claude-code":{"usageDate":"2026-11-17","endpoint":"https://tb.example","tokenHash":"hash"}}}`,
		"future date":   future,
	}
	for name, content := range inputs {
		dir := t.TempDir()
		writeFile(t, dir, content)
		since, ok := EffectiveSince(dir, []string{"claude-code"}, "https://tb.example", "hash", nowIn(t), loc(t))
		if ok || since != "" {
			t.Fatalf("%s: expected absent, got %q/%v", name, since, ok)
		}
	}
}

func TestWatermarksFromAnotherEndpointOrTokenAreNotInherited(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, `{
  "schemaVersion": "tokenboard-delivered-watermark/v1",
  "sources": {
    "claude-code": {"usageDate":"2026-11-17","endpoint":"https://other.example","tokenHash":"hash"},
    "codex": {"usageDate":"2026-11-17","endpoint":"https://tb.example","tokenHash":"old-token"}
  }
}`)
	since, ok := EffectiveSince(
		dir, []string{"claude-code", "codex"}, "https://tb.example", "hash", nowIn(t), loc(t),
	)
	if ok || since != "" {
		t.Fatalf("a re-paired install must not inherit the old watermark; got %q/%v", since, ok)
	}
}

func TestEarliestSourceDrivesTheProcessSince(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, `{
  "schemaVersion": "tokenboard-delivered-watermark/v1",
  "sources": {
    "claude-code": {"usageDate":"2026-11-18","endpoint":"https://tb.example","tokenHash":"hash"},
    "codex": {"usageDate":"2026-11-12","endpoint":"https://tb.example","tokenHash":"hash"}
  }
}`)
	since, ok := EffectiveSince(
		dir, []string{"claude-code", "codex"}, "https://tb.example", "hash", nowIn(t), loc(t),
	)
	if !ok {
		t.Fatal("expected a watermark")
	}
	// codex-1 = 2026-11-11 is earlier than claude-code-1 = 2026-11-17.
	if since != "2026-11-11" {
		t.Fatalf("since = %q want 2026-11-11", since)
	}
}

func TestRecordAdvancesOnlyForward(t *testing.T) {
	dir := t.TempDir()
	now := nowIn(t)
	if err := Record(dir, "https://tb.example", "hash", map[string]string{"claude-code": "2026-11-20"}, now, loc(t)); err != nil {
		t.Fatalf("record: %v", err)
	}
	// An older candidate (a late-dated row from a previous run) must not move it back.
	if err := Record(dir, "https://tb.example", "hash", map[string]string{"claude-code": "2026-11-18"}, now, loc(t)); err != nil {
		t.Fatalf("record: %v", err)
	}
	since, ok := EffectiveSince(dir, []string{"claude-code"}, "https://tb.example", "hash", now, loc(t))
	if !ok || since != "2026-11-19" {
		t.Fatalf("since = %q/%v want 2026-11-19", since, ok)
	}
}

func TestRecordClampsToTodayAndRejectsInvalidDates(t *testing.T) {
	dir := t.TempDir()
	now := nowIn(t)
	if err := Record(dir, "https://tb.example", "hash", map[string]string{
		"claude-code": "2027-01-01", // a clock that jumped ahead
		"codex":       "not-a-date",
	}, now, loc(t)); err != nil {
		t.Fatalf("record: %v", err)
	}
	entries := Load(dir)
	if entries["claude-code"].UsageDate != "2026-11-26" {
		t.Fatalf("candidate must clamp to today, got %q", entries["claude-code"].UsageDate)
	}
	if _, ok := entries["codex"]; ok {
		t.Fatal("an invalid date must not be recorded")
	}
}

func TestRecordPreservesOtherSourcesAndRepairsCorruption(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, `{"schemaVersion": `)
	if err := Record(dir, "https://tb.example", "hash", map[string]string{"claude-code": "2026-11-20"}, nowIn(t), loc(t)); err != nil {
		t.Fatalf("record over a corrupt file: %v", err)
	}
	if err := Record(dir, "https://tb.example", "hash", map[string]string{"codex": "2026-11-21"}, nowIn(t), loc(t)); err != nil {
		t.Fatalf("record: %v", err)
	}
	entries := Load(dir)
	if len(entries) != 2 || entries["claude-code"].UsageDate != "2026-11-20" || entries["codex"].UsageDate != "2026-11-21" {
		t.Fatalf("unexpected entries: %+v", entries)
	}
	info, err := os.Stat(filepath.Join(dir, FileName))
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %o want 600", info.Mode().Perm())
	}
}

// The TS collector writes the same file; both sides must agree on the shape.
func TestReadsTheTypeScriptShape(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, `{"schemaVersion":"tokenboard-delivered-watermark/v1","sources":{"claude-code":{"usageDate":"2026-11-17","endpoint":"https://tb.example","tokenHash":"abc123","updatedAt":"2026-11-17T03:00:00.000Z"}}}`)
	var parsed map[string]any
	if err := json.Unmarshal([]byte(mustRead(t, dir)), &parsed); err != nil {
		t.Fatalf("fixture must be valid JSON: %v", err)
	}
	since, ok := EffectiveSince(dir, []string{"claude-code"}, "https://tb.example", "abc123", nowIn(t), loc(t))
	if !ok || since != "2026-11-16" {
		t.Fatalf("since = %q/%v", since, ok)
	}
}

func mustRead(t *testing.T, dir string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, FileName))
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	return string(data)
}

// The TS collector derives the same fingerprint (tokenFingerprint in
// packages/collector/src/delivered-watermark.ts); the pinned value is how the
// two derivations stay identical instead of merely "both look like hashes".
func TestTokenFingerprintMatchesTheTypeScriptCollector(t *testing.T) {
	if got := TokenFingerprint("tb_test_token"); got != "b5645c485ebefb03" {
		t.Fatalf("fingerprint = %q want b5645c485ebefb03", got)
	}
	if TokenFingerprint("") != "" {
		t.Fatal("an empty token must not fingerprint")
	}
}
