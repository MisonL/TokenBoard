package antigravitygui

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravityhistory"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravitymeta"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravityscan"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessioncursor"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessionusage"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
	"github.com/MisonL/TokenBoard/clients/go/internal/state"
)

// The language-server bounds, matching the TS constants.
const (
	defaultMaxLanguageServerCascades = 12
	// MaxLanguageServerUsageEvents caps how many usage events one run may
	// ingest from the language-server route.
	MaxLanguageServerUsageEvents = 32_768
)

// cursorLockTimeout matches the TS cursor lock's 35s acquisition window.
const cursorLockTimeout = 35 * time.Second

// PartialUsageError reports a run that collected the SQLite history but could
// not finish the language-server route. The snapshots it did collect are
// carried so the caller can still upload them, and Fatal says whether the
// failure was anything other than "the language server is not here".
type PartialUsageError struct {
	Message   string
	Snapshots []contract.Snapshot
	Fatal     bool
	Cause     error
}

func (e *PartialUsageError) Error() string { return e.Message }

// IsPartialUsageError reports whether err carries partial usage.
func IsPartialUsageError(err error) (*PartialUsageError, bool) {
	var partial *PartialUsageError
	if errors.As(err, &partial) {
		return partial, true
	}
	return nil, false
}

// Collect gathers one GUI/IDE source's usage: the shared conversation SQLite
// history, then the optional language-server route for what the history did
// not cover.
func Collect(options Options) ([]contract.Snapshot, error) {
	timezone := options.Timezone
	if timezone == "" {
		timezone = sessionusage.LocalTimezone()
	}
	collectedAt := options.CollectedAt
	if collectedAt == "" {
		collectedAt = nowISO()
	}
	stateDir := options.StateDir
	if stateDir == "" {
		stateDir = state.ResolveDir(options.Env, homeDir(options))
	}

	cursorPath := filepath.Join(stateDir, sessioncursor.FileName(contract.Source(options.Source), options.CursorScope))
	lock, err := state.Acquire(cursorPath+".lock", cursorLockTimeout)
	if err != nil {
		return nil, err
	}
	if lock == nil {
		return nil, fmt.Errorf("could not acquire the %s cursor lock at %s", options.Source, cursorPath)
	}
	defer func() { _ = lock.Release() }()

	cursor, err := sessioncursor.Read(cursorPath, options.Source)
	if err != nil {
		return nil, err
	}
	rangeValue, err := antigravityscan.ResolveCollectionRange(sincePointer(options.Since), timezone, options.Env)
	if err != nil {
		return nil, err
	}

	pendingSnapshotGroups := sessioncursor.SelectPendingCursorSnapshotGroups(&cursor, rangeValue.SinceDate, nil)
	PrepareGuiHistoryScope(&cursor, options.Source, rangeValue.HistoryScope)
	scanState := cursorDBFileScan(cursor)
	cascadeScan := cursorCascadeFileScan(cursor)

	var snapshots []contract.Snapshot
	emittedKeys := map[string]bool{}

	localRead := readGuiLocalDbUsageWithCursorRecovery(
		options, &cursor, rangeValue, timezone, collectedAt, &scanState)
	// A failed local read surfaces before the completeness assertion: the error
	// path carries no scan result at all (the TS reader returns a result without
	// completeDirectoryScan), so asserting on it would mask the real failure.
	if localRead.Error != nil {
		if !IsUnavailableDBError(localRead.Error) {
			return nil, localRead.Error
		}
	} else if err := assertFullHistoryDirectoryScanComplete(options.Source, rangeValue, localRead.Usage); err != nil {
		return nil, err
	}
	for _, event := range localRead.Usage.Events {
		if !rangeValue.IncludesTimestamp(parseIsoTime(event.CreatedAt)) {
			continue
		}
		PushGuiUsageEvent(PushGuiUsageEventInput{
			Event: event, Origin: OriginDatabase, Cursor: &cursor,
			Snapshots: &snapshots, EmittedKeys: emittedKeys,
			Timezone: timezone, CollectedAt: collectedAt, Source: options.Source,
		})
	}

	if err := collectLanguageServerUsage(languageServerInput{
		options:     options,
		cursor:      &cursor,
		cursorPath:  cursorPath,
		snapshots:   &snapshots,
		emittedKeys: emittedKeys,
		timezone:    timezone,
		collectedAt: collectedAt,
		localUsage:  localRead.Usage,
		rangeValue:  rangeValue,
		cascadeScan: &cascadeScan,
		dbScan:      &scanState,
	}); err != nil {
		return nil, err
	}

	MarkDbCascadeRowsProcessed(MarkDbCascadeRowsProcessedInput{
		Cursor:                    &cursor,
		Source:                    options.Source,
		LastReadRowIndexByCascade: localRead.Usage.LastReadRowIndexByCascade,
		HistoryScope:              rangeValue.HistoryScope,
		CollectedAt:               collectedAt,
	})
	PushCompleteGuiCursorSnapshots(&snapshots, &cursor, collectedAt, emittedKeys,
		func(snapshot sessioncursor.Snapshot) bool {
			return sessioncursor.ShouldIncludeCursorSnapshot(snapshot, rangeValue.SinceDate, pendingSnapshotGroups)
		})

	merged := sessioncursor.MergeSnapshots(snapshots)
	for _, snapshot := range merged {
		if err := snapshot.Validate(); err != nil {
			return nil, fmt.Errorf("%s snapshot rejected: %w", options.Source, err)
		}
	}
	if err := setCursorDBFileScan(&cursor, scanState); err != nil {
		return nil, err
	}
	if err := setCursorCascadeFileScan(&cursor, cascadeScan); err != nil {
		return nil, err
	}
	if err := sessioncursor.Write(cursorPath, cursor); err != nil {
		return nil, err
	}
	return merged, nil
}

