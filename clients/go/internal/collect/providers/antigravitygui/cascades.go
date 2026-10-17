package antigravitygui

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravitymeta"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravityscan"
)

// CascadeRef names one conversation file as the directory lists it.
// HasDatabaseFile says whether a SQLite conversation database sits beside the
// cascade's own file, which decides whether the SQLite history will cover it.
type CascadeRef struct {
	ID              string
	MtimeMs         float64
	Size            int64
	HasDatabaseFile bool
}

// ListCascadesInput configures one directory listing.
type ListCascadesInput struct {
	Source             Source
	ConversationDir    string
	Limit              int
	RequiredCascadeIDs []string
	IncludeCascade     func(CascadeRef) bool
	CompareCascades    func(CascadeRef, CascadeRef) int
	ScanState          *antigravityscan.FileScanState
	HomeDir            string
}

// ListAntigravityCascades lists the conversations directory's cascade files,
// bounded and scan-state-aware, mirroring listAntigravityCascades.
//
// The listing must terminate: the directory cap bounds the walk, the scan
// state's rotation bounds which known files are re-stat'ed, and the candidate
// limit bounds how many are stat'ed per run.
func ListAntigravityCascades(input ListCascadesInput) ([]CascadeRef, error) {
	dir := input.ConversationDir
	if dir == "" {
		dir = defaultConversationDir(Options{Source: input.Source, HomeDir: input.HomeDir})
	}
	limit := input.Limit
	if limit < 0 {
		limit = defaultMaxLanguageServerCascades
	}
	if limit == 0 {
		return []CascadeRef{}, nil
	}
	compare := input.CompareCascades
	if compare == nil {
		compare = compareRecentCascades
	}
	scanState := input.ScanState
	if scanState == nil {
		empty := antigravityscan.NewFileScanState()
		scanState = &empty
	}
	checkedSequence, err := antigravityscan.BeginFileScan(scanState)
	if err != nil {
		return nil, err
	}

	names, err := antigravityscan.ListDirectoryFileNames(dir)
	if err != nil {
		// A directory that is not there means the tool has never run here,
		// which the all-source run skips on; anything else is a real failure.
		if errors.Is(err, fs.ErrNotExist) {
			return nil, &DirectoryNotFoundError{Dir: dir}
		}
		return nil, err
	}

	cascades := []CascadeRef{}
	seenIDs := map[string]bool{}
	required := map[string]CascadeRef{}
	for _, id := range input.RequiredCascadeIDs {
		if !cascadeIDPattern.MatchString(id) || seenIDs[id] {
			continue
		}
		seenIDs[id] = true
		cascade, ok, err := cascadeRefFor(dir, id)
		if err != nil {
			return nil, err
		}
		if !ok {
			continue
		}
		required[id] = cascade
		markScanEntry(scanState, cascade, checkedSequence)
	}

	directoryIDs := []string{}
	for _, name := range names {
		id := cascadeIDFromFile(name)
		if id == "" || seenIDs[id] {
			continue
		}
		seenIDs[id] = true
		directoryIDs = append(directoryIDs, id)
	}
	pruneIDs := append([]string{}, directoryIDs...)
	for id := range required {
		pruneIDs = append(pruneIDs, id)
	}
	antigravityscan.PruneFileScanState(scanState, pruneIDs)

	candidateLimit := directoryCandidateLimit(limit)
	scanIDs := antigravityscan.SelectFileScanIds(directoryIDs, scanState, candidateLimit)
	for _, id := range scanIDs {
		cascade, ok, err := cascadeRefFor(dir, id)
		if err != nil {
			return nil, err
		}
		if ok {
			markScanEntry(scanState, cascade, checkedSequence)
		} else {
			antigravityscan.RemoveFileScanEntry(scanState, id)
		}
	}
	for _, id := range directoryIDs {
		cascade, ok := cachedCascadeRef(scanState, id)
		if !ok {
			continue
		}
		if input.IncludeCascade != nil && !input.IncludeCascade(cascade) {
			continue
		}
		cascades = pushPreferredCascade(cascades, cascade, limit, compare)
	}
	requiredIDs := make([]string, 0, len(required))
	for id := range required {
		requiredIDs = append(requiredIDs, id)
	}
	sort.Strings(requiredIDs)
	for _, id := range requiredIDs {
		if seenInDirectory(directoryIDs, id) {
			continue
		}
		cascade := required[id]
		if input.IncludeCascade != nil && !input.IncludeCascade(cascade) {
			continue
		}
		cascades = pushPreferredCascade(cascades, cascade, limit, compare)
	}

	sort.SliceStable(cascades, func(i, j int) bool { return compare(cascades[i], cascades[j]) < 0 })

	// An empty result with no scan history means the tool has never run here;
	// the caller classifies this as "unavailable". A scan state with entries
	// means the tool ran before and the directory is momentarily unreadable —
	// an error, not a skip. Unrelated directory contents do not change this:
	// the question is whether any conversation was found, not what else sits
	// in the directory.
	if len(cascades) == 0 && len(scanState.Files) == 0 {
		return nil, &NoConversationsError{Dir: dir}
	}
	return cascades, nil
}

// DirectoryNotFoundError reports a conversations directory that does not
// exist — the "tool is not installed here" case an all-source run skips on.
type DirectoryNotFoundError struct{ Dir string }

