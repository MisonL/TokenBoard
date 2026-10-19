package sessioncursor

import (
	"fmt"
	"path/filepath"
	"sort"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/collate"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessionfile"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
	"github.com/MisonL/TokenBoard/clients/go/internal/state"
)

// Port of hook-incremental.ts. The Claude path uses the scan-and-parse half;
// the Codex provider additionally consumes the pending-entry and reconciliation
// bookkeeping (context-pricing markers, reusable pending files) this file
// exposes.

// HookInput configures one hook-incremental collection.
type HookInput struct {
	Source      contract.Source
	SessionsDir string
	SessionDirs []string
	StateDir    string
	CursorName  string
	Stderr      func(line string)
	Timezone    string
	CollectedAt string
	// CursorProfileHash pins the Codex profile the cursor belongs to.
	CursorProfileHash string
	// AllowedRootSymlinks lists the absolute targets a symlinked root may
	// resolve to.
	AllowedRootSymlinks []string
	// ScanSinceMs narrows the metadata scan to recently touched files.
	ScanSinceMs *float64
	// ForcePendingUploadRescan re-reads pending files whose metadata is
	// unchanged.
	ForcePendingUploadRescan bool
	// IncludePendingSnapshotEntries asks for the per-file pending snapshot
	// entries the caller needs to acknowledge exactly what it uploaded.
	IncludePendingSnapshotEntries bool
	// IncludeReconciliationFileEntries asks for the (path, sha256) pairs of the
	// files whose snapshots this run reconciles.
	IncludeReconciliationFileEntries bool
	// SkipSessionScan reads only the cursor's pending entries (the Codex
	// "nothing changed on disk" path).
	SkipSessionScan bool
	// Now is injectable for tests; nil uses the wall clock.
	Now func() time.Time
}

// HookKey is one (usageDate, model) pair the reconciliation must cover.
type HookKey struct {
	UsageDate string
	Model     string
}

// HookPendingSnapshotEntry is one pending snapshot with the file it came from.
type HookPendingSnapshotEntry struct {
	RelativePath string
	SHA256       string
	Snapshot     contract.Snapshot
	// ContextPricingPending marks a Codex snapshot whose cost the context
	// pricing layer has not resolved yet.
	ContextPricingPending bool
}

// HookReconciliationFileEntry names one file whose snapshots ccusage must
// cover, by path and digest.
type HookReconciliationFileEntry struct {
	RelativePath string
	SHA256       string
}

// HookIncrementalResult is the hook run's incremental state.
type HookIncrementalResult struct {
	RangeArgs       []string
	Changed         bool
	ChangedDates    []string
	ChangedKeys     []HookKey
	CachedSnapshots []Snapshot
	// ReusablePendingSnapshots is the subset of CachedSnapshots whose session
	// file is still on disk. Only these can be covered by a ccusage scan of the
	// same tree; a snapshot restored for a file that is gone cannot be, so
	// callers must not treat the two alike when deciding what ccusage already
	// counted.
	ReusablePendingSnapshots []contract.Snapshot
	// UnresolvedContextPricingSnapshots are cached snapshots still waiting for
	// the context pricing layer.
	UnresolvedContextPricingSnapshots []contract.Snapshot
	// PendingSnapshotEntries is set when the caller asked for it.
	PendingSnapshotEntries []HookPendingSnapshotEntry
	// ReconciliationFileEntries is set when the caller asked for it.
	ReconciliationFileEntries []HookReconciliationFileEntry
}

// cursorLockTimeout matches the TS cursor lock's 35s acquisition window.
const cursorLockTimeout = 35 * time.Second

// CursorPath is where the hook cursor lives.
func (i HookInput) CursorPath() string {
	return filepath.Join(i.StateDir, i.CursorName)
}

