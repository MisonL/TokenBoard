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

// Port of hook-incremental.ts for the Claude path. The Codex-only fields
// (context-pricing markers, reconciliation file entries, reusable pending
// files) arrive with the Codex provider in M5; the shared scan, cursor and
// parsing semantics are already the ones that provider will use.

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
	// Now is injectable for tests; nil uses the wall clock.
	Now func() time.Time
}

// HookKey is one (usageDate, model) pair the reconciliation must cover.
type HookKey struct {
	UsageDate string
	Model     string
}

// HookIncrementalResult is the hook run's incremental state.
type HookIncrementalResult struct {
	RangeArgs       []string
	Changed         bool
	ChangedDates    []string
	ChangedKeys     []HookKey
	CachedSnapshots []Snapshot
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
	var result HookIncrementalResult
	lock, err := state.Acquire(cursorPath+".lock", cursorLockTimeout)
	if err != nil {
		return HookIncrementalResult{}, err
	}
	if lock == nil {
		return HookIncrementalResult{}, fmt.Errorf("Timed out waiting for cursor lock: %s", cursorPath+".lock")
	}
	defer func() { _ = lock.Release() }()

	scan, err := CollectChangedSessionFiles(ScanInput{
		Source:      input.Source,
		SessionsDir: input.SessionsDir,
		SessionDirs: input.SessionDirs,
		CursorPath:  cursorPath,
		Now:         now,
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
	// server never acknowledged them, so they ride along with this run.
	cachedSnapshots := []Snapshot{}
	for _, group := range scan.MissingPendingSnapshots {
		for _, snapshot := range group.Snapshots {
			cachedSnapshots = append(cachedSnapshots, restoreCursorSnapshot(snapshot))
		}
	}

	if len(scan.Files) == 0 {
		if len(cachedSnapshots) > 0 {
			if hasCursorMaintenance(scan) {
				if err := scan.Commit(input.Source); err != nil {
					return HookIncrementalResult{}, err
				}
			}
			return HookIncrementalResult{
				RangeArgs:       []string{},
				Changed:         true,
				ChangedDates:    []string{},
				ChangedKeys:     []HookKey{},
				CachedSnapshots: cachedSnapshots,
			}, nil
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
		return HookIncrementalResult{
			RangeArgs:       []string{},
			Changed:         false,
			ChangedDates:    []string{},
			ChangedKeys:     []HookKey{},
			CachedSnapshots: []Snapshot{},
		}, nil
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

	result = HookIncrementalResult{
		RangeArgs:       buildDateRangeArgs(parsed.changedDates),
		Changed:         len(parsed.changedDates) > 0 || len(cachedSnapshots) > 0,
		ChangedDates:    sortedDates(parsed.changedDates),
		ChangedKeys:     sortedKeys(parsed.changedKeys),
		CachedSnapshots: cachedSnapshots,
	}
	return result, nil
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
}

func parseChangedFiles(input HookInput, scan *ScanResult) (parsedFiles, error) {
	parsed := parsedFiles{
		changedDates: map[string]bool{},
		changedKeys:  map[string]HookKey{},
	}
	for _, file := range scan.Files {
		lines := []sessionfile.Line{}
		if err := file.ReadLines(func(line sessionfile.Line) error {
			lines = append(lines, line)
			return nil
		}); err != nil {
			return parsedFiles{}, err
		}
		result, err := sessionfile.Parse(sessionfile.ParseInput{
			Source:      input.Source,
			Timezone:    input.Timezone,
			CollectedAt: input.CollectedAt,
			SessionID:   file.RelativePath,
		}, lines)
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
