package codex

// Port of the child-session half of codex-subagent-usage-json.test.ts: the
// per-request reader, its bounds, and the event identity that lets the same
// child copied into two profile homes deduplicate.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func subagentChildUsageEventJSON(t *testing.T, index int) string {
	t.Helper()
	return mustMarshalString(t, map[string]any{
		"type":      "event_msg",
		"timestamp": "2026-05-25T01:10:00.000Z",
		"payload": map[string]any{
			"info": map[string]any{
				"total_token_usage": map[string]any{
					"input_tokens": float64(index),
					"total_tokens": float64(index),
				},
				"last_token_usage": map[string]any{
					"input_tokens": float64(index),
					"total_tokens": float64(index),
				},
			},
		},
	})
}

func mustMarshalString(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(encoded)
}

// subagentUsageDateCache is package state, so a repeated run (`-count=2`)
// starts with the entry already cached; reset it to keep the assertion about
// growth meaningful.
func subagentResetUsageDateCache() {
	subagentUsageDateCache.Lock()
	defer subagentUsageDateCache.Unlock()
	subagentUsageDateCache.locations = map[string]*time.Location{}
	subagentUsageDateCache.formatted = map[string]string{}
	subagentUsageDateCache.order = nil
}

func subagentCacheUsageDateCount() int {
	subagentUsageDateCache.Lock()
	defer subagentUsageDateCache.Unlock()
	return len(subagentUsageDateCache.formatted)
}

func TestFormatCodexUsageDateCachesARepeatedTimestamp(t *testing.T) {
	subagentResetUsageDateCache()
	before := subagentCacheUsageDateCount()
	for index := 0; index < 1_000; index++ {
		formatted, err := FormatCodexUsageDate("2026-05-25T01:10:00.000Z", "Pacific/Kiritimati")
		if err != nil {
			t.Fatalf("format: %v", err)
		}
		if formatted != "2026-05-25" {
			t.Fatalf("formatted = %q", formatted)
		}
	}
	if after := subagentCacheUsageDateCount(); after != before+1 {
		t.Fatalf("formatted-date cache grew by %d, want 1", after-before)
	}
}

func TestFormatCodexUsageDateRejectsAnInvalidTimezone(t *testing.T) {
	_, err := FormatCodexUsageDate("2026-05-25T01:10:00.000Z", "Invalid/Timezone")
	if err == nil || !strings.Contains(err.Error(), "Invalid timezone for Codex subagent usage date: Invalid/Timezone") {
		t.Fatalf("err = %v", err)
	}
}

func TestFormatCodexUsageDateRejectsAnImpossibleCalendarDate(t *testing.T) {
	if _, err := FormatCodexUsageDate("2026-02-30T00:00:00.000Z", "UTC"); err == nil ||
		!strings.Contains(err.Error(), "Invalid Codex date") {
		t.Fatalf("err = %v", err)
	}
}

func TestRejectsAnImpossibleChildUsageTimestampBeforeAssigningAUsageDate(t *testing.T) {
	root := t.TempDir()
	filePath := filepath.Join(root, "child.jsonl")
	writeRawFile(t, filePath, mustMarshalString(t, map[string]any{
		"type":      "event_msg",
		"timestamp": "2026-02-30T00:00:00.000Z",
		"payload": map[string]any{
			"info": map[string]any{
				"total_token_usage": map[string]any{"input_tokens": float64(1), "total_tokens": float64(1)},
				"last_token_usage":  map[string]any{"input_tokens": float64(1), "total_tokens": float64(1)},
			},
		},
	})+"\n")

	_, err := ReadChildLastUsageByDate(filePath, "2026-02-01T00:00:00.000Z", "UTC", nil)
	if err == nil || !strings.Contains(err.Error(), "Invalid Codex date") {
		t.Fatalf("err = %v", err)
	}
}