// readGuiLocalDbUsageWithCursorRecovery reads the history, and on a detected
// row-cursor reset under a full-history run rebuilds it once: the reset means
// the database was rebuilt, and --since all is exactly the request to re-read
// everything.
func readGuiLocalDbUsageWithCursorRecovery(
	options Options,
	cursor *sessioncursor.State,
	rangeValue antigravityscan.CollectionRange,
	timezone string,
	collectedAt string,
	scanState *antigravityscan.FileScanState,
) LocalDBRead {
	first := ReadGuiLocalDbUsage(options, *cursor, rangeValue, timezone, scanState)
	if !rangeValue.FullHistory || !antigravityhistory.IsRowCursorResetError(first.Error) {
		return first
	}

	corrections, err := ResetGuiDbCursorState(cursor, options.Source)
	if err != nil {
		return LocalDBRead{Usage: emptyHistoryResult(), Error: err}
	}
	if options.Stderr != nil {
		options.Stderr("Antigravity SQLite metadata cursor reset detected; rebuilding full local database history once")
	}
	// The reset replaced the scan state, so the retry starts from the cursor's
	// fresh one.
	*scanState = cursorDBFileScan(*cursor)
	rebuilt := ReadGuiLocalDbUsage(options, *cursor, rangeValue, timezone, scanState)
	if rebuilt.Error != nil {
		return LocalDBRead{Usage: emptyHistoryResult(), Error: fmt.Errorf(
			"Antigravity SQLite metadata cursor reset recovery failed: %w", rebuilt.Error)}
	}
	QueueGuiDbResetCorrections(cursor, corrections, collectedAt)
	return rebuilt
}

type languageServerInput struct {
	options     Options
	cursor      *sessioncursor.State
	cursorPath  string
	snapshots   *[]contract.Snapshot
	emittedKeys map[string]bool
	timezone    string
	collectedAt string
	localUsage  antigravityhistory.Result
	rangeValue  antigravityscan.CollectionRange
	cascadeScan *antigravityscan.FileScanState
	dbScan      *antigravityscan.FileScanState
}

