package antigravitycli

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravityscan"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessioncursor"
)

func TestPreservesAllReusableRowCursorsWhenBoundedScopeMovesForward(t *testing.T) {
	state := sessioncursor.NewState("antigravity-cli")
	earlierScope := scopeFor(t, "20260601")
	currentScope := scopeFor(t, "20260624")

	MarkCLIDbRowsProcessed(MarkCLIDbRowsProcessedInput{
		State:                     &state,
		HistoryScope:              earlierScope,
		LastReadRowIndexByCascade: map[string]int64{"cascade-a": 4, "cascade-b": 7},
	})
	MarkCLIDbRowsProcessed(MarkCLIDbRowsProcessedInput{
		State:                     &state,
		HistoryScope:              currentScope,
		LastReadRowIndexByCascade: map[string]int64{"cascade-a": 5},
	})

	assertRowIndexes(t, state, currentScope, map[string]int64{
		hashString("cascade-a"): 5,
		hashString("cascade-b"): 7,
	})
}

func TestKeepsBoundedRowCursorsSeparateFromAllScope(t *testing.T) {
	state := sessioncursor.NewState("antigravity-cli")
	boundedScope := scopeFor(t, "20260624")

	MarkCLIDbRowsProcessed(MarkCLIDbRowsProcessedInput{
		State:                     &state,
		HistoryScope:              "all",
		LastReadRowIndexByCascade: map[string]int64{"cascade-a": 4},
	})
	MarkCLIDbRowsProcessed(MarkCLIDbRowsProcessedInput{
		State:                     &state,
		HistoryScope:              boundedScope,
		LastReadRowIndexByCascade: map[string]int64{"cascade-a": 7},
	})

	if !anyKeyContains(state, "since:") {
		t.Fatal("expected a since: scoped key in the cursor")
	}
	assertRowIndexes(t, state, boundedScope, map[string]int64{hashString("cascade-a"): 7})
}

func TestPrunesRowCursorsForCascadesAbsentFromCompleteListing(t *testing.T) {
	state := sessioncursor.NewState("antigravity-cli")
	boundedScope := scopeFor(t, "20260624")

	MarkCLIDbRowsProcessed(MarkCLIDbRowsProcessedInput{
		State:                     &state,
		HistoryScope:              "all",
		LastReadRowIndexByCascade: map[string]int64{"cascade-a": 4, "cascade-b": 7},
	})
	MarkCLIDbRowsProcessed(MarkCLIDbRowsProcessedInput{
		State:                     &state,
		HistoryScope:              boundedScope,
		LastReadRowIndexByCascade: map[string]int64{"cascade-a": 5, "cascade-b": 8},
	})
	// A complete listing that no longer contains cascade-b must forget it.
	MarkCLIDbRowsProcessed(MarkCLIDbRowsProcessedInput{
		State:                     &state,
		HistoryScope:              boundedScope,
		KnownCascadeIDs:           map[string]bool{"cascade-a": true},
		LastReadRowIndexByCascade: map[string]int64{"cascade-a": 6},
	})

	assertRowIndexes(t, state, boundedScope, map[string]int64{hashString("cascade-a"): 6})
	if anyKeyContains(state, hashString("cascade-b")) {
		t.Fatal("expected the absent cascade's row cursor to be pruned")
	}
}

func TestRetainsRowCursorsWithoutCompleteListing(t *testing.T) {
	state := sessioncursor.NewState("antigravity-cli")

	MarkCLIDbRowsProcessed(MarkCLIDbRowsProcessedInput{
		State:                     &state,
		HistoryScope:              "all",
		LastReadRowIndexByCascade: map[string]int64{"cascade-a": 4, "cascade-b": 7},
	})
	// No KnownCascadeIDs: an incomplete listing must not prune anything, and
	// cascade-b's cursor survives untouched.
	MarkCLIDbRowsProcessed(MarkCLIDbRowsProcessedInput{
		State:                     &state,
		HistoryScope:              "all",
		LastReadRowIndexByCascade: map[string]int64{"cascade-a": 5},
	})

	assertRowIndexes(t, state, "all", map[string]int64{
		hashString("cascade-a"): 5,
		hashString("cascade-b"): 7,
	})
}

func TestRecognizesLegacyRowCursorsWithoutAnchors(t *testing.T) {
	state := sessioncursor.NewState("antigravity-cli")
	cascadeHash := hashString("cascade-a")
	state.Files[cursorPrefixCLIDbCascade+cascadeHash] = sessioncursor.Entry{
		MtimeMs:     41,
		SHA256:      strings.Repeat("0", 64),
		Snapshots:   []sessioncursor.Snapshot{},
		MissingCost: true,
		UpdatedAt:   "1970-01-01T00:00:00.000Z",
	}

	if !HasUnanchoredCLIDbRowCursor(state, "all") {
		t.Fatal("expected a cursor with no scan state to be unanchored")
	}
	setScanEntry(t, &state, cascadeHash, antigravityscan.FileScanEntry{
		MtimeMs:                 1,
		Size:                    1,
		HasDatabaseFile:         true,
		MetadataCursorRowIndex:  int64Ptr(41),
		MetadataCursorRowSHA256: strPtr(strings.Repeat("a", 64)),
	})
	if HasUnanchoredCLIDbRowCursor(state, "all") {
		t.Fatal("expected the anchored cursor to be accepted")
	}
	setScanEntry(t, &state, cascadeHash, antigravityscan.FileScanEntry{
		MtimeMs:                 1,
		Size:                    1,
		HasDatabaseFile:         true,
		MetadataCursorRowIndex:  int64Ptr(40),
		MetadataCursorRowSHA256: strPtr(strings.Repeat("a", 64)),
	})
	if !HasUnanchoredCLIDbRowCursor(state, "all") {
		t.Fatal("expected an anchor pointing at a different row to be unanchored")
	}
}

