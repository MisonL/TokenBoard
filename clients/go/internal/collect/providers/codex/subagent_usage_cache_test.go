package codex

// Port of codex-subagent-usage-cache.test.ts: retention, the oversized-cache
// discard, the 75% eviction, legacy normalization and the stable-read retry.

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessionfile"
)

func subagentCacheUsageFixture() []DatedUsage {
	return []DatedUsage{{
		UsageDate: "2026-07-20", InputTokens: 1, OutputTokens: 2,
		CacheCreationTokens: 3, CacheReadTokens: 4, TotalTokens: 10,
	}}
}

func subagentCacheEntryFixture(updatedAt string) subagentCacheEntry {
	dev := 1.0
	ino := 2.0
	ctime := 3.0
	return subagentCacheEntry{
		Dev: &dev, Ino: &ino, Size: 4, MtimeMs: 5, CtimeMs: &ctime,
		TailSHA256: strings.Repeat("a", 64),
		UpdatedAt:  updatedAt,
		Usages:     []DatedUsage{},
	}
}

func TestRetainCodexSubagentCacheEntriesBoundsOneCorrectionToCapacity(t *testing.T) {
	entries := map[string]subagentCacheEntry{}
	usedKeys := map[string]bool{}
	for index := 0; index <= codexSubagentCacheMaxEntries; index++ {
		key := "child-" + itoa64(int64(index))
		entries[key] = subagentCacheEntryFixture("2026-07-18T00:00:00.000Z")
		usedKeys[key] = true
	}
	nowMs, ok := attributionParseMillis("2026-07-18T00:00:00.000Z")
	if !ok {
		t.Fatal("updatedAt did not parse")
	}

	retained := RetainCodexSubagentCacheEntries(entries, usedKeys, nowMs)
	if len(retained) != codexSubagentCacheMaxEntries {
		t.Fatalf("retained %d entries, want %d", len(retained), codexSubagentCacheMaxEntries)
	}
}

func TestDiscardsAnOversizedCacheAndRebuildsIt(t *testing.T) {
	stateDir := t.TempDir()
	cachePath := filepath.Join(stateDir, codexSubagentUsageCacheFileName)
	if err := os.WriteFile(cachePath, make([]byte, codexSubagentCacheMaxBytes+1), 0o600); err != nil {
		t.Fatalf("write oversized cache: %v", err)
	}
	callbackCalled := false
	err := WithCodexSubagentUsageCache(CodexSubagentUsageCacheInput{
		StateDir: stateDir,
		Timezone: "UTC",
		ReadChildUsageByDate: func(filePath, timestamp, timezone string, stderr func(string), _ string) ([]DatedUsage, error) {
			return nil, nil
		},
		Callback: func(CodexSubagentUsageCacheReader) error {
			callbackCalled = true
			return nil
		},
	})
	if err != nil {
		t.Fatalf("cache transaction: %v", err)
	}
	if !callbackCalled {
		t.Fatal("callback was not called")
	}
	rebuilt, err := os.ReadFile(cachePath)
	if err != nil {
		t.Fatalf("read rebuilt cache: %v", err)
	}
	if !strings.Contains(string(rebuilt), `"version"`) {
		t.Fatalf("rebuilt cache = %q", string(rebuilt))
	}
}

