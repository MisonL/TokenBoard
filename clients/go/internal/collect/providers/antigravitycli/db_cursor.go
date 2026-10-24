package antigravitycli

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravityscan"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessioncursor"
)

// The database row cursor keys. Each cascade's acknowledged row index is
// stored as its own cursor entry so a bounded run's progress is independent of
// the all-history scope's.
const (
	cursorPrefixCLIDbCascade = "db-row\x00antigravity-cli\x00"
	cursorPrefixCLIDbBounded = cursorPrefixCLIDbCascade + "since:"
)

var sha256HexPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

// maxSafeInteger is Number.MAX_SAFE_INTEGER: a row index beyond it is not a
// value the TypeScript reader would accept.
const maxSafeInteger = float64(int64(1)<<53 - 1)

// LastSeenCLIDbRowIndexByCascadeHash returns, per cascade, the row index a
// previous run acknowledged.
//
// Under a bounded scope the all-scope entries are reusable when the bounded
// scope's date has not moved backwards, so a cursor written by a wider run
// still seeds a narrower one. Values are normalised the way the reader
// normalises them: anything that is not a safe integer of at least -1 reads
// as -1, i.e. "never read".
func LastSeenCLIDbRowIndexByCascadeHash(state sessioncursor.State, historyScope string) map[string]int64 {
	indexes := lastSeenCLIDbRowMtimeByCascadeHash(state, historyScope)
	normalized := make(map[string]int64, len(indexes))
	for cascadeHash, mtimeMs := range indexes {
		normalized[cascadeHash] = normalizeCLIDbRowIndex(mtimeMs)
	}
	return normalized
}

// lastSeenCLIDbRowMtimeByCascadeHash keeps the raw stored values: the highest
// mtime wins, and the reader normalises afterwards.
func lastSeenCLIDbRowMtimeByCascadeHash(state sessioncursor.State, historyScope string) map[string]float64 {
	if historyScope == "" {
		historyScope = "all"
	}
	indexes := map[string]float64{}
	for key, entry := range state.Files {
		cascadeHash, ok := parseCLIDbCascadeHash(key, historyScope)
		if !ok {
			continue
		}
		if current, seen := indexes[cascadeHash]; seen && current >= entry.MtimeMs {
			continue
		}
		indexes[cascadeHash] = entry.MtimeMs
	}
	return indexes
}

// normalizeCLIDbRowIndex mirrors the reader's normalizeLastSeenRowIndex.
func normalizeCLIDbRowIndex(value float64) int64 {
	if value != value || value > maxSafeInteger || value < -1 || value != float64(int64(value)) {
		return -1
	}
	return int64(value)
}

// HasUnanchoredCLIDbRowCursor reports whether any acknowledged row cursor
// lacks the SQLite continuity anchor that proves it still describes the same
// row.
func HasUnanchoredCLIDbRowCursor(state sessioncursor.State, historyScope string) bool {
	return len(UnanchoredCLIDbRowCursorHashes(state, historyScope)) > 0
}

// UnanchoredCLIDbRowCursorHashes returns those cascades whose row cursor
// cannot be continued incrementally, so the caller must re-read them in full.
func UnanchoredCLIDbRowCursorHashes(state sessioncursor.State, historyScope string) map[string]bool {
	unanchored := map[string]bool{}
	rowIndexes := lastSeenCLIDbRowMtimeByCascadeHash(state, historyScope)
	if len(rowIndexes) == 0 {
		return unanchored
	}
	scanFiles := cursorDBFileScan(state).Files
	for cascadeHash, mtimeMs := range rowIndexes {
		entry, ok := scanFiles[cascadeHash]
		// The comparison mirrors the TS one exactly: the anchor must name the
		// same row as the stored value, without rounding the stored one first.
		if !ok ||
			entry.MetadataCursorRowIndex == nil ||
			float64(*entry.MetadataCursorRowIndex) != mtimeMs ||
			entry.MetadataCursorRowSHA256 == nil ||
			!sha256HexPattern.MatchString(*entry.MetadataCursorRowSHA256) {
			unanchored[cascadeHash] = true
		}
	}
	return unanchored
}

// MarkCLIDbRowsProcessedInput records the row index each cascade was read
// through. KnownCascadeIDs nil means the caller had no complete listing and
// nothing may be pruned; a non-nil empty map means the directory is empty.
type MarkCLIDbRowsProcessedInput struct {
	State                     *sessioncursor.State
	KnownCascadeIDs           map[string]bool
	LastReadRowIndexByCascade map[string]int64
	HistoryScope              string
	// CollectedAt stamps the entries; empty uses the wall clock, matching the
	// TypeScript writer's per-entry `new Date().toISOString()`.
	CollectedAt string
}

