package codex

// Port of codex-subagent-usage-frozen-cache.test.ts.

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func subagentFrozenUsage() []DatedUsage {
	return []DatedUsage{subagentDatedUsage("2026-07-25", 1, 3, 4, 2, 10)}
}

func TestLooksUpAFrozenFileByItsOriginalPathAndCopyTimeFingerprint(t *testing.T) {
	root := t.TempDir()
	stateDir := filepath.Join(root, "state")
	source := filepath.Join(root, "source.jsonl")
	frozen := filepath.Join(root, "frozen.jsonl")
	if err := os.WriteFile(source, []byte("{\"type\":\"event_msg\"}\n"), 0o644); err != nil {
		t.Fatalf("write source: %v", err)
	}
	content, err := os.ReadFile(source)
	if err != nil {
		t.Fatalf("read source: %v", err)
	}
	if err := os.WriteFile(frozen, content, 0o644); err != nil {
		t.Fatalf("write frozen copy: %v", err)
	}
	sourceFingerprint, err := FingerprintCodexSessionFile(source)
	if err != nil {
		t.Fatalf("fingerprint source: %v", err)
	}

	usage := subagentFrozenUsage()
	if err := WithCodexSubagentUsageCache(CodexSubagentUsageCacheInput{
		StateDir: stateDir,
		Timezone: "UTC",
		ReadChildUsageByDate: func(string, string, string, func(string), string) ([]DatedUsage, error) {
			return usage, nil
		},
		Callback: func(reader CodexSubagentUsageCacheReader) error {
			_, err := reader.Read(source, "2026-07-25T00:00:00.000Z", "UTC", nil, "")
			return err
		},
	}); err != nil {
		t.Fatalf("prime cache: %v", err)
	}

	uncachedReads := 0
	var result []DatedUsage
	if err := WithCodexSubagentUsageCache(CodexSubagentUsageCacheInput{
		StateDir: stateDir,
		Timezone: "UTC",
		CacheFiles: map[string]CodexSubagentUsageCacheFile{
			frozen: {SourceFile: source, SourceFingerprint: sourceFingerprint},
		},
		ReadChildUsageByDate: func(string, string, string, func(string), string) ([]DatedUsage, error) {
			uncachedReads++
			return nil, nil
		},
		Callback: func(reader CodexSubagentUsageCacheReader) error {
			var err error
			result, err = reader.Read(frozen, "2026-07-25T00:00:00.000Z", "UTC", nil, "")
			return err
		},
	}); err != nil {
		t.Fatalf("read frozen cache: %v", err)
	}

	if uncachedReads != 0 {
		t.Fatalf("uncached reads = %d, want 0", uncachedReads)
	}
	if !reflect.DeepEqual(result, usage) {
		t.Fatalf("result = %+v, want %+v", result, usage)
	}
}

func TestUsesAStableFrozenResultWithoutCachingItAfterTheSourceChanges(t *testing.T) {
	root := t.TempDir()
	stateDir := filepath.Join(root, "state")
	source := filepath.Join(root, "source.jsonl")
	frozen := filepath.Join(root, "frozen.jsonl")
	if err := os.WriteFile(source, []byte("{\"type\":\"event_msg\"}\n"), 0o644); err != nil {
		t.Fatalf("write source: %v", err)
	}
	content, err := os.ReadFile(source)
	if err != nil {
		t.Fatalf("read source: %v", err)
	}
	if err := os.WriteFile(frozen, content, 0o644); err != nil {
		t.Fatalf("write frozen copy: %v", err)
	}
	sourceFingerprint, err := FingerprintCodexSessionFile(source)
	if err != nil {
		t.Fatalf("fingerprint source: %v", err)
	}
	file, err := os.OpenFile(source, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatalf("open source: %v", err)
	}
	if _, err := file.WriteString("{\"type\":\"event_msg\"}\n"); err != nil {
		file.Close()
		t.Fatalf("append source: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("close source: %v", err)
	}

	usage := subagentFrozenUsage()
	warnings := []string{}
	var result []DatedUsage
	if err := WithCodexSubagentUsageCache(CodexSubagentUsageCacheInput{
		StateDir: stateDir,
		Timezone: "UTC",
		CacheFiles: map[string]CodexSubagentUsageCacheFile{
			frozen: {SourceFile: source, SourceFingerprint: sourceFingerprint},
		},
		ReadChildUsageByDate: func(string, string, string, func(string), string) ([]DatedUsage, error) {
			return usage, nil
		},
		Callback: func(reader CodexSubagentUsageCacheReader) error {
			var err error
			result, err = reader.Read(frozen, "2026-07-25T00:00:00.000Z", "UTC",
				func(line string) { warnings = append(warnings, line) }, "")
			return err
		},
	}); err != nil {
		t.Fatalf("read frozen cache: %v", err)
	}

	if !reflect.DeepEqual(result, usage) {
		t.Fatalf("result = %+v, want %+v", result, usage)
	}
	want := []string{"Skipping stale Codex subagent usage cache write for a session that changed after copy"}
	if !reflect.DeepEqual(warnings, want) {
		t.Fatalf("warnings = %v, want %v", warnings, want)
	}
	cache, err := readSubagentCacheFileForTest(filepath.Join(stateDir, "codex-subagent-usage-cache.json"))
	if err != nil {
		t.Fatalf("read cache: %v", err)
	}
	entries, ok := cache["entries"].(map[string]any)
	if !ok {
		t.Fatalf("cache entries = %#v, want an object", cache["entries"])
	}
	if len(entries) != 0 {
		t.Fatalf("cache entries = %v, want {}", entries)
	}
}