func TestEvictsTheOldestUnusedEntriesToSeventyFivePercent(t *testing.T) {
	stateDir := t.TempDir()
	childPath := filepath.Join(stateDir, "child.jsonl")
	cachePath := filepath.Join(stateDir, codexSubagentUsageCacheFileName)
	writeRawFile(t, childPath, "{\"type\":\"event_msg\"}\n")

	oversizedUsages := make([]DatedUsage, 80_000)
	for index := range oversizedUsages {
		oversizedUsages[index] = DatedUsage{
			UsageDate:           "2026-07-20",
			InputTokens:         float64(index),
			OutputTokens:        float64(index),
			CacheCreationTokens: float64(index),
			CacheReadTokens:     float64(index),
			TotalTokens:         float64(index * 4),
		}
	}
	callbackCalled := false
	err := WithCodexSubagentUsageCache(CodexSubagentUsageCacheInput{
		StateDir: stateDir,
		Timezone: "UTC",
		ReadChildUsageByDate: func(filePath, timestamp, timezone string, stderr func(string), _ string) ([]DatedUsage, error) {
			return oversizedUsages, nil
		},
		Callback: func(reader CodexSubagentUsageCacheReader) error {
			callbackCalled = true
			_, err := reader.Read(childPath, "2026-07-20T00:00:00.000Z", "UTC", nil, "")
			return err
		},
	})
	if err != nil {
		t.Fatalf("cache transaction: %v", err)
	}
	if !callbackCalled {
		t.Fatal("callback was not called")
	}
	persisted, err := readSubagentCacheFileForTest(cachePath)
	if err != nil {
		t.Fatalf("read cache: %v", err)
	}
	entries, _ := persisted["entries"].(map[string]any)
	// The single oversized entry (80k usages in one session) cannot be kept
	// under the budget, so the write persists an empty cache instead of
	// failing the sync; the corrections recompute from the session file on a
	// later run.
	if len(entries) != 0 {
		t.Fatalf("persisted %d entries, want 0", len(entries))
	}

	recoveryCallbackCalled := false
	var recovered []DatedUsage
	err = WithCodexSubagentUsageCache(CodexSubagentUsageCacheInput{
		StateDir: stateDir,
		Timezone: "UTC",
		ReadChildUsageByDate: func(filePath, timestamp, timezone string, stderr func(string), _ string) ([]DatedUsage, error) {
			return nil, nil
		},
		Callback: func(reader CodexSubagentUsageCacheReader) error {
			recoveryCallbackCalled = true
			usages, err := reader.Read(childPath, "2026-07-20T00:00:00.000Z", "UTC", nil, "")
			recovered = usages
			return err
		},
	})
	if err != nil {
		t.Fatalf("recovery transaction: %v", err)
	}
	if !recoveryCallbackCalled {
		t.Fatal("recovery callback was not called")
	}
	if len(recovered) != 0 {
		t.Fatalf("recovered = %+v", recovered)
	}
}

func TestNormalizesCacheEntriesWrittenBeforeCacheCreationTokenTracking(t *testing.T) {
	stateDir := t.TempDir()
	childPath := filepath.Join(stateDir, "child.jsonl")
	cachePath := filepath.Join(stateDir, codexSubagentUsageCacheFileName)
	writeRawFile(t, childPath, "{\"type\":\"event_msg\"}\n")
	content, err := os.ReadFile(childPath)
	if err != nil {
		t.Fatalf("read child: %v", err)
	}
	info, err := os.Lstat(childPath)
	if err != nil {
		t.Fatalf("stat child: %v", err)
	}
	dev, ino, ok := sessionfile.FileIdentity(info)
	if !ok {
		t.Skip("file identity is unavailable on this platform")
	}
	key := attributionCacheKey(childPath)
	cache := map[string]any{
		"version":  1,
		"timezone": "UTC",
		"entries": map[string]any{
			key: map[string]any{
				"dev":        float64(dev),
				"ino":        float64(ino),
				"size":       float64(info.Size()),
				"mtimeMs":    codexStatOf(info).mtimeMs,
				"ctimeMs":    codexStatOf(info).ctimeMs,
				"tailSha256": hookSHA256Hex(content),
				"updatedAt":  "2026-05-25T01:20:00.000Z",
				"usages": []any{
					map[string]any{
						"usageDate":       "2026-05-25",
						"inputTokens":     float64(50),
						"outputTokens":    float64(20),
						"cacheReadTokens": float64(150),
						"totalTokens":     float64(220),
					},
				},
			},
		},
	}
	writeRawFile(t, cachePath, mustMarshalString(t, cache)+"\n")

	uncachedReads := 0
	var usages []DatedUsage
	err = WithCodexSubagentUsageCache(CodexSubagentUsageCacheInput{
		StateDir: stateDir,
		Timezone: "UTC",
		ReadChildUsageByDate: func(filePath, timestamp, timezone string, stderr func(string), _ string) ([]DatedUsage, error) {
			uncachedReads++
			return nil, nil
		},
		Callback: func(reader CodexSubagentUsageCacheReader) error {
			var err error
			usages, err = reader.Read(childPath, "2026-05-25T01:00:00.000Z", "UTC", nil, "")
			return err
		},
	})
	if err != nil {
		t.Fatalf("cache transaction: %v", err)
	}
	if uncachedReads != 0 {
		t.Fatalf("uncached reads = %d, want 0", uncachedReads)
	}
	want := DatedUsage{
		UsageDate: "2026-05-25", InputTokens: 50, OutputTokens: 20,
		CacheCreationTokens: 0, CacheReadTokens: 150, TotalTokens: 220,
	}
	if len(usages) != 1 || usages[0] != want {
		t.Fatalf("usages = %+v, want %+v", usages, want)
	}
	persisted, err := readSubagentCacheFileForTest(cachePath)
	if err != nil {
		t.Fatalf("read cache: %v", err)
	}
	entries := persisted["entries"].(map[string]any)
	entry := entries[key].(map[string]any)
	persistedUsages := entry["usages"].([]any)
	persistedUsage := persistedUsages[0].(map[string]any)
	if persistedUsage["cacheCreationTokens"] != float64(0) {
		t.Fatalf("persisted cacheCreationTokens = %v, want 0", persistedUsage["cacheCreationTokens"])
	}
}