// CollectHookIncremental ports collectHookIncremental: scan under the cursor
// lock, parse the changed files, update the cursor, and report the window the
// ccusage reconciliation must cover.
func CollectHookIncremental(input HookInput) (HookIncrementalResult, error) {
	cursorPath := input.CursorPath()
	now := time.Now
	if input.Now != nil {
		now = input.Now
	}
	lock, err := state.Acquire(cursorPath+".lock", cursorLockTimeout)
	if err != nil {
		return HookIncrementalResult{}, err
	}
	if lock == nil {
		return HookIncrementalResult{}, fmt.Errorf("Timed out waiting for cursor lock: %s", cursorPath+".lock")
	}
	defer func() { _ = lock.Release() }()

	if input.SkipSessionScan {
		return collectPendingHookCursorLocked(input, cursorPath)
	}

	scan, err := CollectChangedSessionFiles(ScanInput{
		Source:                   input.Source,
		SessionsDir:              input.SessionsDir,
		SessionDirs:              input.SessionDirs,
		CursorPath:               cursorPath,
		CursorProfileHash:        input.CursorProfileHash,
		HasCursorProfileHash:     input.CursorProfileHash != "",
		AllowedRootSymlinks:      input.AllowedRootSymlinks,
		ScanSinceMs:              input.ScanSinceMs,
		ForcePendingUploadRescan: input.ForcePendingUploadRescan,
		Now:                      now,
	})
	if err != nil {
		return HookIncrementalResult{}, err
	}
	if scan.HasUnreadableChangedFile {
		return HookIncrementalResult{}, fmt.Errorf("%s hook has changed session files that are not readable", input.Source)
	}
	if scan.HasUnreadablePendingUpload {
		return HookIncrementalResult{}, fmt.Errorf("%s hook has pending upload entries that are not readable", input.Source)
	}

	// Snapshots carried for files that vanished while still pending: the
	// server never acknowledged them, so they ride along with this run. The
	// reusable set (pending files whose content did not change) rides along
	// too; only it can be covered by a ccusage scan of the same tree.
	restoredPendingSnapshots := restoreCachedPendingSnapshots(scan.MissingPendingSnapshots, input.CollectedAt)
	reusableEntries := restoreReusablePendingEntries(scan.ReusablePendingFiles, input.CollectedAt)
	restoredEntries := append(
		append([]HookPendingSnapshotEntry{}, reusableEntries...),
		restorePendingSnapshotEntries(scan.MissingPendingSnapshotEntries, input.CollectedAt)...)
	cachedSnapshots := make([]Snapshot, 0, len(reusableEntries)+len(restoredPendingSnapshots))
	for _, entry := range reusableEntries {
		cachedSnapshots = append(cachedSnapshots, cursorSnapshotOf(entry.Snapshot))
	}
	for _, snapshot := range restoredPendingSnapshots {
		cachedSnapshots = append(cachedSnapshots, restoreCursorSnapshot(snapshot))
	}
	// A pending entry whose cost the context pricing layer has not resolved yet
	// is re-emitted so the provider can try again. The Codex provider widens
	// this set with its own "is this model priced" rule; the cursor can only
	// report the marker it stored.
	unresolved := make([]contract.Snapshot, 0)
	for _, entry := range reusableEntries {
		if entry.ContextPricingPending {
			unresolved = append(unresolved, entry.Snapshot)
		}
	}
	for _, snapshot := range restoredPendingSnapshots {
		if snapshot.CodexContextPricingPending {
			unresolved = append(unresolved, SnapshotsOf([]Snapshot{snapshot}, input.CollectedAt)[0])
		}
	}
	var pendingEntries []HookPendingSnapshotEntry
	if input.IncludePendingSnapshotEntries {
		pendingEntries = restoredEntries
	}

	if len(scan.Files) == 0 {
		if len(cachedSnapshots) > 0 {
			if hasCursorMaintenance(scan) {
				if err := scan.Commit(input.Source); err != nil {
					return HookIncrementalResult{}, err
				}
			}
			return withPendingSnapshotEntries(HookIncrementalResult{
				RangeArgs:                         []string{},
				Changed:                           true,
				ChangedDates:                      []string{},
				ChangedKeys:                       []HookKey{},
				CachedSnapshots:                   cachedSnapshots,
				UnresolvedContextPricingSnapshots: unresolved,
			}, input, pendingEntries, nil), nil
		}
		if scan.HasPendingUpload {
			return HookIncrementalResult{}, fmt.Errorf(
				"%s hook has pending upload entries but no readable changed session files", input.Source)
		}
		if hasCursorMaintenance(scan) {
			if err := scan.Commit(input.Source); err != nil {
				return HookIncrementalResult{}, err
			}
		}
		return withPendingSnapshotEntries(HookIncrementalResult{
			RangeArgs:                         []string{},
			Changed:                           false,
			ChangedDates:                      []string{},
			ChangedKeys:                       []HookKey{},
			CachedSnapshots:                   []Snapshot{},
			UnresolvedContextPricingSnapshots: unresolved,
		}, input, pendingEntries, nil), nil
	}

	parsed, err := parseChangedFiles(input, scan)
	if err != nil {
		return HookIncrementalResult{}, err
	}
	if parsed.malformedRows > 0 {
		return HookIncrementalResult{}, fmt.Errorf("%s hook found %d malformed JSONL rows", input.Source, parsed.malformedRows)
	}
	if parsed.unparsedTokenLikeRows > 0 {
		return HookIncrementalResult{}, fmt.Errorf(
			"%s hook found %d unparsed token-like rows", input.Source, parsed.unparsedTokenLikeRows)
	}
	if parsed.pendingFilesWithoutSnapshots > 0 {
		return HookIncrementalResult{}, fmt.Errorf(
			"%s hook has %d pending upload files with no parsed usage snapshots",
			input.Source, parsed.pendingFilesWithoutSnapshots)
	}

	if len(parsed.changedDates) > 0 {
		scan.MarkPendingUpload(parsed.pendingUploadPaths)
	}
	if err := scan.Commit(input.Source); err != nil {
		return HookIncrementalResult{}, err
	}
	reportSkippedOversizedRows(input, parsed)

	result := HookIncrementalResult{
		RangeArgs:                         buildDateRangeArgs(parsed.changedDates),
		Changed:                           len(parsed.changedDates) > 0 || len(cachedSnapshots) > 0,
		ChangedDates:                      sortedDates(parsed.changedDates),
		ChangedKeys:                       sortedKeys(parsed.changedKeys),
		CachedSnapshots:                   cachedSnapshots,
		UnresolvedContextPricingSnapshots: unresolved,
	}
	for _, entry := range reusableEntries {
		result.ReusablePendingSnapshots = append(result.ReusablePendingSnapshots, entry.Snapshot)
	}
	return withPendingSnapshotEntries(result, input, pendingEntries, parsed.reconciliationFileEntries), nil
}