// collectLanguageServerUsage runs the optional language-server route. It
// raises rather than returning the failure: the caller has to skip the
// remaining bookkeeping when this route fails, because the partial progress
// was already persisted by preservePartialGuiUsage.
func collectLanguageServerUsage(input languageServerInput) error {
	var request func(GeneratorMetadataRequest) (any, error)
	var closeRequest func() error
	var collectionError error
	cleanupErrors := []error{}

	uncaptured, err := listUncapturedLanguageServerCascades(input)
	if err == nil && len(uncaptured) > 0 {
		request, closeRequest, err = createRequestContext(input.options)
	}
	if err == nil && request != nil {
		err = requestLanguageServerUsage(input, uncaptured, request)
	}
	if err != nil {
		collectionError = err
		preservePartialGuiUsage(input, &cleanupErrors)
	}
	if closeRequest != nil {
		if closeErr := closeRequest(); closeErr != nil {
			cleanupErrors = append(cleanupErrors, closeErr)
		}
	}
	if collectionError != nil {
		return guiCollectionError(collectionError, *input.snapshots, cleanupErrors)
	}
	if len(cleanupErrors) > 0 {
		return guiCollectionError(cleanupErrors[0], *input.snapshots, cleanupErrors[1:])
	}
	return nil
}

// guiCollectionError classifies a failed language-server route. With usage
// already collected it becomes a partial error carrying the validated
// snapshots; the cleanup failures (a language server that would not shut
// down) ride along as the cause and make the partial error fatal. Without
// snapshots the original error is returned untouched — the CLI classifies it
// by message, and rewriting it would hide the real cause.
func guiCollectionError(err error, snapshots []contract.Snapshot, cleanupErrors []error) error {
	cause := cleanupErrorCause(cleanupErrors)
	if len(snapshots) > 0 {
		unavailable := IsUnavailableLanguageServerError(err)
		label := "Antigravity language server collection failed"
		if unavailable {
			label = "Antigravity language server unavailable"
		}
		merged := sessioncursor.MergeSnapshots(snapshots)
		for _, snapshot := range merged {
			if validateErr := snapshot.Validate(); validateErr != nil {
				if cause == nil {
					return fmt.Errorf("%s snapshot rejected: %w", snapshot.Source, validateErr)
				}
				return fmt.Errorf("%s snapshot rejected: %w: %v", snapshot.Source, validateErr, cause)
			}
		}
		return &PartialUsageError{
			Message:   label + " after DB history was collected: " + err.Error(),
			Snapshots: merged,
			Fatal:     len(cleanupErrors) > 0 || !unavailable,
			Cause:     cause,
		}
	}
	if cause == nil {
		return err
	}
	return &cleanupCauseError{Message: err.Error(), Cause: combineCauses(err, cause)}
}

// cleanupCauseError is the primary error with the cleanup failures attached.
type cleanupCauseError struct {
	Message string
	Cause   error
}

func (e *cleanupCauseError) Error() string { return e.Message }
func (e *cleanupCauseError) Unwrap() error { return e.Cause }

func combineCauses(primary error, cause error) error {
	if primary == nil {
		return cause
	}
	return errors.Join(primary, cause)
}

func cleanupErrorCause(cleanupErrors []error) error {
	if len(cleanupErrors) == 0 {
		return nil
	}
	if len(cleanupErrors) == 1 {
		return cleanupErrors[0]
	}
	return errors.Join(cleanupErrors...)
}

func createRequestContext(options Options) (func(GeneratorMetadataRequest) (any, error), func() error, error) {
	if options.RequestGeneratorMetadata != nil {
		return options.RequestGeneratorMetadata, func() error { return nil }, nil
	}
	client, err := CreateLanguageServerClient(options, options.LanguageServerPath, options.OverrideIdeVersion, options.LanguageServerPort)
	if err != nil {
		return nil, nil, err
	}
	return client.RequestGeneratorMetadata, client.Close, nil
}

