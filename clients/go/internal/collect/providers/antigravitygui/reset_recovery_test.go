package antigravitygui

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravityhistory"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravitymeta"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// The cursor-reset recovery chain: a full-history run whose SQLite row cursor
// no longer matches the rebuilt database resets the derived state, re-reads
// once, and queues the zero corrections that cancel the usage the reset
// discarded. Without this chain a rebuilt database either double-counts or
// loses history silently.

// resetRecoveryRead is the successful read both rounds share.
func resetRecoveryRead() antigravityhistory.Result {
	return antigravityhistory.Result{
		CascadeIDs:                map[string]bool{"conversation-db": true},
		Events:                    []antigravitymeta.UsageEvent{guiDbEvent()},
		KnownCascadeIDs:           map[string]bool{"conversation-db": true},
		LastReadRowIndexByCascade: map[string]int64{"conversation-db": 41},
		CompleteDirectoryScan:     true,
	}
}

func TestCollectGuiRecoversFromASQLiteRowCursorReset(t *testing.T) {
	options, stateDir := guiTestOptions(t, "antigravity", nil)
	options.Since = "all"
	options.ReadDbUsageEvents = func(antigravityhistory.Options) (antigravityhistory.Result, error) {
		return resetRecoveryRead(), nil
	}

	// Round one records the row progress the reset will later invalidate. Its
	// snapshots are acknowledged first: a reset may only discard database
	// usage the server already has, which is the guard's whole point.
	first, err := Collect(options)
	if err != nil {
		t.Fatalf("first collect: %v", err)
	}
	groups := map[string]bool{}
	for _, snapshot := range first {
		groups[snapshot.AckGroupKey()] = true
	}
	if err := AcknowledgeSourceCursor(AcknowledgeSourceInput{
		StateDir: stateDir, Source: contract.SourceAntigravity,
		AcknowledgedGroups: groups, Timezone: guiTimezone,
	}); err != nil {
		t.Fatalf("acknowledge: %v", err)
	}
	seeded, err := os.ReadFile(filepath.Join(stateDir, "antigravity-cursor.json"))
	if err != nil {
		t.Fatalf("read cursor: %v", err)
	}

	// Round two: the first read reports the reset, the retry must see a cursor
	// whose database state the recovery already cleared, and its corrections
	// must be queued for upload.
	attempts := 0
	var retryAnchors map[string]int64
	var retryScanEmpty bool
	options.ReadDbUsageEvents = func(readOptions antigravityhistory.Options) (antigravityhistory.Result, error) {
		attempts++
		if attempts == 1 {
			return antigravityhistory.Result{}, &antigravityhistory.RowCursorResetError{
				DBFile: "/tmp/11111111-1111-1111-1111-111111111111.db",
			}
		}
		retryAnchors = readOptions.LastSeenRowIndexByCascadeHash
		retryScanEmpty = readOptions.ScanState == nil || len(readOptions.ScanState.Files) == 0
		return resetRecoveryRead(), nil
	}
	options.CollectedAt = "2026-06-24T02:05:00.000Z"
	var diagnostics strings.Builder
	options.Stderr = func(line string) { diagnostics.WriteString(line + "\n") }

	snapshots, err := Collect(options)
	if err != nil {
		t.Fatalf("recovery collect: %v", err)
	}
	if attempts != 2 {
		t.Fatalf("read attempts = %d, want the reset read plus exactly one retry", attempts)
	}
	if !strings.Contains(diagnostics.String(), "cursor reset detected; rebuilding full local database history once") {
		t.Fatalf("diagnostics = %q, want the reset notice", diagnostics.String())
	}
	if len(retryAnchors) != 0 {
		t.Fatalf("retry row anchors = %v, want the reset to have cleared them", retryAnchors)
	}
	if !retryScanEmpty {
		t.Fatal("retry scan state = non-empty, want the reset to have replaced it")
	}
	if len(snapshots) == 0 {
		t.Fatal("the rebuilt read produced no snapshots")
	}

	raw, readErr := os.ReadFile(filepath.Join(stateDir, "antigravity-cursor.json"))
	if readErr != nil {
		t.Fatalf("read cursor: %v", readErr)
	}
	if !strings.Contains(string(raw), "gui-db-reset-correction") {
		t.Fatalf("cursor = %s, want the queued reset corrections", raw)
	}
	var seededCursor map[string]any
	if err := json.Unmarshal(seeded, &seededCursor); err != nil {
		t.Fatal(err)
	}
	files, _ := seededCursor["files"].(map[string]any)
	keys := make([]string, 0, len(files))
	for key := range files {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	anchors := 0
	for _, key := range keys {
		if strings.HasPrefix(key, "db\x00") {
			anchors++
		}
	}
	if anchors != 1 {
		t.Fatalf("row anchors after round one = %d in keys %v, want 1", anchors, keys)
	}
}

func TestCollectGuiFailsWhenTheResetRetryAlsoFails(t *testing.T) {
	// A retry that fails too is a real failure, not a partial result: there is
	// no history to upload, and reporting success would hide the loss.
	options, _ := guiTestOptions(t, "antigravity", nil)
	options.Since = "all"
	options.ReadDbUsageEvents = func(antigravityhistory.Options) (antigravityhistory.Result, error) {
		return resetRecoveryRead(), nil
	}
	first, err := Collect(options)
	if err != nil {
		t.Fatalf("first collect: %v", err)
	}
	groups := map[string]bool{}
	for _, snapshot := range first {
		groups[snapshot.AckGroupKey()] = true
	}
	if err := AcknowledgeSourceCursor(AcknowledgeSourceInput{
		StateDir: options.StateDir, Source: contract.SourceAntigravity,
		AcknowledgedGroups: groups, Timezone: guiTimezone,
	}); err != nil {
		t.Fatalf("acknowledge: %v", err)
	}

	calls := 0
	options.ReadDbUsageEvents = func(antigravityhistory.Options) (antigravityhistory.Result, error) {
		calls++
		return antigravityhistory.Result{}, &antigravityhistory.RowCursorResetError{DBFile: "/tmp/a.db"}
	}
	options.CollectedAt = "2026-06-24T02:05:00.000Z"

	_, err = Collect(options)
	if err == nil {
		t.Fatal("a failed reset retry must surface")
	}
	if !strings.Contains(err.Error(), "cursor reset recovery failed") {
		t.Fatalf("err = %v, want the recovery failure", err)
	}
	if calls != 2 {
		t.Fatalf("read calls = %d, want exactly one retry", calls)
	}
}
