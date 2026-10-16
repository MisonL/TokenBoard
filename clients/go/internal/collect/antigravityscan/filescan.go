package antigravityscan

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"sort"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/collate"
)

// MaxDirectoryEntries caps a conversations directory listing, matching the TS
// scanner's maxAntigravityDirectoryEntries.
const MaxDirectoryEntries = 10_000

const maxSafeInteger = int64(1)<<53 - 1

// UnboundedScanCapacity asks SelectFileScanIds for every candidate id. The TS
// side spells this Number.POSITIVE_INFINITY.
const UnboundedScanCapacity = -1

// FileScanEntry is what one scan pass recorded about one conversation file.
type FileScanEntry struct {
	MtimeMs         float64
	Size            int64
	HasDatabaseFile bool
	CheckedSequence int64
	// SQLite-backed sources anchor incremental metadata cursors to the exact
	// row that was last processed.
	MetadataRowHighWater    *int64
	MetadataCursorRowIndex  *int64
	MetadataCursorRowSHA256 *string
}

// FileScanState is the persisted scan bookkeeping: which files have been seen,
// when, and the rotation counter that decides discovery-vs-refresh fairness.
type FileScanState struct {
	NextSequence int64
	// Files is keyed by the SHA-256 of the conversation id, so the key carries
	// no user identifier even in the state file.
	Files map[string]FileScanEntry
}

// NewFileScanState is a valid empty state.
func NewFileScanState() FileScanState {
	return FileScanState{Files: map[string]FileScanEntry{}}
}

// BeginFileScan consumes one sequence number. It fails on an invalid or
// exhausted counter, so a corrupt cursor surfaces instead of silently
// restarting, and the counter never wraps into reuse.
func BeginFileScan(state *FileScanState) (int64, error) {
	if state.NextSequence < 0 || state.NextSequence >= maxSafeInteger {
		return 0, errors.New("Invalid Antigravity file scan sequence")
	}
	sequence := state.NextSequence
	state.NextSequence++
	return sequence, nil
}

// scanCandidate is one id under consideration, with its recorded state when
// it has been scanned before.
type scanCandidate struct {
	id    string
	entry *FileScanEntry
}

// SelectFileScanIds chooses which of the candidate ids this pass reads, in
// order. Newly discovered files and previously seen ones compete for the
// budget: reading only new files would never refresh a changed one, and
// reading only known ones would never discover anything.
func SelectFileScanIds(ids []string, state *FileScanState, limit int) []string {
	if limit == UnboundedScanCapacity {
		return dedupePreservingOrder(ids)
	}
	if limit < 0 {
		limit = 0
	}
	if limit == 0 {
		return nil
	}

	seen := make(map[string]bool, len(ids))
	var unseen, known []scanCandidate
	for _, id := range ids {
		if seen[id] {
			continue
		}
		seen[id] = true
		if entry, ok := state.Files[fileScanKey(id)]; ok {
			copied := entry
			known = append(known, scanCandidate{id: id, entry: &copied})
		} else {
			unseen = append(unseen, scanCandidate{id: id})
		}
	}

	switch {
	case len(unseen) == 0:
		return selectKnownScanIds(known, limit)
	case len(known) == 0:
		return selectFromBothEnds(unseen, limit)
	case limit == 1:
		// The single slot alternates with the sequence counter, so neither
		// group monopolises it across runs.
		if state.NextSequence%2 == 0 {
			return selectKnownScanIds(known, 1)
		}
		return selectFromBothEnds(unseen, 1)
	}

	discoveryCapacity := min(len(unseen), ceilDiv(limit, 2))
	refreshCapacity := min(len(known), limit-discoveryCapacity)
	remaining := limit - discoveryCapacity - refreshCapacity
	extraDiscovery := min(len(unseen)-discoveryCapacity, remaining)
	discoveryCapacity += extraDiscovery
	remaining -= extraDiscovery
	refreshCapacity += min(len(known)-refreshCapacity, remaining)
	return append(
		selectFromBothEnds(unseen, discoveryCapacity),
		selectKnownScanIds(known, refreshCapacity)...,
	)
}

// MarkFileScanned records one file's scan result. checkedSequence must come
// from BeginFileScan.
func MarkFileScanned(state *FileScanState, id string, entry FileScanEntry, checkedSequence int64) {
	entry.CheckedSequence = checkedSequence
	state.Files[fileScanKey(id)] = entry
}