func TestStreamsAChildJSONLLargerThanTheFormerEightMiBBound(t *testing.T) {
	root := t.TempDir()
	filePath := filepath.Join(root, "child.jsonl")
	padding := strings.Repeat(" ", 256*1024-1) + "\n"
	file, err := os.Create(filePath)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	for index := 0; index < 33; index++ {
		if _, err := file.WriteString(padding); err != nil {
			file.Close()
			t.Fatalf("write padding: %v", err)
		}
	}
	if _, err := file.WriteString(subagentChildUsageEventJSON(t, 1) + "\n"); err != nil {
		file.Close()
		t.Fatalf("write event: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	events, err := ReadChildLastUsageEvents(filePath, "2026-05-25T01:00:00.000Z", "UTC", nil)
	if err != nil {
		t.Fatalf("read events: %v", err)
	}
	if len(events) != 1 || events[0].UsageDate != "2026-05-25" || events[0].TotalTokens != 1 {
		t.Fatalf("events = %+v", events)
	}
}

func TestRejectsAChildJSONLOverTheBoundedInputSize(t *testing.T) {
	root := t.TempDir()
	filePath := filepath.Join(root, "child.jsonl")
	if err := os.WriteFile(filePath, nil, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := os.Truncate(filePath, MaxCodexChildSessionBytes+1); err != nil {
		t.Fatalf("truncate: %v", err)
	}

	_, err := ReadChildLastUsageEvents(filePath, "2026-05-25T01:00:00.000Z", "UTC", nil)
	want := "Codex child session exceeds the " + itoa64(MaxCodexChildSessionBytes) + "-byte limit"
	if err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("err = %v, want %q", err, want)
	}
}

func TestRejectsASymbolicLinkChildJSONLBeforeOpeningIt(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need elevated privileges on Windows")
	}
	root := t.TempDir()
	targetPath := filepath.Join(root, "target.jsonl")
	linkedPath := filepath.Join(root, "linked.jsonl")
	writeRawFile(t, targetPath, subagentChildUsageEventJSON(t, 1)+"\n")
	if err := os.Symlink(targetPath, linkedPath); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	_, err := ReadChildLastUsageEvents(linkedPath, "2026-05-25T01:00:00.000Z", "UTC", nil)
	if err == nil || !strings.Contains(err.Error(), "Unable to read Codex child session: symbolic links are not supported") {
		t.Fatalf("err = %v", err)
	}
}

func TestRejectsAnOversizedChildJSONLLine(t *testing.T) {
	root := t.TempDir()
	filePath := filepath.Join(root, "child.jsonl")
	writeRawFile(t, filePath, strings.Repeat(" ", MaxCodexChildSessionLineBytes+1)+"\n")

	_, err := ReadChildLastUsageEvents(filePath, "2026-05-25T01:00:00.000Z", "UTC", nil)
	want := "Codex child session contains a line exceeding the " + itoa64(MaxCodexChildSessionLineBytes) + "-byte limit"
	if err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("err = %v, want %q", err, want)
	}
}

func TestSkipsOversizedCompactedRowsWithEmbeddedNonBillableTokenHistory(t *testing.T) {
	root := t.TempDir()
	filePath := filepath.Join(root, "child.jsonl")
	usage := map[string]any{
		"input_tokens": float64(1), "cached_input_tokens": float64(2),
		"output_tokens": float64(3), "total_tokens": float64(4),
	}
	oversized := mustMarshalString(t, map[string]any{
		"type": "compacted",
		"payload": map[string]any{
			"latest_token_usage_record": map[string]any{
				"usage": usage, "turn_token_usage": usage, "thread_token_usage": usage,
			},
			"padding": strings.Repeat("x", MaxCodexChildSessionLineBytes+1),
		},
	})
	writeRawFile(t, filePath, oversized+"\n"+subagentChildUsageEventJSON(t, 2)+"\n")

	warnings := []string{}
	events, err := ReadChildLastUsageEvents(filePath, "2026-05-25T01:00:00.000Z", "UTC", func(line string) {
		warnings = append(warnings, line)
	})
	if err != nil {
		t.Fatalf("read events: %v", err)
	}
	if len(events) != 1 || events[0].TotalTokens != 2 {
		t.Fatalf("events = %+v", events)
	}
	want := "Skipped 1 oversized Codex child session JSONL row without usage or subagent metadata (largest " +
		itoa64(int64(len(oversized))) + " bytes)"
	if len(warnings) != 1 || warnings[0] != want {
		t.Fatalf("warnings = %v, want [%q]", warnings, want)
	}
}

func TestRejectsExcessiveUniqueChildUsageEvents(t *testing.T) {
	root := t.TempDir()
	filePath := filepath.Join(root, "child.jsonl")
	var builder strings.Builder
	for index := 0; index <= MaxCodexChildUsageEvents; index++ {
		builder.WriteString(subagentChildUsageEventJSON(t, index+1))
		builder.WriteByte('\n')
	}
	writeRawFile(t, filePath, builder.String())

	_, err := ReadChildLastUsageEvents(filePath, "2026-05-25T01:00:00.000Z", "UTC", nil)
	want := "Codex child session exceeds the " + itoa64(MaxCodexChildUsageEvents) + " unique usage-event limit"
	if err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("err = %v, want %q", err, want)
	}
}

func TestRejectsExcessiveCombinedMultiProfileChildUsageEvents(t *testing.T) {
	events := make([]ChildUsageEvent, 0, MaxMergedCodexChildUsageEvents+1)
	for index := 0; index <= MaxMergedCodexChildUsageEvents; index++ {
		events = append(events, ChildUsageEvent{
			EventKey:   "event-" + itoa64(int64(index)),
			DatedUsage: DatedUsage{UsageDate: "2026-05-25", InputTokens: 1, TotalTokens: 1},
		})
	}

	_, err := MergeChildUsageEventsByDate([][]ChildUsageEvent{events})
	want := "Codex child usage correction exceeds the " + itoa64(MaxMergedCodexChildUsageEvents) + " unique usage-event limit"
	if err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("err = %v, want %q", err, want)
	}
}