// collectPendingHookCursorLocked ports collectPendingHookCursorLocked: the
// cursor's pending entries without any disk scan.
func collectPendingHookCursorLocked(input HookInput, cursorPath string) (HookIncrementalResult, error) {
	cursor, err := Read(cursorPath, string(input.Source))
	if err != nil {
		return HookIncrementalResult{}, err
	}
	entries := []HookPendingSnapshotEntry{}
	cleanedSnapshotlessPending := false
	for _, key := range sortedEntryKeys(cursor.Files) {
		entry := cursor.Files[key]
		if entry.PendingUpload == nil || !*entry.PendingUpload {
			continue
		}
		if len(entry.Snapshots) == 0 {
			delete(cursor.Files, key)
			cleanedSnapshotlessPending = true
			continue
		}
		for _, snapshot := range entry.Snapshots {
			restored := SnapshotsOf([]Snapshot{snapshot}, input.CollectedAt)[0]
			entries = append(entries, HookPendingSnapshotEntry{
				RelativePath:          key,
				SHA256:                entry.SHA256,
				Snapshot:              restored,
				ContextPricingPending: snapshot.CodexContextPricingPending,
			})
		}
	}
	if cleanedSnapshotlessPending {
		if err := Write(cursorPath, cursor); err != nil {
			return HookIncrementalResult{}, err
		}
	}
	cachedSnapshots := make([]Snapshot, 0, len(entries))
	unresolved := []contract.Snapshot{}
	for _, entry := range entries {
		cachedSnapshots = append(cachedSnapshots, cursorSnapshotOf(entry.Snapshot))
		if entry.ContextPricingPending {
			unresolved = append(unresolved, entry.Snapshot)
		}
	}
	result := HookIncrementalResult{
		RangeArgs:                         []string{},
		Changed:                           len(entries) > 0,
		ChangedDates:                      []string{},
		ChangedKeys:                       []HookKey{},
		CachedSnapshots:                   cachedSnapshots,
		UnresolvedContextPricingSnapshots: unresolved,
	}
	if input.IncludePendingSnapshotEntries {
		result.PendingSnapshotEntries = entries
	}
	if input.IncludeReconciliationFileEntries {
		result.ReconciliationFileEntries = []HookReconciliationFileEntry{}
	}
	return result, nil
}