// requestLanguageServerUsage asks the server about each uncaptured cascade,
// persisting the cursor after each one so a later failure keeps the progress.
func requestLanguageServerUsage(
	input languageServerInput,
	uncaptured []CascadeRef,
	request func(GeneratorMetadataRequest) (any, error),
) error {
	usageEventCount := 0
	for _, cascade := range uncaptured {
		response, err := request(GeneratorMetadataRequest{Source: input.options.Source, CascadeID: cascade.ID})
		if err != nil {
			return err
		}
		events, err := antigravitymeta.ParseGeneratorMetadata(response, cascade.ID)
		if err != nil {
			return err
		}
		usageEventCount, err = ReserveLanguageServerUsageEvents(usageEventCount, len(events))
		if err != nil {
			return err
		}
		hasUsableEvents := false
		for _, event := range events {
			hasUsableEvents = true
			if !input.rangeValue.IncludesTimestamp(parseIsoTime(event.CreatedAt)) {
				continue
			}
			PushGuiUsageEvent(PushGuiUsageEventInput{
				Event: event, Origin: OriginLanguageServer, Cursor: input.cursor,
				Snapshots: input.snapshots, EmittedKeys: input.emittedKeys,
				Timezone: input.timezone, CollectedAt: input.collectedAt, Source: input.options.Source,
			})
		}
		if !hasUsableEvents {
			MarkEmptyCascadeAttempted(input.cursor, input.options.Source, cascade.ID,
				cascade.MtimeMs, cascade.Size, input.rangeValue.HistoryScope, input.collectedAt)
		} else {
			MarkCascadeProcessed(input.cursor, input.options.Source, cascade.ID,
				cascade.MtimeMs, cascade.Size, input.rangeValue.HistoryScope, input.collectedAt)
		}
		// Persist per cascade: a failure on a later one must not lose the
		// progress already made.
		if err := sessioncursor.Write(input.cursorPath, *input.cursor); err != nil {
			return err
		}
	}
	return nil
}

// ReserveLanguageServerUsageEvents accounts one cascade's events against the
// per-run limit, refusing the run that would exceed it.
func ReserveLanguageServerUsageEvents(currentCount, incomingCount int) (int, error) {
	nextCount := currentCount + incomingCount
	if nextCount > MaxLanguageServerUsageEvents {
		return currentCount, fmt.Errorf(
			"Antigravity language server metadata exceeded the %d usage-event limit",
			MaxLanguageServerUsageEvents)
	}
	return nextCount, nil
}

// listUncapturedLanguageServerCascades returns the conversations the language
// server should be asked about, most valuable first.
func listUncapturedLanguageServerCascades(input languageServerInput) ([]CascadeRef, error) {
	maxCascades := NormalizeMaxLanguageServerCascades(input.options.MaxLanguageServerCascades)
	frontier, hasFrontier := ReadEmptyCascadeFrontier(*input.cursor, input.options.Source, input.rangeValue.HistoryScope)
	var frontierPointer *EmptyCascadeFrontier
	if hasFrontier {
		frontierPointer = &frontier
	}
	compare := func(left, right CascadeRef) int {
		return CompareLanguageServerCascadePriority(left, right, frontierPointer)
	}

	cascades, err := readLanguageServerCascadeRefs(input, maxCascades, compare)
	if err != nil {
		return nil, err
	}
	MarkDbCascadeRowsProcessed(MarkDbCascadeRowsProcessedInput{
		Cursor:            input.cursor,
		CoveredCascadeIDs: input.localUsage.CascadeIDs,
		CoveredCascades:   cascades,
		Source:            input.options.Source,
		HistoryScope:      input.rangeValue.HistoryScope,
		CollectedAt:       input.collectedAt,
	})

	filtered := make([]CascadeRef, 0, len(cascades))
	for _, cascade := range cascades {
		if !input.rangeValue.IncludesFileMtime(cascade.MtimeMs) {
			continue
		}
		if !ShouldRequestLanguageServerCascade(*input.cursor, input.options.Source, input.localUsage, cascade,
			input.rangeValue.HistoryScope) {
			continue
		}
		filtered = append(filtered, cascade)
	}
	sort.SliceStable(filtered, func(i, j int) bool { return compare(filtered[i], filtered[j]) < 0 })
	if len(filtered) > maxCascades {
		filtered = filtered[:maxCascades]
	}
	return filtered, nil
}

