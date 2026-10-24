package codex

// Port of codex-session-attribution-cache.test.ts. The TS suite mocks
// node:fs/promises to force short reads and a ctime change mid-fingerprint;
// the Go port covers the same observable behavior through the injectable
// fingerprint hook (a fingerprint race) and by exercising the tail-hash unit
// directly with a short-read io.ReaderAt.

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestCreatesAMissingStateDirectoryPrivate(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX directory modes are not meaningful on Windows")
	}
	root := t.TempDir()
	stateDir := filepath.Join(root, "state")

	if err := WithCodexSessionAttributionCache(AttributionCacheInput{
		StateDir: stateDir,
		Timezone: "Asia/Shanghai",
		Callback: func(*CodexSessionAttributionCache) error { return nil },
	}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	if mode := info.Mode().Perm(); mode != 0o700 {
		t.Fatalf("state directory mode = %#o, want 0700", mode)
	}
}

func TestRejectsACacheHitWhenItsSourceSessionChangesBeforeTheTransactionFinishes(t *testing.T) {
	stateDir := t.TempDir()
	sourceDir := t.TempDir()
	sessionFile := filepath.Join(sourceDir, "session.jsonl")
	if err := os.WriteFile(sessionFile, []byte(`{"type":"event_msg"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := WithCodexSessionAttributionCache(AttributionCacheInput{
		StateDir: stateDir,
		Timezone: "Asia/Shanghai",
		Callback: func(cache *CodexSessionAttributionCache) error {
			cached, err := cache.Lookup(sessionFile)
			if err != nil {
				return err
			}
			if cached.Attribution != nil {
				t.Fatalf("first lookup attribution = %v, want nil", cached.Attribution)
			}
			return cache.Store(sessionFile, cached.Fingerprint, CodexSessionAttribution{
				UsageDate: "2026-05-21",
				Model:     "gpt-5.6",
			})
		},
	}); err != nil {
		t.Fatal(err)
	}

	err := WithCodexSessionAttributionCache(AttributionCacheInput{
		StateDir: stateDir,
		Timezone: "Asia/Shanghai",
		Callback: func(cache *CodexSessionAttributionCache) error {
			cached, err := cache.Lookup(sessionFile)
			if err != nil {
				return err
			}
			if cached.Attribution == nil || cached.Attribution.UsageDate != "2026-05-21" || cached.Attribution.Model != "gpt-5.6" {
				t.Fatalf("attribution = %v, want the stored one", cached.Attribution)
			}
			return os.WriteFile(sessionFile, []byte(`{"type":"event_msg","updated":true}`+"\n"), 0o600)
		},
	})
	if err == nil || err.Error() != "Codex session changed while resolving canonical attribution; retry the sync" {
		t.Fatalf("error = %v, want the retryable attribution change", err)
	}
}

func TestReportsARetryableChangeWhenAnObservedSourceDisappearsBeforeCommit(t *testing.T) {
	stateDir := t.TempDir()
	sourceDir := t.TempDir()
	sessionFile := filepath.Join(sourceDir, "session.jsonl")
	if err := os.WriteFile(sessionFile, []byte(`{"type":"event_msg"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	err := WithCodexSessionAttributionCache(AttributionCacheInput{
		StateDir: stateDir,
		Timezone: "Asia/Shanghai",
		Callback: func(cache *CodexSessionAttributionCache) error {
			if _, err := cache.Lookup(sessionFile); err != nil {
				return err
			}
			return os.Remove(sessionFile)
		},
	})
	if err == nil || err.Error() != "Codex session changed while resolving canonical attribution; retry the sync" {
		t.Fatalf("error = %v, want the retryable attribution change", err)
	}
}

func TestFillsASessionTailAcrossShortReadsBeforeHashingIt(t *testing.T) {
	sourceDir := t.TempDir()
	sessionFile := filepath.Join(sourceDir, "session.jsonl")
	content := bytes.Repeat([]byte("x"), 128*1024)
	if err := os.WriteFile(sessionFile, content, 0o600); err != nil {
		t.Fatal(err)
	}

	fingerprint, err := FingerprintCodexSessionFile(sessionFile)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(content[len(content)-64*1024:])
	if want := hex.EncodeToString(sum[:]); fingerprint.TailSHA256 != want {
		t.Fatalf("tail digest = %s, want %s", fingerprint.TailSHA256, want)
	}

	// The TS suite's fs mock caps each read at 97 bytes; the same loop is
	// covered directly here because the Go reader cannot be intercepted.
	short := &shortReaderAt{reader: bytes.NewReader(content), limit: 97}
	calls := 0
	short.onRead = func() { calls++ }
	digest, err := hashCodexSessionTail(short, int64(len(content)))
	if err != nil {
		t.Fatal(err)
	}
	if want := hex.EncodeToString(sum[:]); digest != want {
		t.Fatalf("short-read digest = %s, want %s", digest, want)
	}
	if calls <= 1 {
		t.Fatalf("read calls = %d, want more than 1", calls)
	}
}

func TestSkipsAnOptionalPrewarmWriteWhenItsSourceChangedAfterAFrozenCopy(t *testing.T) {
	stateDir := t.TempDir()
	sourceDir := t.TempDir()
	sessionFile := filepath.Join(sourceDir, "session.jsonl")
	if err := os.WriteFile(sessionFile, []byte(`{"type":"event_msg"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	frozen, err := FingerprintCodexSessionFile(sessionFile)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sessionFile, []byte(`{"type":"event_msg","updated":true}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := WithCodexSessionAttributionCache(AttributionCacheInput{
		StateDir: stateDir,
		Timezone: "Asia/Shanghai",
		Callback: func(cache *CodexSessionAttributionCache) error {
			stored, err := cache.StoreIfUnchanged(sessionFile, frozen, CodexSessionAttribution{
				UsageDate: "2026-05-21",
				Model:     "gpt-5.6",
			})
			if err != nil {
				return err
			}
			if stored {
				t.Fatal("storeIfUnchanged reported a write for a changed source")
			}
			return nil
		},
	}); err != nil {
		t.Fatal(err)
	}
}

func TestSkipsAnOptionalPrewarmWriteWhenItsSourceDisappearedAfterAFrozenCopy(t *testing.T) {
	stateDir := t.TempDir()
	sourceDir := t.TempDir()
	sessionFile := filepath.Join(sourceDir, "session.jsonl")
	if err := os.WriteFile(sessionFile, []byte(`{"type":"event_msg"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	frozen, err := FingerprintCodexSessionFile(sessionFile)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(sessionFile); err != nil {
		t.Fatal(err)
	}

	if err := WithCodexSessionAttributionCache(AttributionCacheInput{
		StateDir: stateDir,
		Timezone: "Asia/Shanghai",
		Callback: func(cache *CodexSessionAttributionCache) error {
			stored, err := cache.StoreIfUnchanged(sessionFile, frozen, CodexSessionAttribution{
				UsageDate: "2026-05-21",
				Model:     "gpt-5.6",
			})
			if err != nil {
				return err
			}
			if stored {
				t.Fatal("storeIfUnchanged reported a write for a vanished source")
			}
			return nil
		},
	}); err != nil {
		t.Fatal(err)
	}
}

func TestSkipsAnOptionalPrewarmWriteWhenTheSourceChangesWhileFingerprinting(t *testing.T) {
	stateDir := t.TempDir()
	sourceDir := t.TempDir()
	sessionFile := filepath.Join(sourceDir, "session.jsonl")
	if err := os.WriteFile(sessionFile, []byte(`{"type":"event_msg"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	frozen, err := FingerprintCodexSessionFile(sessionFile)
	if err != nil {
		t.Fatal(err)
	}

	if err := WithCodexSessionAttributionCache(AttributionCacheInput{
		StateDir: stateDir,
		Timezone: "Asia/Shanghai",
		// The TS suite's lstat mock makes the second stat disagree with the
		// first; the observable result is the fingerprint race.
		Fingerprint: func(string) (CodexSessionFileFingerprint, error) {
			return CodexSessionFileFingerprint{}, errCodexSessionFingerprintRace
		},
		Callback: func(cache *CodexSessionAttributionCache) error {
			stored, err := cache.StoreIfUnchanged(sessionFile, frozen, CodexSessionAttribution{
				UsageDate: "2026-05-21",
				Model:     "gpt-5.6",
			})
			if err != nil {
				return err
			}
			if stored {
				t.Fatal("storeIfUnchanged reported a write for a racing source")
			}
			return nil
		},
	}); err != nil {
		t.Fatal(err)
	}
}

func TestReusesAnAttributionThatMatchesAFrozenFingerprintAfterTheLiveSourceChanges(t *testing.T) {
	stateDir := t.TempDir()
	sourceDir := t.TempDir()
	sessionFile := filepath.Join(sourceDir, "session.jsonl")
	if err := os.WriteFile(sessionFile, []byte(`{"type":"event_msg"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	frozen, err := FingerprintCodexSessionFile(sessionFile)
	if err != nil {
		t.Fatal(err)
	}
	if err := WithCodexSessionAttributionCache(AttributionCacheInput{
		StateDir: stateDir,
		Timezone: "Asia/Shanghai",
		Callback: func(cache *CodexSessionAttributionCache) error {
			return cache.Store(sessionFile, frozen, CodexSessionAttribution{
				UsageDate: "2026-05-21",
				Model:     "gpt-5.6",
			})
		},
	}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sessionFile, []byte(`{"type":"event_msg","updated":true}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := WithCodexSessionAttributionCache(AttributionCacheInput{
		StateDir: stateDir,
		Timezone: "Asia/Shanghai",
		Callback: func(cache *CodexSessionAttributionCache) error {
			attribution := cache.LookupByFingerprint(sessionFile, frozen)
			if attribution == nil || attribution.UsageDate != "2026-05-21" || attribution.Model != "gpt-5.6" {
				t.Fatalf("LookupByFingerprint = %v, want the stored attribution", attribution)
			}
			return nil
		},
	}); err != nil {
		t.Fatal(err)
	}
}

func TestDoesNotReuseALegacyAttributionCacheEntryWithoutPersistedFileIdentity(t *testing.T) {
	stateDir := t.TempDir()
	sourceDir := t.TempDir()
	sessionFile := filepath.Join(sourceDir, "session.jsonl")
	cachePath := filepath.Join(stateDir, codexSessionAttributionCacheFileName)
	content := []byte(`{"type":"event_msg"}` + "\n")
	if err := os.WriteFile(sessionFile, content, 0o600); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(sessionFile)
	if err != nil {
		t.Fatal(err)
	}
	stat := codexStatOf(info)
	sum := sha256.Sum256(content)
	key := attributionCacheKey(sessionFile)
	entry := map[string]any{
		"size":       float64(stat.size),
		"mtimeMs":    stat.mtimeMs,
		"ctimeMs":    stat.ctimeMs,
		"tailSha256": hex.EncodeToString(sum[:]),
		"updatedAt":  "2026-07-20T00:00:00.000Z",
		"usageDate":  "2026-07-20",
		"model":      "gpt-5.6",
	}
	payload, err := json.Marshal(map[string]any{
		"version":  1,
		"timezone": "Asia/Shanghai",
		"entries":  map[string]any{key: entry},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cachePath, append(payload, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := WithCodexSessionAttributionCache(AttributionCacheInput{
		StateDir: stateDir,
		Timezone: "Asia/Shanghai",
		Callback: func(cache *CodexSessionAttributionCache) error {
			cached, err := cache.Lookup(sessionFile)
			if err != nil {
				return err
			}
			if cached.Attribution != nil {
				t.Fatalf("legacy attribution = %v, want nil", cached.Attribution)
			}
			return nil
		},
	}); err != nil {
		t.Fatal(err)
	}
}

func TestRejectsASymbolicLinkSubstitutedForAnAttributionCacheSource(t *testing.T) {
	stateDir := t.TempDir()
	sourceDir := t.TempDir()
	sessionFile := filepath.Join(sourceDir, "session.jsonl")
	targetFile := filepath.Join(sourceDir, "session-target.jsonl")
	if err := os.WriteFile(sessionFile, []byte(`{"type":"event_msg"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := WithCodexSessionAttributionCache(AttributionCacheInput{
		StateDir: stateDir,
		Timezone: "Asia/Shanghai",
		Callback: func(cache *CodexSessionAttributionCache) error {
			cached, err := cache.Lookup(sessionFile)
			if err != nil {
				return err
			}
			return cache.Store(sessionFile, cached.Fingerprint, CodexSessionAttribution{
				UsageDate: "2026-05-21",
				Model:     "gpt-5.6",
			})
		},
	}); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(sessionFile, targetFile); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(targetFile, sessionFile); err != nil {
		t.Skipf("this environment cannot create symbolic links: %v", err)
	}

	err := WithCodexSessionAttributionCache(AttributionCacheInput{
		StateDir: stateDir,
		Timezone: "Asia/Shanghai",
		Callback: func(cache *CodexSessionAttributionCache) error {
			_, err := cache.Lookup(sessionFile)
			return err
		},
	})
	if err == nil || err.Error() != "Unable to inspect Codex session file: symbolic links are not supported" {
		t.Fatalf("error = %v, want the symlink rejection", err)
	}
}

func TestRejectsAMalformedCacheInsteadOfSilentlyIgnoringIt(t *testing.T) {
	stateDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(stateDir, codexSessionAttributionCacheFileName), []byte("{invalid"), 0o600); err != nil {
		t.Fatal(err)
	}
	err := WithCodexSessionAttributionCache(AttributionCacheInput{
		StateDir: stateDir,
		Timezone: "Asia/Shanghai",
		Callback: func(*CodexSessionAttributionCache) error { return nil },
	})
	if err == nil || err.Error() != "Invalid Codex session attribution cache JSON" {
		t.Fatalf("error = %v, want the malformed-JSON rejection", err)
	}
}

func TestDiscardsAnOversizedCacheAndRebuildsItInsteadOfFailingTheSync(t *testing.T) {
	stateDir := t.TempDir()
	cachePath := filepath.Join(stateDir, codexSessionAttributionCacheFileName)
	if err := os.WriteFile(cachePath, bytes.Repeat([]byte("x"), 9*1024*1024), 0o600); err != nil {
		t.Fatal(err)
	}
	ran := false
	if err := WithCodexSessionAttributionCache(AttributionCacheInput{
		StateDir: stateDir,
		Timezone: "Asia/Shanghai",
		Callback: func(*CodexSessionAttributionCache) error {
			ran = true
			return nil
		},
	}); err != nil {
		t.Fatal(err)
	}
	if !ran {
		t.Fatal("the callback did not run")
	}
	rebuilt, err := os.ReadFile(cachePath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(rebuilt), `"version"`) {
		t.Fatalf("rebuilt cache = %s, want a cache document", rebuilt)
	}
}

func TestBoundsRetainedEntriesBySerializedSizeAsWellAsEntryCount(t *testing.T) {
	nowMs := float64(time.Date(2026, 9, 2, 0, 0, 0, 0, time.UTC).UnixMilli())
	entries := make(map[string]CacheEntry, codexSessionAttributionMaxEntries)
	usedKeys := make(map[string]bool, codexSessionAttributionMaxEntries)
	model := "model-" + strings.Repeat("x", 500)
	for index := 0; index < codexSessionAttributionMaxEntries; index++ {
		key := fmt.Sprintf("%064x", index)
		dev := float64(1)
		ino := float64(index + 1)
		entries[key] = CacheEntry{
			Dev:        &dev,
			Ino:        &ino,
			Size:       1,
			MtimeMs:    1,
			CtimeMs:    1,
			TailSHA256: strings.Repeat("a", 64),
			UpdatedAt:  time.UnixMilli(int64(nowMs) - int64(20_000) + int64(index)).UTC().Format("2006-01-02T15:04:05.000Z"),
			UsageDate:  "2026-09-01",
			Model:      model,
		}
		usedKeys[key] = true
	}

	retained := RetainCacheEntries(entries, usedKeys, nowMs, "UTC")
	serialized := encodeAttributionCacheState(attributionCacheState{
		Version:  1,
		Timezone: "UTC",
		Entries:  retained,
	})
	if len(retained) > codexSessionAttributionMaxEntries {
		t.Fatalf("retained %d entries, want at most %d", len(retained), codexSessionAttributionMaxEntries)
	}
	if len(retained) >= codexSessionAttributionMaxEntries {
		t.Fatalf("retained %d entries, want fewer than %d after the size trim", len(retained), codexSessionAttributionMaxEntries)
	}
	if len(serialized) > codexSessionAttributionMaxBytes {
		t.Fatalf("serialized %d bytes, want at most %d", len(serialized), codexSessionAttributionMaxBytes)
	}
	if _, ok := retained[strings.Repeat("0", 64)]; ok {
		t.Fatal("the oldest entry was retained")
	}
	if _, ok := retained[fmt.Sprintf("%064x", codexSessionAttributionMaxEntries-1)]; !ok {
		t.Fatal("the newest entry was dropped")
	}
}

func TestRejectsAnImpossibleCanonicalDate(t *testing.T) {
	stateDir := t.TempDir()
	sourceDir := t.TempDir()
	sessionFile := filepath.Join(sourceDir, "session.jsonl")
	if err := os.WriteFile(sessionFile, []byte(`{"type":"event_msg"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	err := WithCodexSessionAttributionCache(AttributionCacheInput{
		StateDir: stateDir,
		Timezone: "Asia/Shanghai",
		Callback: func(cache *CodexSessionAttributionCache) error {
			cached, err := cache.Lookup(sessionFile)
			if err != nil {
				return err
			}
			return cache.Store(sessionFile, cached.Fingerprint, CodexSessionAttribution{
				UsageDate: "2026-02-30",
				Model:     "gpt-5.6",
			})
		},
	})
	if err == nil || err.Error() != "Invalid Codex canonical session date" {
		t.Fatalf("error = %v, want the canonical-date rejection", err)
	}
}

func TestStoreFailsWhenTheFingerprintNoLongerDescribesTheFile(t *testing.T) {
	stateDir := t.TempDir()
	sourceDir := t.TempDir()
	sessionFile := filepath.Join(sourceDir, "session.jsonl")
	if err := os.WriteFile(sessionFile, []byte(`{"type":"event_msg"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	frozen, err := FingerprintCodexSessionFile(sessionFile)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sessionFile, []byte(`{"type":"event_msg","updated":true}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	err = WithCodexSessionAttributionCache(AttributionCacheInput{
		StateDir: stateDir,
		Timezone: "Asia/Shanghai",
		Callback: func(cache *CodexSessionAttributionCache) error {
			return cache.Store(sessionFile, frozen, CodexSessionAttribution{
				UsageDate: "2026-05-21",
				Model:     "gpt-5.6",
			})
		},
	})
	if !errors.Is(err, errCodexSessionAttributionRace) {
		t.Fatalf("error = %v, want the attribution race", err)
	}
}

// shortReaderAt caps every read at limit bytes, which is what the TS proxy
// around FileHandle#read does.
type shortReaderAt struct {
	reader *bytes.Reader
	limit  int
	onRead func()
}

func (r *shortReaderAt) ReadAt(buffer []byte, offset int64) (int, error) {
	if r.onRead != nil {
		r.onRead()
	}
	length := len(buffer)
	if length > r.limit {
		length = r.limit
	}
	return r.reader.ReadAt(buffer[:length], offset)
}