// withPendingSnapshotEntries attaches the optional fields the TS
// withPendingSnapshotEntries helper adds.
func withPendingSnapshotEntries(
	result HookIncrementalResult,
	input HookInput,
	pendingEntries []HookPendingSnapshotEntry,
	reconciliationEntries []HookReconciliationFileEntry,
) HookIncrementalResult {
	if input.IncludePendingSnapshotEntries {
		result.PendingSnapshotEntries = pendingEntries
	}
	if input.IncludeReconciliationFileEntries {
		if reconciliationEntries == nil {
			reconciliationEntries = []HookReconciliationFileEntry{}
		}
		result.ReconciliationFileEntries = reconciliationEntries
	}
	return result
}

// restoreCachedPendingSnapshots returns the cursor snapshots of the vanished
// pending files.
func restoreCachedPendingSnapshots(groups []PendingSnapshotGroup, collectedAt string) []Snapshot {
	out := []Snapshot{}
	for _, group := range groups {
		for _, snapshot := range group.Snapshots {
			out = append(out, snapshot)
		}
	}
	return out
}

// restorePendingSnapshotEntries expands the missing-pending groups into
// per-snapshot entries.
func restorePendingSnapshotEntries(groups []PendingSnapshotEntry, collectedAt string) []HookPendingSnapshotEntry {
	out := []HookPendingSnapshotEntry{}
	for _, group := range groups {
		for _, snapshot := range group.Snapshots {
			out = append(out, HookPendingSnapshotEntry{
				RelativePath:          group.RelativePath,
				SHA256:                group.SHA256,
				Snapshot:              SnapshotsOf([]Snapshot{snapshot}, collectedAt)[0],
				ContextPricingPending: snapshot.CodexContextPricingPending,
			})
		}
	}
	return out
}

// restoreReusablePendingEntries expands the reusable pending files.
func restoreReusablePendingEntries(files []ReusablePendingFile, collectedAt string) []HookPendingSnapshotEntry {
	out := []HookPendingSnapshotEntry{}
	for _, file := range files {
		for _, snapshot := range file.Snapshots {
			out = append(out, HookPendingSnapshotEntry{
				RelativePath:          file.RelativePath,
				SHA256:                file.SHA256,
				Snapshot:              SnapshotsOf([]Snapshot{snapshot}, collectedAt)[0],
				ContextPricingPending: snapshot.CodexContextPricingPending,
			})
		}
	}
	return out
}

func cursorSnapshotOf(snapshot contract.Snapshot) Snapshot {
	return Snapshot{
		Source:              string(snapshot.Source),
		UsageDate:           snapshot.UsageDate,
		Timezone:            snapshot.Timezone,
		Model:               snapshot.Model,
		InputTokens:         float64(snapshot.InputTokens),
		OutputTokens:        float64(snapshot.OutputTokens),
		CacheCreationTokens: float64(snapshot.CacheCreation),
		CacheReadTokens:     float64(snapshot.CacheRead),
		TotalTokens:         float64(snapshot.TotalTokens),
		CostUSD:             snapshot.CostUSD,
		SessionCount:        float64(snapshot.SessionCount),
	}
}

type parsedFiles struct {
	changedDates                 map[string]bool
	changedKeys                  map[string]HookKey
	malformedRows                int
	pendingFilesWithoutSnapshots int
	pendingUploadPaths           []string
	unparsedTokenLikeRows        int
	skippedOversizedRows         int
	largestSkippedOversizedBytes int64
	reconciliationFileEntries    []HookReconciliationFileEntry
}