func TestRecomputesALegacyCacheEntryWithoutPersistedFileIdentity(t *testing.T) {
	stateDir := t.TempDir()
	childPath := filepath.Join(stateDir, "child.jsonl")
	cachePath := filepath.Join(stateDir, codexSubagentUsageCacheFileName)
	writeRawFile(t, childPath, "{\"type\":\"event_msg\"}\n")
	if err := WithCodexSubagentUsageCache(CodexSubagentUsageCacheInput{
		StateDir: stateDir,
		Timezone: "UTC",
		ReadChildUsageByDate: func(filePath, timestamp, timezone string, stderr func(string), _ string) ([]DatedUsage, error) {
			return nil, nil
		},
		Callback: func(reader CodexSubagentUsageCacheReader) error {
			_, err := reader.Read(childPath, "2026-07-20T00:00:00.000Z", "UTC", nil, "")
			return err
		},
	}); err != nil {
		t.Fatalf("first transaction: %v", err)
	}
	persisted, err := readSubagentCacheFileForTest(cachePath)
	if err != nil {
		t.Fatalf("read cache: %v", err)
	}
	entries := persisted["entries"].(map[string]any)
	key := ""
	for entryKey := range entries {
		key = entryKey
	}
	entry := entries[key].(map[string]any)
	delete(entry, "dev")
	delete(entry, "ino")
	writeRawFile(t, cachePath, mustMarshalString(t, persisted)+"\n")

	uncachedReads := 0
	want := subagentCacheUsageFixture()
	var usages []DatedUsage
	err = WithCodexSubagentUsageCache(CodexSubagentUsageCacheInput{
		StateDir: stateDir,
		Timezone: "UTC",
		ReadChildUsageByDate: func(filePath, timestamp, timezone string, stderr func(string), _ string) ([]DatedUsage, error) {
			uncachedReads++
			return want, nil
		},
		Callback: func(reader CodexSubagentUsageCacheReader) error {
			var err error
			usages, err = reader.Read(childPath, "2026-07-20T00:00:00.000Z", "UTC", nil, "")
			return err
		},
	})
	if err != nil {
		t.Fatalf("second transaction: %v", err)
	}
	if uncachedReads != 1 {
		t.Fatalf("uncached reads = %d, want 1", uncachedReads)
	}
	if len(usages) != 1 || usages[0] != want[0] {
		t.Fatalf("usages = %+v, want %+v", usages, want)
	}
}