func (e *DirectoryNotFoundError) Error() string {
	return "Antigravity conversations directory not found: " + e.Dir
}

// NoConversationsError reports a conversations directory with nothing in it —
// the "tool is not installed here" case an all-source run skips on.
type NoConversationsError struct{ Dir string }

func (e *NoConversationsError) Error() string {
	return "No Antigravity conversations found in " + e.Dir
}

func seenInDirectory(ids []string, id string) bool {
	for _, candidate := range ids {
		if candidate == id {
			return true
		}
	}
	return false
}

func compareRecentCascades(left, right CascadeRef) int {
	if right.MtimeMs != left.MtimeMs {
		if right.MtimeMs > left.MtimeMs {
			return 1
		}
		return -1
	}
	return compareHashes(antigravitymeta.Hash(left.ID), antigravitymeta.Hash(right.ID))
}

// pushPreferredCascade keeps the best `limit` cascades: full until the limit,
// then replacing the lowest-priority entry when the newcomer outranks it.
func pushPreferredCascade(
	cascades []CascadeRef,
	cascade CascadeRef,
	limit int,
	compare func(CascadeRef, CascadeRef) int,
) []CascadeRef {
	if len(cascades) < limit {
		return append(cascades, cascade)
	}
	lowestPriorityIndex := 0
	for index := 1; index < len(cascades); index++ {
		if compare(cascades[index], cascades[lowestPriorityIndex]) > 0 {
			lowestPriorityIndex = index
		}
	}
	if compare(cascade, cascades[lowestPriorityIndex]) < 0 {
		cascades[lowestPriorityIndex] = cascade
	}
	return cascades
}

// directoryCandidateLimit bounds how many known files are re-stat'ed: wide
// enough to refresh a listing, narrow enough that a huge history cannot turn
// one run into a full walk.
func directoryCandidateLimit(limit int) int {
	candidate := limit * 20
	if candidate < 64 {
		return 64
	}
	return candidate
}

func markScanEntry(state *antigravityscan.FileScanState, cascade CascadeRef, checkedSequence int64) {
	antigravityscan.MarkFileScanned(state, cascade.ID, antigravityscan.FileScanEntry{
		MtimeMs:         cascade.MtimeMs,
		Size:            cascade.Size,
		HasDatabaseFile: cascade.HasDatabaseFile,
	}, checkedSequence)
}

func cachedCascadeRef(state *antigravityscan.FileScanState, id string) (CascadeRef, bool) {
	entry, ok := antigravityscan.ReadFileScanEntry(state, id)
	if !ok {
		return CascadeRef{}, false
	}
	return CascadeRef{
		ID:              id,
		MtimeMs:         entry.MtimeMs,
		Size:            entry.Size,
		HasDatabaseFile: entry.HasDatabaseFile,
	}, true
}

// cascadeRefFor stats one conversation's trajectory (.pb) and SQLite (.db)
// files. Either alone names the conversation; the newer file supplies mtime
// and size together, so the cursor's (mtime, size) comparison never mixes the
// two sources, and an mtime tie keeps the .pb (the TS reduce's first element).
// hasDatabaseFile records the .db's presence — that is what decides whether
// the SQLite history will cover the conversation.
func cascadeRefFor(dir, id string) (CascadeRef, bool, error) {
	pbRef, pbOK, err := fileRefFor(id, filepath.Join(dir, id+".pb"))
	if err != nil {
		return CascadeRef{}, false, err
	}
	dbRef, dbOK, err := fileRefFor(id, filepath.Join(dir, id+".db"))
	if err != nil {
		return CascadeRef{}, false, err
	}
	if !pbOK && !dbOK {
		return CascadeRef{}, false, nil
	}
	latest := pbRef
	if !pbOK || (dbOK && dbRef.MtimeMs > pbRef.MtimeMs) {
		latest = dbRef
	}
	return CascadeRef{ID: id, MtimeMs: latest.MtimeMs, Size: latest.Size, HasDatabaseFile: dbOK}, true, nil
}

// fileRefFor stats one candidate file. A missing file is an absent candidate;
// any other stat failure is a real read failure and must surface, the way the
// TS fileRef rethrows everything but ENOENT.
func fileRefFor(id, path string) (fileRefValue, bool, error) {
	info, err := os.Stat(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return fileRefValue{}, false, nil
		}
		return fileRefValue{}, false, err
	}
	return fileRefValue{ID: id, MtimeMs: mtimeMs(info.ModTime()), Size: info.Size()}, true, nil
}

type fileRefValue struct {
	ID      string
	MtimeMs float64
	Size    int64
}

var cascadeIDPattern = regexp.MustCompile(
	`^[0-9a-fA-F-]{8,}-[0-9a-fA-F-]{4,}-[0-9a-fA-F-]{4,}-[0-9a-fA-F-]{4,}-[0-9a-fA-F-]{12,}$`)

// cascadeIDFromFile extracts a cascade id from a directory entry name. Only
// the two conversation formats (.pb trajectory and .db SQLite) name one;
// anything else in the directory is not a conversation.
func cascadeIDFromFile(name string) string {
	ext := filepath.Ext(name)
	if ext != ".pb" && ext != ".db" {
		return ""
	}
	base := strings.TrimSuffix(name, ext)
	if !cascadeIDPattern.MatchString(base) {
		return ""
	}
	return base
}