// readLanguageServerCascadeRefs lists the candidate conversations: an
// injected listing when the caller supplied one, otherwise the bounded
// directory walk.
func readLanguageServerCascadeRefs(
	input languageServerInput,
	maxCascades int,
	compare func(CascadeRef, CascadeRef) int,
) ([]CascadeRef, error) {
	if input.options.ListCascades != nil {
		return input.options.ListCascades()
	}
	if input.options.ListCascadeIDs != nil {
		ids, err := input.options.ListCascadeIDs()
		if err != nil {
			return nil, err
		}
		cascades := make([]CascadeRef, 0, len(ids))
		for _, id := range ids {
			cascades = append(cascades, CascadeRef{ID: id})
		}
		return cascades, nil
	}
	return ListAntigravityCascades(ListCascadesInput{
		Source:             input.options.Source,
		ConversationDir:    input.options.ConversationDir,
		Limit:              maxCascades,
		RequiredCascadeIDs: requiredLanguageServerCascadeIDs(*input.cursor, input.localUsage),
		CompareCascades:    compare,
		ScanState:          input.cascadeScan,
		HomeDir:            input.options.HomeDir,
		IncludeCascade: func(cascade CascadeRef) bool {
			if !input.rangeValue.IncludesFileMtime(cascade.MtimeMs) {
				return false
			}
			if input.localUsage.CascadeIDs[cascade.ID] {
				MarkDbCascadeRowsProcessed(MarkDbCascadeRowsProcessedInput{
					Cursor:            input.cursor,
					CoveredCascadeIDs: input.localUsage.CascadeIDs,
					CoveredCascades:   []CascadeRef{cascade},
					Source:            input.options.Source,
					HistoryScope:      input.rangeValue.HistoryScope,
					CollectedAt:       input.collectedAt,
				})
			}
			return ShouldRequestLanguageServerCascade(*input.cursor, input.options.Source, input.localUsage, cascade,
				input.rangeValue.HistoryScope)
		},
	})
}

// ShouldRequestLanguageServerCascade reports whether a cascade still needs a
// language-server request.
func ShouldRequestLanguageServerCascade(
	cursor sessioncursor.State,
	source Source,
	localUsage antigravityhistory.Result,
	cascade CascadeRef,
	historyScope string,
) bool {
	_, rowRead := localUsage.LastReadRowIndexByCascade[cascade.ID]
	databaseScanPending := cascade.HasDatabaseFile && !rowRead
	return !databaseScanPending &&
		!localUsage.CascadeIDs[cascade.ID] &&
		!HasDbCascadeRowsProcessed(cursor, source, cascade.ID, cascade.MtimeMs, cascade.Size, historyScope) &&
		ShouldRequestCascade(cursor, source, cascade.ID, cascade.MtimeMs, cascade.Size, historyScope)
}