func TestReusesExplicitEmptyDatabaseAnchor(t *testing.T) {
	state := sessioncursor.NewState("antigravity-cli")
	cascadeHash := hashString("cascade-a")
	pendingFalse := false
	state.Files[cursorPrefixCLIDbCascade+cascadeHash] = sessioncursor.Entry{
		MtimeMs:       -1,
		SHA256:        strings.Repeat("0", 64),
		Snapshots:     []sessioncursor.Snapshot{},
		MissingCost:   true,
		PendingUpload: &pendingFalse,
		UpdatedAt:     "1970-01-01T00:00:00.000Z",
	}
	setScanEntry(t, &state, cascadeHash, antigravityscan.FileScanEntry{
		MtimeMs:                 1,
		Size:                    0,
		HasDatabaseFile:         true,
		MetadataCursorRowIndex:  int64Ptr(-1),
		MetadataCursorRowSHA256: strPtr(sha256HexOf(nil)),
	})

	if HasUnanchoredCLIDbRowCursor(state, "all") {
		t.Fatal("expected the empty-database anchor to be reused")
	}
}

func TestBoundedScopePrunesNonReusableBoundedScopes(t *testing.T) {
	state := sessioncursor.NewState("antigravity-cli")
	newerScope := scopeFor(t, "20260624")
	olderScope := scopeFor(t, "20260601")

	MarkCLIDbRowsProcessed(MarkCLIDbRowsProcessedInput{
		State:                     &state,
		HistoryScope:              newerScope,
		LastReadRowIndexByCascade: map[string]int64{"cascade-a": 9},
	})
	// A run under an earlier window cannot reuse the later window's cursor, and
	// must drop it rather than silently reading the file from row 9.
	MarkCLIDbRowsProcessed(MarkCLIDbRowsProcessedInput{
		State:                     &state,
		HistoryScope:              olderScope,
		LastReadRowIndexByCascade: map[string]int64{"cascade-a": 2},
	})

	assertRowIndexes(t, state, olderScope, map[string]int64{hashString("cascade-a"): 2})
	if anyKeyContains(state, newerScope) {
		t.Fatal("expected the no-longer-reusable bounded scope to be dropped")
	}
}

func TestNormalizesUnusableRowIndexesToNeverRead(t *testing.T) {
	cases := []struct {
		name    string
		mtimeMs float64
		want    int64
	}{
		{"fractional", 41.5, -1},
		{"beyond max safe integer", float64(int64(1)<<53) + 2, -1},
		{"below minus one", -2, -1},
		{"minus one is a real cursor", -1, -1},
		{"zero is a real cursor", 0, 0},
		{"max safe integer", float64(int64(1)<<53 - 1), int64(1)<<53 - 1},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			state := sessioncursor.NewState("antigravity-cli")
			state.Files[cursorPrefixCLIDbCascade+hashString("cascade-a")] = sessioncursor.Entry{
				MtimeMs:     testCase.mtimeMs,
				SHA256:      strings.Repeat("0", 64),
				Snapshots:   []sessioncursor.Snapshot{},
				MissingCost: true,
				UpdatedAt:   "1970-01-01T00:00:00.000Z",
			}
			got := LastSeenCLIDbRowIndexByCascadeHash(state, "all")
			if got[hashString("cascade-a")] != testCase.want {
				t.Fatalf("row index = %d, want %d", got[hashString("cascade-a")], testCase.want)
			}
		})
	}
}

// --- helpers -------------------------------------------------------------

// scopeFor resolves the history scope for a since date, the way the TS tests
// reach for resolveAntigravityCollectionRange.
func scopeFor(t *testing.T, since string) string {
	t.Helper()
	sinceCopy := since
	resolved, err := antigravityscan.ResolveCollectionRange(&sinceCopy, "UTC", func(string) string { return "" })
	if err != nil {
		t.Fatalf("resolve range for %s: %v", since, err)
	}
	return resolved.HistoryScope
}

func assertRowIndexes(t *testing.T, state sessioncursor.State, scope string, want map[string]int64) {
	t.Helper()
	got := LastSeenCLIDbRowIndexByCascadeHash(state, scope)
	if len(got) != len(want) {
		t.Fatalf("row indexes = %v, want %v", got, want)
	}
	for key, value := range want {
		if got[key] != value {
			t.Fatalf("row index for %s = %d, want %d", key[:12], got[key], value)
		}
	}
}

func anyKeyContains(state sessioncursor.State, fragment string) bool {
	for key := range state.Files {
		if strings.Contains(key, fragment) {
			return true
		}
	}
	return false
}

// setScanEntry installs one file-scan entry, keeping any other entries.
func setScanEntry(t *testing.T, state *sessioncursor.State, cascadeHash string, entry antigravityscan.FileScanEntry) {
	t.Helper()
	scan := cursorDBFileScan(*state)
	scan.Files[cascadeHash] = entry
	if err := setCursorDBFileScan(state, scan); err != nil {
		t.Fatalf("set scan state: %v", err)
	}
}

func int64Ptr(value int64) *int64 { return &value }
func strPtr(value string) *string { return &value }

func sha256HexOf(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}