// ReadFileScanEntry returns a file's recorded state, or false when unseen.
func ReadFileScanEntry(state *FileScanState, id string) (FileScanEntry, bool) {
	entry, ok := state.Files[fileScanKey(id)]
	return entry, ok
}

// RemoveFileScanEntry forgets one file.
func RemoveFileScanEntry(state *FileScanState, id string) {
	delete(state.Files, fileScanKey(id))
}

// PruneFileScanState forgets every file not in ids, so an unbounded history
// does not grow the cursor without limit.
func PruneFileScanState(state *FileScanState, ids []string) {
	retained := make(map[string]bool, len(ids))
	for _, id := range ids {
		retained[fileScanKey(id)] = true
	}
	for key := range state.Files {
		if !retained[key] {
			delete(state.Files, key)
		}
	}
}

// IsValidFileScanState mirrors the TS validator: a corrupt state must be
// rejected so the caller resets it explicitly rather than half-using it.
func IsValidFileScanState(state FileScanState) bool {
	if state.Files == nil {
		return false
	}
	if state.NextSequence < 0 || state.NextSequence > maxSafeInteger {
		return false
	}
	for key, entry := range state.Files {
		if !isHexSHA256(key) {
			return false
		}
		if !isValidFileScanEntry(entry) {
			return false
		}
	}
	return true
}

func isValidFileScanEntry(entry FileScanEntry) bool {
	return entry.MtimeMs >= 0 && entry.Size >= 0 &&
		entry.CheckedSequence >= 0 && entry.CheckedSequence <= maxSafeInteger
}

func isHexSHA256(key string) bool {
	if len(key) != 64 {
		return false
	}
	for _, char := range key {
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') {
			return false
		}
	}
	return true
}

// selectFromBothEnds takes alternately from each end of the discovery list.
// New conversation directories tend to appear at one end of a listing while
// older ones linger at the other, so sampling both reaches each group within
// one pass instead of one end starving.
func selectFromBothEnds(items []scanCandidate, limit int) []string {
	selected := make([]string, 0, limit)
	left, right := 0, len(items)-1
	for len(selected) < limit && left <= right {
		selected = append(selected, items[left].id)
		left++
		if len(selected) < limit && left <= right {
			selected = append(selected, items[right].id)
			right--
		}
	}
	return selected
}

// selectKnownScanIds devotes half the budget to the hottest files (most
// recently modified, then largest) and the rest to the stalest (checked
// longest ago), so a frequently written session stays current while every
// other file still rotates through.
func selectKnownScanIds(items []scanCandidate, limit int) []string {
	if len(items) <= limit {
		ids := make([]string, 0, len(items))
		for _, item := range items {
			ids = append(ids, item.id)
		}
		return ids
	}
	hotLimit := limit / 2

	hot := make([]scanCandidate, len(items))
	copy(hot, items)
	sort.SliceStable(hot, func(i, j int) bool { return lessByHeat(hot[i], hot[j]) })
	hot = hot[:hotLimit]

	hotIDs := make(map[string]bool, len(hot))
	selected := make([]string, 0, limit)
	for _, item := range hot {
		hotIDs[item.id] = true
		selected = append(selected, item.id)
	}

	stale := make([]scanCandidate, len(items))
	copy(stale, items)
	sort.SliceStable(stale, func(i, j int) bool {
		left, right := stale[i], stale[j]
		if left.entry.CheckedSequence != right.entry.CheckedSequence {
			return left.entry.CheckedSequence < right.entry.CheckedSequence
		}
		return collate.Less(left.id, right.id)
	})
	for _, item := range stale {
		if len(selected) >= limit {
			break
		}
		if hotIDs[item.id] {
			continue
		}
		selected = append(selected, item.id)
	}
	return selected
}

// lessByHeat orders hottest first: mtime descending, then size descending,
// then id ascending.
func lessByHeat(left, right scanCandidate) bool {
	if left.entry.MtimeMs != right.entry.MtimeMs {
		return left.entry.MtimeMs > right.entry.MtimeMs
	}
	if left.entry.Size != right.entry.Size {
		return left.entry.Size > right.entry.Size
	}
	return collate.Less(left.id, right.id)
}

func dedupePreservingOrder(ids []string) []string {
	seen := make(map[string]bool, len(ids))
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}

func fileScanKey(id string) string {
	sum := sha256.Sum256([]byte(id))
	return hex.EncodeToString(sum[:])
}

func ceilDiv(value, divisor int) int {
	return (value + divisor - 1) / divisor
}