// requiredLanguageServerCascadeIDs are the conversations that must be listed
// even if the directory walk does not reach them.
func requiredLanguageServerCascadeIDs(cursor sessioncursor.State, localUsage antigravityhistory.Result) []string {
	seen := map[string]bool{}
	ids := []string{}
	for id := range localUsage.CascadeIDs {
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	rowIDs := make([]string, 0, len(localUsage.LastReadRowIndexByCascade))
	for id := range localUsage.LastReadRowIndexByCascade {
		rowIDs = append(rowIDs, id)
	}
	sort.Strings(rowIDs)
	for _, id := range rowIDs {
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	_ = cursor
	return ids
}

// CompareLanguageServerCascadePriority orders cascades: anything newer than the
// empty-cascade frontier first, then by recency.
func CompareLanguageServerCascadePriority(left, right CascadeRef, frontier *EmptyCascadeFrontier) int {
	if frontier != nil {
		leftAfter := isCascadeAfterFrontier(left, *frontier)
		rightAfter := isCascadeAfterFrontier(right, *frontier)
		if leftAfter != rightAfter {
			if leftAfter {
				return -1
			}
			return 1
		}
	}
	return compareCascadeRecency(left, right)
}

func isCascadeAfterFrontier(cascade CascadeRef, frontier EmptyCascadeFrontier) bool {
	if cascade.MtimeMs != frontier.MtimeMs {
		return cascade.MtimeMs < frontier.MtimeMs
	}
	return compareHashes(antigravitymeta.Hash(cascade.ID), frontier.CascadeHash) > 0
}

func compareCascadeRecency(left, right CascadeRef) int {
	if right.MtimeMs != left.MtimeMs {
		if right.MtimeMs > left.MtimeMs {
			return 1
		}
		return -1
	}
	return compareHashes(antigravitymeta.Hash(left.ID), antigravitymeta.Hash(right.ID))
}

// NormalizeMaxLanguageServerCascades clamps the cascade budget. Nil is the
// unset budget, which defaults; a supplied value is clamped, and an explicit
// zero stays zero — the TS `Math.min(Math.floor(value), default)` behaviour.
func NormalizeMaxLanguageServerCascades(value *int) int {
	if value == nil || *value < 0 {
		return defaultMaxLanguageServerCascades
	}
	if *value > defaultMaxLanguageServerCascades {
		return defaultMaxLanguageServerCascades
	}
	return *value
}

// preservePartialGuiUsage persists the DB-derived progress when the
// language-server route fails, so the next run does not re-read what this one
// already accounted for.
func preservePartialGuiUsage(input languageServerInput, cleanupErrors *[]error) {
	MarkDbCascadeRowsProcessed(MarkDbCascadeRowsProcessedInput{
		Cursor:                    input.cursor,
		Source:                    input.options.Source,
		LastReadRowIndexByCascade: input.localUsage.LastReadRowIndexByCascade,
		HistoryScope:              input.rangeValue.HistoryScope,
		CollectedAt:               input.collectedAt,
	})
	PushCompleteGuiCursorSnapshots(input.snapshots, input.cursor, input.collectedAt, input.emittedKeys,
		func(snapshot sessioncursor.Snapshot) bool {
			return sessioncursor.ShouldIncludeCursorSnapshot(
				snapshot,
				input.rangeValue.SinceDate,
				sessioncursor.SelectPendingCursorSnapshotGroups(
					input.cursor, input.rangeValue.SinceDate, nil))
		})
	// The TS reader mutates cursor.antigravityDbFileScan in place, so the
	// partial write persists the rotation bookkeeping it recorded. Go's reader
	// works on a copy, so put both scan states back before writing.
	if input.dbScan != nil {
		if err := setCursorDBFileScan(input.cursor, *input.dbScan); err != nil {
			*cleanupErrors = append(*cleanupErrors, err)
		}
	}
	if input.cascadeScan != nil {
		if err := setCursorCascadeFileScan(input.cursor, *input.cascadeScan); err != nil {
			*cleanupErrors = append(*cleanupErrors, err)
		}
	}
	if err := sessioncursor.Write(input.cursorPath, *input.cursor); err != nil {
		*cleanupErrors = append(*cleanupErrors, err)
	}
}

func assertFullHistoryDirectoryScanComplete(
	source Source,
	rangeValue antigravityscan.CollectionRange,
	usage antigravityhistory.Result,
) error {
	if rangeValue.FullHistory && !usage.CompleteDirectoryScan {
		return fmt.Errorf("Antigravity GUI --since all requires a complete SQLite directory scan")
	}
	return nil
}

func sincePointer(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func emptyHistoryResult() antigravityhistory.Result {
	return antigravityhistory.Result{
		CascadeIDs:                map[string]bool{},
		Events:                    []antigravitymeta.UsageEvent{},
		KnownCascadeIDs:           map[string]bool{},
		LastReadRowIndexByCascade: map[string]int64{},
	}
}

func homeDir(options Options) string {
	if options.HomeDir != "" {
		return options.HomeDir
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return home
}