func TestRetriesAnUncachedChildReadOnceWhenTheSessionChangesDuringTheFirstRead(t *testing.T) {
	stateDir := t.TempDir()
	childPath := filepath.Join(stateDir, "child.jsonl")
	writeRawFile(t, childPath, "{\"type\":\"event_msg\"}\n")
	reads := 0
	usage := subagentCacheUsageFixture()
	var first []DatedUsage
	err := WithCodexSubagentUsageCache(CodexSubagentUsageCacheInput{
		StateDir: stateDir,
		Timezone: "UTC",
		ReadChildUsageByDate: func(filePath, timestamp, timezone string, stderr func(string), _ string) ([]DatedUsage, error) {
			reads++
			if reads == 1 {
				file, err := os.OpenFile(childPath, os.O_APPEND|os.O_WRONLY, 0o600)
				if err != nil {
					return nil, err
				}
				if _, err := file.WriteString("{\"type\":\"event_msg\"}\n"); err != nil {
					file.Close()
					return nil, err
				}
				if err := file.Close(); err != nil {
					return nil, err
				}
			}
			return usage, nil
		},
		Callback: func(reader CodexSubagentUsageCacheReader) error {
			var err error
			first, err = reader.Read(childPath, "2026-07-20T00:00:00.000Z", "UTC", nil, "")
			return err
		},
	})
	if err != nil {
		t.Fatalf("first transaction: %v", err)
	}
	var second []DatedUsage
	err = WithCodexSubagentUsageCache(CodexSubagentUsageCacheInput{
		StateDir: stateDir,
		Timezone: "UTC",
		ReadChildUsageByDate: func(filePath, timestamp, timezone string, stderr func(string), _ string) ([]DatedUsage, error) {
			reads++
			return nil, nil
		},
		Callback: func(reader CodexSubagentUsageCacheReader) error {
			var err error
			second, err = reader.Read(childPath, "2026-07-20T00:00:00.000Z", "UTC", nil, "")
			return err
		},
	})
	if err != nil {
		t.Fatalf("second transaction: %v", err)
	}
	if reads != 2 {
		t.Fatalf("reads = %d, want 2", reads)
	}
	if len(first) != 1 || len(second) != 1 || first[0] != second[0] {
		t.Fatalf("first = %+v, second = %+v", first, second)
	}
}

func TestFailsWithoutCachingAnUncachedChildSessionThatKeepsChanging(t *testing.T) {
	stateDir := t.TempDir()
	childPath := filepath.Join(stateDir, "child.jsonl")
	cachePath := filepath.Join(stateDir, codexSubagentUsageCacheFileName)
	writeRawFile(t, childPath, "{\"type\":\"event_msg\"}\n")
	reads := 0
	err := WithCodexSubagentUsageCache(CodexSubagentUsageCacheInput{
		StateDir: stateDir,
		Timezone: "UTC",
		ReadChildUsageByDate: func(filePath, timestamp, timezone string, stderr func(string), _ string) ([]DatedUsage, error) {
			reads++
			file, err := os.OpenFile(childPath, os.O_APPEND|os.O_WRONLY, 0o600)
			if err != nil {
				return nil, err
			}
			if _, err := file.WriteString("{\"type\":\"event_msg\"}\n"); err != nil {
				file.Close()
				return nil, err
			}
			if err := file.Close(); err != nil {
				return nil, err
			}
			return nil, nil
		},
		Callback: func(reader CodexSubagentUsageCacheReader) error {
			_, err := reader.Read(childPath, "2026-07-20T00:00:00.000Z", "UTC", nil, "")
			return err
		},
	})
	if err == nil || !strings.Contains(err.Error(), "Codex child session changed while correcting; retry the sync") {
		t.Fatalf("err = %v", err)
	}
	if reads != 2 {
		t.Fatalf("reads = %d, want 2", reads)
	}
	if _, statErr := os.Stat(cachePath); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("cache file exists after an unstable read: %v", statErr)
	}
}