func TestPreservesCacheCreationTokensFromChildUsageRecords(t *testing.T) {
	root := t.TempDir()
	filePath := filepath.Join(root, "child.jsonl")
	usage := map[string]any{
		"input_tokens":                float64(200),
		"output_tokens":               float64(20),
		"cache_creation_input_tokens": float64(30),
		"cached_input_tokens":         float64(150),
		"total_tokens":                float64(250),
	}
	writeRawFile(t, filePath, mustMarshalString(t, map[string]any{
		"type":      "event_msg",
		"timestamp": "2026-05-25T01:10:00.000Z",
		"payload":   map[string]any{"info": map[string]any{"total_token_usage": usage, "last_token_usage": usage}},
	})+"\n")

	usages, err := ReadChildLastUsageByDate(filePath, "2026-05-25T01:00:00.000Z", "UTC", nil)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(usages) != 1 {
		t.Fatalf("usages = %+v", usages)
	}
	want := DatedUsage{
		UsageDate: "2026-05-25", InputTokens: 200, OutputTokens: 20,
		CacheCreationTokens: 30, CacheReadTokens: 150, TotalTokens: 250,
	}
	if usages[0] != want {
		t.Fatalf("usage = %+v, want %+v", usages[0], want)
	}
}

func TestReportsChildRecordsMissingPerRequestUsage(t *testing.T) {
	root := t.TempDir()
	filePath := filepath.Join(root, "child.jsonl")
	writeRawFile(t, filePath, mustMarshalString(t, map[string]any{
		"type":      "event_msg",
		"timestamp": "2026-05-25T01:10:00.000Z",
		"payload": map[string]any{
			"info": map[string]any{
				"total_token_usage": map[string]any{
					"input_tokens": float64(10), "output_tokens": float64(2), "total_tokens": float64(12),
				},
			},
		},
	})+"\n")

	warnings := []string{}
	events, err := ReadChildLastUsageEvents(filePath, "2026-05-25T01:00:00.000Z", "UTC", func(line string) {
		warnings = append(warnings, line)
	})
	if err != nil {
		t.Fatalf("read events: %v", err)
	}
	if len(events) != 0 {
		t.Fatalf("events = %+v", events)
	}
	want := "Skipped 1 Codex child usage record with total_token_usage but missing last_token_usage"
	if len(warnings) != 1 || warnings[0] != want {
		t.Fatalf("warnings = %v, want [%q]", warnings, want)
	}
}

func TestKeepsSameValueEventsDistinctWhileDeduplicatingTheSameChildAcrossProfiles(t *testing.T) {
	root := t.TempDir()
	firstPath := filepath.Join(root, "profile-a", "sessions", "2026", "05", "25", "child-a.jsonl")
	copiedPath := filepath.Join(root, "profile-b", "sessions", "2026", "05", "25", "child-a.jsonl")
	otherPath := filepath.Join(root, "profile-c", "sessions", "2026", "05", "25", "child-b.jsonl")

	eventAt := func(index int, timestamp string) string {
		return mustMarshalString(t, map[string]any{
			"type":      "event_msg",
			"timestamp": timestamp,
			"payload": map[string]any{
				"info": map[string]any{
					"total_token_usage": map[string]any{"input_tokens": float64(index), "total_tokens": float64(index)},
					"last_token_usage":  map[string]any{"input_tokens": float64(index), "total_tokens": float64(index)},
				},
			},
		})
	}
	writeRawFile(t, firstPath,
		eventAt(1, "2026-05-25T01:10:00.000Z")+"\n"+eventAt(1, "2026-05-25T01:20:00.000Z")+"\n")
	writeRawFile(t, copiedPath, eventAt(1, "2026-05-25T01:10:00.000Z")+"\n")
	writeRawFile(t, otherPath, eventAt(1, "2026-05-25T01:10:00.000Z")+"\n")

	firstEvents, err := ReadChildLastUsageEvents(firstPath, "2026-05-25T01:00:00.000Z", "UTC", nil)
	if err != nil {
		t.Fatalf("read first: %v", err)
	}
	copiedEvents, err := ReadChildLastUsageEvents(copiedPath, "2026-05-25T01:00:00.000Z", "UTC", nil)
	if err != nil {
		t.Fatalf("read copied: %v", err)
	}
	otherEvents, err := ReadChildLastUsageEvents(otherPath, "2026-05-25T01:00:00.000Z", "UTC", nil)
	if err != nil {
		t.Fatalf("read other: %v", err)
	}
	if len(firstEvents) != 2 {
		t.Fatalf("first events = %+v", firstEvents)
	}
	if firstEvents[0].EventKey != copiedEvents[0].EventKey {
		t.Fatalf("copied event key differs: %q vs %q", firstEvents[0].EventKey, copiedEvents[0].EventKey)
	}
	if firstEvents[0].EventKey == otherEvents[0].EventKey {
		t.Fatalf("distinct sessions share an event key: %q", firstEvents[0].EventKey)
	}
	merged, err := MergeChildUsageEventsByDate([][]ChildUsageEvent{firstEvents, copiedEvents, otherEvents})
	if err != nil {
		t.Fatalf("merge: %v", err)
	}
	if len(merged) != 1 || merged[0].UsageDate != "2026-05-25" || merged[0].TotalTokens != 3 {
		t.Fatalf("merged = %+v", merged)
	}
}
