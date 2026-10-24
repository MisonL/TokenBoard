package antigravityscan

import (
	"strconv"
	"testing"
)

func scanState() FileScanState {
	return FileScanState{NextSequence: 10, Files: map[string]FileScanEntry{}}
}

func markFile(t *testing.T, state *FileScanState, id string, checkedSequence int64, mtimeMs float64) {
	t.Helper()
	MarkFileScanned(state, id, FileScanEntry{MtimeMs: mtimeMs, Size: 1, HasDatabaseFile: true}, checkedSequence)
}

func contains(ids []string, want string) bool {
	for _, id := range ids {
		if id == want {
			return true
		}
	}
	return false
}

// Reserves refresh capacity while unseen files fill the discovery budget.
func TestReservesRefreshCapacityForUnseenFiles(t *testing.T) {
	state := scanState()
	markFile(t, &state, "known-stale", 1, 1)
	markFile(t, &state, "known-hot", 9, 100)

	selected := SelectFileScanIds(
		[]string{"known-stale", "known-hot", "unseen-1", "unseen-2", "unseen-3", "unseen-4"},
		&state, 4,
	)

	unseen := 0
	for _, id := range selected {
		if len(id) >= 7 && id[:7] == "unseen-" {
			unseen++
		}
	}
	if unseen != 2 {
		t.Errorf("selected %d unseen, want 2: %v", unseen, selected)
	}
	if !contains(selected, "known-stale") || !contains(selected, "known-hot") {
		t.Errorf("selected = %v, want both known ids", selected)
	}
}

// Mixes hot cached files with the stalest refresh candidates.
func TestMixesHotCachedFilesWithStalestRefreshCandidates(t *testing.T) {
	state := scanState()
	for index := int64(1); index <= 6; index++ {
		mtime := float64(index)
		if index >= 5 {
			mtime = float64(index * 100)
		}
		markFile(t, &state, "known-"+strconv.FormatInt(index, 10), index, mtime)
	}

	ids := []string{"known-1", "known-2", "known-3", "known-4", "known-5", "known-6"}
	selected := SelectFileScanIds(ids, &state, 4)

	// Half the budget is the two hottest (known-5, known-6 by mtime); the rest
	// is the two stalest (known-1, known-2 by checkedSequence).
	for _, want := range []string{"known-1", "known-2", "known-5", "known-6"} {
		if !contains(selected, want) {
			t.Errorf("selected = %v, missing %s", selected, want)
		}
	}
	if len(selected) != 4 {
		t.Errorf("selected %d ids, want 4: %v", len(selected), selected)
	}
}

func TestDedupesCandidateIdsPreservingOrder(t *testing.T) {
	state := scanState()
	selected := SelectFileScanIds([]string{"a", "b", "a", "c", "b"}, &state, UnboundedScanCapacity)
	want := []string{"a", "b", "c"}
	if len(selected) != len(want) {
		t.Fatalf("selected = %v, want %v", selected, want)
	}
	for index := range want {
		if selected[index] != want[index] {
			t.Fatalf("selected = %v, want %v", selected, want)
		}
	}
}

func TestZeroCapacitySelectsNothing(t *testing.T) {
	state := scanState()
	if selected := SelectFileScanIds([]string{"a", "b"}, &state, 0); len(selected) != 0 {
		t.Errorf("selected = %v, want none", selected)
	}
	if selected := SelectFileScanIds([]string{"a", "b"}, &state, -5); len(selected) != 0 {
		t.Errorf("negative capacity selected %v, want none", selected)
	}
}

// With only known files, the whole budget goes to the refresh selection.
func TestSelectsOnlyKnownFilesWhenNothingIsNew(t *testing.T) {
	state := scanState()
	markFile(t, &state, "a", 1, 1)
	markFile(t, &state, "b", 2, 2)
	selected := SelectFileScanIds([]string{"a", "b"}, &state, 5)
	if len(selected) != 2 {
		t.Errorf("selected = %v, want both", selected)
	}
}

// The single remaining slot alternates with the sequence counter so neither
// group starves when capacity is one.
func TestAlternatesTheSingleSlotBySequence(t *testing.T) {
	even := scanState()
	even.NextSequence = 10
	markFile(t, &even, "known", 1, 1)
	if selected := SelectFileScanIds([]string{"known", "unseen"}, &even, 1); !contains(selected, "known") {
		t.Errorf("even sequence selected %v, want the known id", selected)
	}

	odd := scanState()
	odd.NextSequence = 11
	markFile(t, &odd, "known", 1, 1)
	if selected := SelectFileScanIds([]string{"known", "unseen"}, &odd, 1); !contains(selected, "unseen") {
		t.Errorf("odd sequence selected %v, want the unseen id", selected)
	}
}

func TestBeginFileScanAdvancesAndRejectsInvalidCounters(t *testing.T) {
	state := scanState()
	first, err := BeginFileScan(&state)
	if err != nil {
		t.Fatal(err)
	}
	second, err := BeginFileScan(&state)
	if err != nil {
		t.Fatal(err)
	}
	if first != 10 || second != 11 {
		t.Errorf("sequences = %d, %d, want 10, 11", first, second)
	}

	negative := FileScanState{NextSequence: -1, Files: map[string]FileScanEntry{}}
	if _, err := BeginFileScan(&negative); err == nil {
		t.Error("negative sequence accepted")
	}
	exhausted := FileScanState{NextSequence: maxSafeInteger, Files: map[string]FileScanEntry{}}
	if _, err := BeginFileScan(&exhausted); err == nil {
		t.Error("exhausted sequence accepted")
	}
}

func TestPruneForgetsFilesOutsideTheRetainedSet(t *testing.T) {
	state := scanState()
	markFile(t, &state, "keep", 1, 1)
	markFile(t, &state, "drop", 2, 2)

	PruneFileScanState(&state, []string{"keep"})

	if _, ok := ReadFileScanEntry(&state, "keep"); !ok {
		t.Error("retained entry was pruned")
	}
	if _, ok := ReadFileScanEntry(&state, "drop"); ok {
		t.Error("dropped entry survived the prune")
	}
}

func TestValidatesScanState(t *testing.T) {
	valid := scanState()
	markFile(t, &valid, "a", 1, 1)
	if !IsValidFileScanState(valid) {
		t.Error("a state built by the package was reported invalid")
	}

	badKey := scanState()
	badKey.Files["not-a-hash"] = FileScanEntry{MtimeMs: 1, Size: 1, CheckedSequence: 1}
	if IsValidFileScanState(badKey) {
		t.Error("a non-hash file key was accepted")
	}

	badEntry := scanState()
	badEntry.Files[fileScanKey("a")] = FileScanEntry{MtimeMs: -1, Size: 1, CheckedSequence: 1}
	if IsValidFileScanState(badEntry) {
		t.Error("a negative mtime was accepted")
	}

	if IsValidFileScanState(FileScanState{NextSequence: -1, Files: map[string]FileScanEntry{}}) {
		t.Error("a negative sequence was accepted")
	}
	if IsValidFileScanState(FileScanState{NextSequence: 0}) {
		t.Error("a nil file map was accepted")
	}
}