func TestRejectsASymbolicLinkEvenWhenItResolvesToAnUnchangedCachedChildSession(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need elevated privileges on Windows")
	}
	stateDir := t.TempDir()
	childPath := filepath.Join(stateDir, "child.jsonl")
	targetPath := filepath.Join(stateDir, "child-target.jsonl")
	writeRawFile(t, childPath, "{\"type\":\"event_msg\"}\n")
	if err := WithCodexSubagentUsageCache(CodexSubagentUsageCacheInput{
		StateDir: stateDir,
		Timezone: "UTC",
		ReadChildUsageByDate: func(filePath, timestamp, timezone string, stderr func(string), _ string) ([]DatedUsage, error) {
			return nil, nil
		},
		Callback: func(reader CodexSubagentUsageCacheReader) error {
			_, err := reader.Read(childPath, "2026-07-20T00:00:00.000Z", "UTC", nil, "")
			return err
		},
	}); err != nil {
		t.Fatalf("first transaction: %v", err)
	}
	if err := os.Rename(childPath, targetPath); err != nil {
		t.Fatalf("rename: %v", err)
	}
	if err := os.Symlink(targetPath, childPath); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	err := WithCodexSubagentUsageCache(CodexSubagentUsageCacheInput{
		StateDir: stateDir,
		Timezone: "UTC",
		ReadChildUsageByDate: func(filePath, timestamp, timezone string, stderr func(string), _ string) ([]DatedUsage, error) {
			return nil, errors.New("cache lookup must reject the symbolic link before reading it")
		},
		Callback: func(reader CodexSubagentUsageCacheReader) error {
			_, err := reader.Read(childPath, "2026-07-20T00:00:00.000Z", "UTC", nil, "")
			return err
		},
	})
	if err == nil || !strings.Contains(err.Error(),
		"Unable to fingerprint Codex child session: symbolic links are not supported") {
		t.Fatalf("err = %v", err)
	}
}

func TestCacheSerializationMatchesJSONStringify(t *testing.T) {
	dev := 1.0
	ino := 2.0
	ctime := 6.0
	entries := []subagentOrderedEntry{{
		Key: "abc",
		Entry: subagentCacheEntry{
			Dev: &dev, Ino: &ino, Size: 3, MtimeMs: 4.5, CtimeMs: &ctime,
			TailSHA256: "ff",
			Usages: []DatedUsage{{
				UsageDate: "2026-05-25", InputTokens: 50, OutputTokens: 20,
				CacheCreationTokens: 0, CacheReadTokens: 150, TotalTokens: 220,
			}},
			UpdatedAt: "2026-05-25T01:20:00.000Z",
		},
	}}
	want := `{
  "version": 1,
  "timezone": "UTC",
  "entries": {
    "abc": {
      "dev": 1,
      "ino": 2,
      "size": 3,
      "mtimeMs": 4.5,
      "ctimeMs": 6,
      "tailSha256": "ff",
      "usages": [
        {
          "usageDate": "2026-05-25",
          "inputTokens": 50,
          "outputTokens": 20,
          "cacheCreationTokens": 0,
          "cacheReadTokens": 150,
          "totalTokens": 220
        }
      ],
      "updatedAt": "2026-05-25T01:20:00.000Z"
    }
  }
}
`
	if got := string(encodeSubagentCacheState("UTC", entries)); got != want {
		t.Fatalf("serialized cache differs from JSON.stringify:\n got: %q\nwant: %q", got, want)
	}
}

// readSubagentCacheFileForTest decodes the cache file with the package's own
// JS-compatible decoder.
func readSubagentCacheFileForTest(cachePath string) (map[string]any, error) {
	content, err := os.ReadFile(cachePath)
	if err != nil {
		return nil, err
	}
	value, err := decodeSubagentCacheJSON(string(content))
	if err != nil {
		return nil, err
	}
	record, ok := value.(map[string]any)
	if !ok {
		return nil, errors.New("cache root is not an object")
	}
	return record, nil
}