func parseChangedFiles(input HookInput, scan *ScanResult) (parsedFiles, error) {
	parsed := parsedFiles{
		changedDates: map[string]bool{},
		changedKeys:  map[string]HookKey{},
	}
	for _, file := range scan.Files {
		// Stream the file's rows into the parser instead of materializing the
		// whole file first: a compacted (rewritten) Claude session can be
		// hundreds of megabytes, and holding every row on the heap at once
		// turns a bounded scan into an unbounded allocation.
		result, err := sessionfile.ParseLines(sessionfile.ParseInput{
			Source:      input.Source,
			Timezone:    input.Timezone,
			CollectedAt: input.CollectedAt,
			SessionID:   file.RelativePath,
		}, file.ReadLines)
		if err != nil {
			return parsedFiles{}, err
		}
		for _, snapshot := range result.Snapshots {
			parsed.changedDates[snapshot.UsageDate] = true
			parsed.changedKeys[snapshotKeyOf(snapshot.UsageDate, snapshot.Model)] = HookKey{
				UsageDate: snapshot.UsageDate,
				Model:     snapshot.Model,
			}
		}
		if len(result.Snapshots) > 0 {
			parsed.pendingUploadPaths = append(parsed.pendingUploadPaths, file.RelativePath)
			parsed.reconciliationFileEntries = append(parsed.reconciliationFileEntries, HookReconciliationFileEntry{
				RelativePath: file.RelativePath,
				SHA256:       file.SHA256,
			})
		}
		if file.PendingUpload && len(result.Snapshots) == 0 && result.IgnoredUploadSafeRows == 0 {
			parsed.pendingFilesWithoutSnapshots++
		}
		parsed.malformedRows += result.MalformedRows
		parsed.unparsedTokenLikeRows += result.UnparsedTokenLikeRows
		parsed.skippedOversizedRows += result.SkippedOversizedRows
		if result.LargestSkippedOversizedRow > parsed.largestSkippedOversizedBytes {
			parsed.largestSkippedOversizedBytes = result.LargestSkippedOversizedRow
		}
		if err := UpdateCursorFile(&scan.Cursor, file, ParsedFile{
			Snapshots:             cursorSnapshotsOf(result.Snapshots),
			MissingCost:           result.MissingCost,
			IgnoredUploadSafeRows: result.IgnoredUploadSafeRows,
		}, input.CollectedAt); err != nil {
			return parsedFiles{}, err
		}
	}
	return parsed, nil
}

func reportSkippedOversizedRows(input HookInput, parsed parsedFiles) {
	if parsed.skippedOversizedRows == 0 || input.Stderr == nil {
		return
	}
	suffix := "s"
	if parsed.skippedOversizedRows == 1 {
		suffix = ""
	}
	input.Stderr(fmt.Sprintf(
		"Skipped %d oversized %s session JSONL row%s without token or usage metadata (largest %d bytes)",
		parsed.skippedOversizedRows, input.Source, suffix, parsed.largestSkippedOversizedBytes))
}

func hasCursorMaintenance(scan *ScanResult) bool {
	return scan.HasCursorCleanup || scan.HasCursorMetadataUpdate || scan.HasCursorProfileUpdate
}