// MarkCLIDbRowsProcessed persists the read progress. Moving a bounded scope
// forward migrates the reusable bounded entries to the new scope's keys, and a
// complete directory listing prunes cascades that no longer exist.
func MarkCLIDbRowsProcessed(input MarkCLIDbRowsProcessedInput) {
	state := input.State
	historyScope := input.HistoryScope
	if historyScope == "" {
		historyScope = "all"
	}
	prefix := cliDbCascadeCursorPrefixForScope(historyScope)
	if historyScope != "all" {
		reusable := reusableCLIDbScopes(*state, historyScope)
		for _, key := range sortedCursorKeys(state.Files) {
			parsed, ok := parseCLIDbBoundedKey(key)
			if !ok {
				continue
			}
			if !reusable[parsed.scope] {
				delete(state.Files, key)
				continue
			}
			nextKey := prefix + parsed.cascadeHash
			if nextKey == key {
				continue
			}
			// Whichever reusable scope holds the higher row mtime wins, so the
			// migrated entry never loses ground.
			if existing, seen := state.Files[nextKey]; !seen || existing.MtimeMs < state.Files[key].MtimeMs {
				state.Files[nextKey] = state.Files[key]
			}
			delete(state.Files, key)
		}
	}
	pendingFalse := false
	for cascadeID, rowIndex := range input.LastReadRowIndexByCascade {
		key := prefix + hashString(cascadeID)
		state.Files[key] = sessioncursor.Entry{
			Size:          0,
			MtimeMs:       float64(rowIndex),
			SHA256:        hashString(key),
			Snapshots:     []sessioncursor.Snapshot{},
			MissingCost:   true,
			PendingUpload: &pendingFalse,
			UpdatedAt:     collectedAtOrNow(input.CollectedAt),
		}
	}
	if input.KnownCascadeIDs != nil {
		pruneAbsentCLIDbRowCursors(state, input.KnownCascadeIDs)
	}
}

func cliDbCascadeCursorPrefixForScope(historyScope string) string {
	if historyScope == "all" {
		return cursorPrefixCLIDbCascade
	}
	return cursorPrefixCLIDbBounded + historyScope + "\x00"
}

// reusableCLIDbScopes collects the bounded scopes already in the cursor whose
// date window still covers the current one.
func reusableCLIDbScopes(state sessioncursor.State, historyScope string) map[string]bool {
	scopes := map[string]bool{}
	for key := range state.Files {
		if !hasPrefix(key, cursorPrefixCLIDbBounded) {
			continue
		}
		remainder := key[len(cursorPrefixCLIDbBounded):]
		scope, _, _ := strings.Cut(remainder, "\x00")
		if antigravityscan.IsReusableHistoryScope(scope, historyScope) {
			scopes[scope] = true
		}
	}
	return scopes
}

// parseCLIDbCascadeHash resolves a cursor key to the cascade hash it names,
// under the given scope's rules.
func parseCLIDbCascadeHash(key, historyScope string) (string, bool) {
	if historyScope == "all" {
		if !hasPrefix(key, cursorPrefixCLIDbCascade) {
			return "", false
		}
		cascadeHash := key[len(cursorPrefixCLIDbCascade):]
		return cascadeHash, sha256HexPattern.MatchString(cascadeHash)
	}

	if hasPrefix(key, cursorPrefixCLIDbCascade) {
		cascadeHash := key[len(cursorPrefixCLIDbCascade):]
		if sha256HexPattern.MatchString(cascadeHash) {
			return cascadeHash, true
		}
	}

	parsed, ok := parseCLIDbBoundedKey(key)
	if !ok || !antigravityscan.IsReusableHistoryScope(parsed.scope, historyScope) {
		return "", false
	}
	return parsed.cascadeHash, true
}

// pruneAbsentCLIDbRowCursors forgets cascades a complete directory listing did
// not contain. Only called with a complete listing: a bounded scan must not
// drop cursors for databases it simply did not read this time.
func pruneAbsentCLIDbRowCursors(state *sessioncursor.State, knownCascadeIDs map[string]bool) {
	knownHashes := make(map[string]bool, len(knownCascadeIDs))
	for cascadeID := range knownCascadeIDs {
		knownHashes[hashString(cascadeID)] = true
	}
	for _, key := range sortedCursorKeys(state.Files) {
		cascadeHash, ok := parseAnyCLIDbCascadeHash(key)
		if ok && !knownHashes[cascadeHash] {
			delete(state.Files, key)
		}
	}
}

func parseAnyCLIDbCascadeHash(key string) (string, bool) {
	if hasPrefix(key, cursorPrefixCLIDbCascade) {
		cascadeHash := key[len(cursorPrefixCLIDbCascade):]
		if sha256HexPattern.MatchString(cascadeHash) {
			return cascadeHash, true
		}
	}
	if parsed, ok := parseCLIDbBoundedKey(key); ok {
		return parsed.cascadeHash, true
	}
	return "", false
}

type cliDbBoundedKey struct {
	scope       string
	cascadeHash string
}

func parseCLIDbBoundedKey(key string) (cliDbBoundedKey, bool) {
	if !hasPrefix(key, cursorPrefixCLIDbBounded) {
		return cliDbBoundedKey{}, false
	}
	remainder := key[len(cursorPrefixCLIDbBounded):]
	scope, cascadeHash, ok := strings.Cut(remainder, "\x00")
	if !ok || !sha256HexPattern.MatchString(cascadeHash) {
		return cliDbBoundedKey{}, false
	}
	return cliDbBoundedKey{scope: scope, cascadeHash: cascadeHash}, true
}

// sortedCursorKeys snapshots the map's keys in order. The bounded-scope
// migration reads keys while it mutates the map, and the migration's outcome
// must not depend on map iteration order.
func sortedCursorKeys(files map[string]sessioncursor.Entry) []string {
	keys := make([]string, 0, len(files))
	for key := range files {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// collectedAtOrNow stamps a cursor entry the way the TypeScript writer does.
func collectedAtOrNow(collectedAt string) string {
	if collectedAt != "" {
		return collectedAt
	}
	return nowISO()
}

// nowISO is a seam for tests: the TypeScript writer uses an ISO timestamp with
// millisecond precision.
var nowISO = func() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}

func hashString(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func hasPrefix(value, prefix string) bool {
	return strings.HasPrefix(value, prefix)
}