// AssertHookReconciliationSnapshots ports assertHookReconciliationSnapshots:
// the ccusage reconciliation must cover every (date, model) the parser saw in
// the changed files, or usage the parser proved exists would silently stay
// unuploaded. A key with no specific model matches any model on that date.
func AssertHookReconciliationSnapshots(
	sourceLabel string,
	expectedDates []string,
	expectedKeys []HookKey,
	snapshots []contract.Snapshot,
) error {
	keys := expectedKeys
	if len(keys) == 0 {
		keys = make([]HookKey, 0, len(expectedDates))
		for _, usageDate := range expectedDates {
			keys = append(keys, HookKey{UsageDate: usageDate})
		}
	}
	if len(keys) == 0 {
		return nil
	}
	actualKeys := map[string]bool{}
	actualDates := map[string]bool{}
	for _, snapshot := range snapshots {
		actualKeys[snapshotKeyOf(snapshot.UsageDate, snapshot.Model)] = true
		actualDates[snapshot.UsageDate] = true
	}
	missing := []HookKey{}
	for _, key := range keys {
		if key.Model != "" && key.Model != "all" {
			if !actualKeys[snapshotKeyOf(key.UsageDate, key.Model)] {
				missing = append(missing, key)
			}
			continue
		}
		if !actualDates[key.UsageDate] {
			missing = append(missing, key)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	labels := make([]string, 0, len(missing))
	for _, key := range missing {
		if key.Model != "" {
			labels = append(labels, key.UsageDate+"/"+key.Model)
		} else {
			labels = append(labels, key.UsageDate)
		}
	}
	return fmt.Errorf("%s hook reconciliation returned no snapshots for parsed usage keys: %s",
		sourceLabel, joinStrings(labels, ", "))
}

// restoreCursorSnapshot strips the pending-correction marker: the snapshot
// re-enters the run as current state. collectedAt is supplied by the caller
// when it converts back to a contract snapshot.
func restoreCursorSnapshot(snapshot Snapshot) Snapshot {
	restored := snapshot
	restored.CodexContextPricingPending = false
	return restored
}

func cursorSnapshotsOf(snapshots []contract.Snapshot) []Snapshot {
	out := make([]Snapshot, 0, len(snapshots))
	for _, snapshot := range snapshots {
		out = append(out, Snapshot{
			Source:              string(snapshot.Source),
			UsageDate:           snapshot.UsageDate,
			Timezone:            snapshot.Timezone,
			Model:               snapshot.Model,
			InputTokens:         float64(snapshot.InputTokens),
			OutputTokens:        float64(snapshot.OutputTokens),
			CacheCreationTokens: float64(snapshot.CacheCreation),
			CacheReadTokens:     float64(snapshot.CacheRead),
			TotalTokens:         float64(snapshot.TotalTokens),
			CostUSD:             snapshot.CostUSD,
			SessionCount:        float64(snapshot.SessionCount),
		})
	}
	return out
}

// SnapshotsOf converts cursor snapshots back to contract snapshots stamped
// with the run's collectedAt.
func SnapshotsOf(snapshots []Snapshot, collectedAt string) []contract.Snapshot {
	out := make([]contract.Snapshot, 0, len(snapshots))
	for _, snapshot := range snapshots {
		out = append(out, contract.Snapshot{
			Source:        contract.Source(snapshot.Source),
			UsageDate:     snapshot.UsageDate,
			Timezone:      snapshot.Timezone,
			Model:         snapshot.Model,
			InputTokens:   int64(snapshot.InputTokens),
			OutputTokens:  int64(snapshot.OutputTokens),
			CacheCreation: int64(snapshot.CacheCreationTokens),
			CacheRead:     int64(snapshot.CacheReadTokens),
			TotalTokens:   int64(snapshot.TotalTokens),
			CostUSD:       snapshot.CostUSD,
			SessionCount:  int64(snapshot.SessionCount),
			CollectedAt:   collectedAt,
		})
	}
	return out
}

func buildDateRangeArgs(dates map[string]bool) []string {
	if len(dates) == 0 {
		return []string{}
	}
	values := make([]string, 0, len(dates))
	for date := range dates {
		values = append(values, date)
	}
	sortStrings(values)
	return []string{"--since", toCompactDate(values[0]), "--until", toCompactDate(values[len(values)-1])}
}

func toCompactDate(value string) string {
	out := make([]byte, 0, len(value))
	for i := 0; i < len(value); i++ {
		if value[i] != '-' {
			out = append(out, value[i])
		}
	}
	return string(out)
}

func snapshotKeyOf(usageDate, model string) string {
	return usageDate + "\x00" + model
}

func sortedDates(dates map[string]bool) []string {
	out := make([]string, 0, len(dates))
	for date := range dates {
		out = append(out, date)
	}
	sortStrings(out)
	return out
}

func sortedKeys(keys map[string]HookKey) []HookKey {
	out := make([]HookKey, 0, len(keys))
	for _, key := range keys {
		out = append(out, key)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].UsageDate != out[j].UsageDate {
			return collate.Less(out[i].UsageDate, out[j].UsageDate)
		}
		return collate.Less(out[i].Model, out[j].Model)
	})
	return out
}

func sortStrings(values []string) {
	sort.SliceStable(values, func(i, j int) bool { return collate.Less(values[i], values[j]) })
}

func joinStrings(values []string, separator string) string {
	out := ""
	for index, value := range values {
		if index > 0 {
			out += separator
		}
		out += value
	}
	return out
}
