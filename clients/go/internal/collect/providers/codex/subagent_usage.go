package codex

// Port of codex-subagent-usage.ts: the correction that removes a parent
// session's copied child usage from the daily snapshots.
//
// Codex child (subagent) sessions start from the parent's conversation, so
// their cumulative counters include history the parent already reports. ccusage
// counts each session file's totals, so the daily aggregate double-counts that
// inherited history. The correction reads each child session's per-request
// usage, subtracts it from the parent's daily (date, model) snapshots, and
// leaves everything else untouched.
//
// The correction only ever subtracts. When the child reports more usage than
// the row it would be subtracted from — which happens when ccusage's daily
// total is already request-based while the session row kept cumulative
// counters — the row is left as it was and the refusal is reported. A silent
// clamp would undercount charged usage, and a negative row would be rejected
// by the server far from the cause.

import (
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessionusage"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessionwalk"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// SubagentCorrectionInput configures one correction pass.
type SubagentCorrectionInput struct {
	Snapshots []contract.Snapshot
	// Sessions is the session report. Raw JSON bytes keep object key order,
	// which decides how a corrected total is spread across a multi-model row;
	// an already-decoded Go map cannot and is decoded in sorted key order.
	Sessions      any
	CodexHomes    []string
	Timezone      string
	Stderr        func(string)
	StateDir      string
	CacheFiles    map[string]CodexSubagentUsageCacheFile
	ReadChildUsageByDate ReadChildUsageByDate
	ReadChildUsageEvents ReadChildUsageEvents
	MaxConcurrentChildReads int
	CodexSymlinkRoots       []string
}

type subagentMeta struct {
	startedAt string
}

type resolvedSessionFile struct {
	sourceFilePath string
	readFilePath   string
}

type oversizedIrrelevantChildRowSummary struct {
	rows         int64
	largestBytes int64
}

var oversizedIrrelevantChildRowPattern = regexp.MustCompile(
	`^Skipped ([1-9][0-9]*) oversized Codex child session JSONL rows? without usage or subagent metadata \(largest ([1-9][0-9]*) bytes\)$`)

// ApplyCodexSubagentUsageCorrections ports
// applyCodexSubagentUsageCorrections. The returned snapshots are a new slice;
// the input is not mutated, exactly like the TS map.
func ApplyCodexSubagentUsageCorrections(input SubagentCorrectionInput) ([]contract.Snapshot, error) {
	if len(input.Snapshots) == 0 {
		return input.Snapshots, nil
	}
	timezone := input.Timezone
	if timezone == "" {
		timezone = sessionusage.LocalTimezone()
	}
	sessions, err := NormalizeSubagentSessions(input.Sessions)
	if err != nil {
		return nil, err
	}
	runtime, err := createChildReaderRuntime(input)
	if err != nil {
		return nil, err
	}
	diagnostics := createCodexSubagentDiagnostics(input.Stderr)
	earliestSnapshotDate := input.Snapshots[0].UsageDate
	for _, snapshot := range input.Snapshots {
		if snapshot.UsageDate < earliestSnapshotDate {
			earliestSnapshotDate = snapshot.UsageDate
		}
	}
	adjustments, err := collectSubagentAdjustmentsViaCache(subagentAdjustmentInput{
		sessions:             sessions,
		codexHomes:           input.CodexHomes,
		timezone:             timezone,
		earliestSnapshotDate: earliestSnapshotDate,
		stderr:               diagnostics.report,
		readChildUsageByDate: runtime.read,
		readChildUsageEvents: runtime.readEvents,
		maxConcurrentReads:   runtime.concurrency,
		codexSymlinkRoots:    input.CodexSymlinkRoots,
		stateDir:             input.StateDir,
		cacheFiles:           input.CacheFiles,
	})
	// The TS runs this pair in a finally: the reader is closed even when the
	// collect failed, and the coalesced diagnostics are always flushed.
	closeErr := runtime.close()
	diagnostics.flush()
	if closeErr != nil {
		return nil, closeErr
	}
	if err != nil {
		return nil, err
	}
	if len(adjustments) == 0 {
		return input.Snapshots, nil
	}
	out := make([]contract.Snapshot, len(input.Snapshots))
	for index, snapshot := range input.Snapshots {
		adjustment, ok := adjustments[snapshotKey(snapshot.UsageDate, snapshot.Model)]
		if !ok {
			out[index] = snapshot
			continue
		}
		corrected, err := subtractAdjustment(snapshot, adjustment, diagnostics.report)
		if err != nil {
			return nil, err
		}
		out[index] = corrected
	}
	return out, nil
}

type subagentAdjustmentInput struct {
	sessions             any
	codexHomes           []string
	timezone             string
	earliestSnapshotDate string
	stderr               func(string)
	readChildUsageByDate ReadChildUsageByDate
	readChildUsageEvents ReadChildUsageEvents
	maxConcurrentReads   int
	codexSymlinkRoots    []string
	stateDir             string
	cacheFiles           map[string]CodexSubagentUsageCacheFile
}

func collectSubagentAdjustmentsViaCache(input subagentAdjustmentInput) (map[string]Metric, error) {
	adjustments := map[string]Metric{}
	err := WithCodexSubagentUsageCache(CodexSubagentUsageCacheInput{
		StateDir:             input.stateDir,
		Timezone:             input.timezone,
		CacheFiles:           input.cacheFiles,
		ReadChildUsageByDate: input.readChildUsageByDate,
		ReadChildUsageEvents: input.readChildUsageEvents,
		Callback: func(reader CodexSubagentUsageCacheReader) error {
			collected, err := collectSubagentAdjustments(input, reader)
			if err != nil {
				return err
			}
			adjustments = collected
			return nil
		},
	})
	if err != nil {
		return nil, err
	}
	return adjustments, nil
}

// createCodexSubagentDiagnostics ports createCodexSubagentDiagnostics. The
// reader reports one oversized-row summary per scanned file; a correction
// scanning many files would otherwise print one line per file, so the
// summaries are coalesced into one line at flush.
type subagentDiagnostics struct {
	mu                  sync.Mutex
	stderr              func(string)
	skippedRows         int64
	largestSkippedBytes int64
	skippedRowScans     int64
}

func createCodexSubagentDiagnostics(stderr func(string)) *subagentDiagnostics {
	return &subagentDiagnostics{stderr: stderr}
}

func (d *subagentDiagnostics) report(line string) {
	summary, ok := parseOversizedIrrelevantChildRowSummary(line)
	if !ok {
		emitStderr(d.stderr, line)
		return
	}
	d.mu.Lock()
	d.skippedRows += summary.rows
	if summary.largestBytes > d.largestSkippedBytes {
		d.largestSkippedBytes = summary.largestBytes
	}
	d.skippedRowScans++
	d.mu.Unlock()
}

func (d *subagentDiagnostics) flush() {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.skippedRows == 0 {
		return
	}
	rowLabel := "rows"
	if d.skippedRows == 1 {
		rowLabel = "row"
	}
	scanLabel := "scans"
	if d.skippedRowScans == 1 {
		scanLabel = "scan"
	}
	emitStderr(d.stderr, fmt.Sprintf(
		"Skipped %d oversized Codex child session JSONL %s without usage or subagent metadata across %d %s (largest %d bytes)",
		d.skippedRows, rowLabel, d.skippedRowScans, scanLabel, d.largestSkippedBytes))
}

func parseOversizedIrrelevantChildRowSummary(line string) (oversizedIrrelevantChildRowSummary, bool) {
	match := oversizedIrrelevantChildRowPattern.FindStringSubmatch(line)
	if match == nil {
		return oversizedIrrelevantChildRowSummary{}, false
	}
	rows, err := strconv.ParseInt(match[1], 10, 64)
	if err != nil {
		return oversizedIrrelevantChildRowSummary{}, false
	}
	largest, err := strconv.ParseInt(match[2], 10, 64)
	if err != nil {
		return oversizedIrrelevantChildRowSummary{}, false
	}
	return oversizedIrrelevantChildRowSummary{rows: rows, largestBytes: largest}, true
}

type childReaderRuntime struct {
	concurrency int
	read        ReadChildUsageByDate
	readEvents  ReadChildUsageEvents
	mu          sync.Mutex
	pool        *SubagentUsageWorkerPool
}

// createChildReaderRuntime ports createChildReaderRuntime. An injected reader
// is used directly with concurrency 1 unless the caller asks for more; the
// in-process pool is created lazily so a run with no candidate sessions never
// starts one.
func createChildReaderRuntime(input SubagentCorrectionInput) (*childReaderRuntime, error) {
	hasInjectedReader := input.ReadChildUsageByDate != nil || input.ReadChildUsageEvents != nil
	concurrency := 0
	if input.MaxConcurrentChildReads == 0 {
		if hasInjectedReader {
			concurrency = 1
		} else {
			concurrency = DefaultCodexSubagentWorkerCount()
		}
	} else {
		normalized, err := NormalizeCodexSubagentWorkerCount(input.MaxConcurrentChildReads)
		if err != nil {
			return nil, err
		}
		concurrency = normalized
	}

	readByDate := input.ReadChildUsageByDate
	if readByDate == nil {
		readByDate = func(filePath, timestamp, timezone string, stderr func(string), _ string) ([]DatedUsage, error) {
			return ReadChildLastUsageByDate(filePath, timestamp, timezone, stderr)
		}
	}
	readEvents := input.ReadChildUsageEvents
	if readEvents == nil {
		readEvents = func(filePath, timestamp, timezone string, stderr func(string), _ string) ([]ChildUsageEvent, error) {
			return ReadChildLastUsageEvents(filePath, timestamp, timezone, stderr)
		}
	}
	if hasInjectedReader || concurrency == 1 {
		return &childReaderRuntime{
			concurrency: concurrency,
			read:        readByDate,
			readEvents:  readEvents,
		}, nil
	}
	runtime := &childReaderRuntime{concurrency: concurrency}
	runtime.read = func(filePath, timestamp, timezone string, stderr func(string), _ string) ([]DatedUsage, error) {
		pool, err := runtime.getPool()
		if err != nil {
			return nil, err
		}
		return pool.Read(filePath, timestamp, timezone, stderr)
	}
	runtime.readEvents = func(filePath, timestamp, timezone string, stderr func(string), _ string) ([]ChildUsageEvent, error) {
		pool, err := runtime.getPool()
		if err != nil {
			return nil, err
		}
		return pool.ReadEvents(filePath, timestamp, timezone, stderr)
	}
	return runtime, nil
}

// getPool lazily creates the pool. The TS lazy initializer cannot fail; the Go
// constructor validates the same count that was already normalized, so an
// error here is a programming error surfaced rather than swallowed.
func (r *childReaderRuntime) getPool() (*SubagentUsageWorkerPool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.pool != nil {
		return r.pool, nil
	}
	pool, err := NewCodexSubagentUsageWorkerPool(r.concurrency, nil)
	if err != nil {
		return nil, err
	}
	r.pool = pool
	return pool, nil
}

// close ports the runtime's `close: async () => pool?.close()`.
func (r *childReaderRuntime) close() error {
	r.mu.Lock()
	pool := r.pool
	r.mu.Unlock()
	if pool == nil {
		return nil
	}
	return pool.Close()
}

// mapSubagentWithConcurrency ports mapWithConcurrency: at most concurrency
// mappers run at once, results keep their input order.
func mapSubagentWithConcurrency[T, R any](
	values []T,
	concurrency int,
	mapper func(value T, index int) (R, error),
) ([]R, error) {
	results := make([]R, len(values))
	if len(values) == 0 {
		return results, nil
	}
	workers := concurrency
	if workers > len(values) {
		workers = len(values)
	}
	if workers < 1 {
		workers = 1
	}
	var (
		mu       sync.Mutex
		next     int
		firstErr error
		wg       sync.WaitGroup
	)
	for worker := 0; worker < workers; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				mu.Lock()
				if firstErr != nil || next >= len(values) {
					mu.Unlock()
					return
				}
				index := next
				next++
				mu.Unlock()
				result, err := mapper(values[index], index)
				if err != nil {
					mu.Lock()
					if firstErr == nil {
						firstErr = err
					}
					mu.Unlock()
					return
				}
				results[index] = result
			}
		}()
	}
	wg.Wait()
	if firstErr != nil {
		return nil, firstErr
	}
	return results, nil
}

func collectSubagentAdjustments(
	input subagentAdjustmentInput,
	reader CodexSubagentUsageCacheReader,
) (map[string]Metric, error) {
	rows := []*subagentRecord{}
	for _, row := range extractSubagentRows(input.sessions) {
		affects, err := sessionCouldAffectSnapshotWindow(row, input.earliestSnapshotDate, input.timezone)
		if err != nil {
			return nil, err
		}
		if affects {
			rows = append(rows, row)
		}
	}
	results, err := mapSubagentWithConcurrency(rows, input.maxConcurrentReads, func(row *subagentRecord, _ int) ([]Metric, error) {
		return collectSessionAdjustments(row, input, reader)
	})
	if err != nil {
		return nil, err
	}
	adjustments := map[string]Metric{}
	for _, sessionAdjustments := range results {
		for _, adjustment := range sessionAdjustments {
			AddMetric(adjustments, adjustment)
		}
	}
	return adjustments, nil
}

// sessionCouldAffectSnapshotWindow skips a session whose last activity is
// before the earliest snapshot: no snapshot can receive its correction. A
// malformed value stays on the validation path, because the row might still
// resolve to a child session.
func sessionCouldAffectSnapshotWindow(
	row *subagentRecord,
	earliestSnapshotDate string,
	timezone string,
) (bool, error) {
	lastActivity := row.readString([]string{"lastActivity", "date", "usageDate"})
	if lastActivity == "" {
		return true, nil
	}
	date, err := FormatCodexUsageDate(lastActivity, timezone)
	if err != nil {
		return true, nil
	}
	return date >= earliestSnapshotDate, nil
}

func collectSessionAdjustments(
	row *subagentRecord,
	input subagentAdjustmentInput,
	reader CodexSubagentUsageCacheReader,
) ([]Metric, error) {
	sessionFiles, err := resolveSubagentSessionFiles(row, input.codexHomes, input.codexSymlinkRoots)
	if err != nil {
		return nil, err
	}
	if len(sessionFiles) == 0 {
		return nil, nil
	}
	meta, err := readSubagentMetaFromFiles(sessionFiles, input.stderr)
	if err != nil {
		return nil, err
	}
	if meta == nil {
		return nil, nil
	}
	originals, err := readModelMetrics(row)
	if err != nil {
		return nil, err
	}
	originalTotal, err := SumMetrics(originals)
	if err != nil {
		return nil, err
	}
	correctedByDate, err := readCorrectedSubagentMetrics(
		sessionFiles, *meta, originalTotal, input.timezone, input.stderr,
		reader.Read, reader.ReadEvents,
	)
	if err != nil {
		return nil, err
	}
	adjustments := []Metric{}
	if len(correctedByDate) > 0 {
		adjustments, err = buildSessionAdjustments(originals, correctedByDate)
		if err != nil {
			return nil, err
		}
	}
	if len(correctedByDate) > 0 && len(adjustments) == 0 {
		emitStderr(input.stderr, fmt.Sprintf(
			"Skipping Codex subagent usage correction for %s/%s: corrected usage exceeds session row",
			originalTotal.UsageDate, originalTotal.Model))
	}
	return adjustments, nil
}

// buildSessionAdjustments ports buildSessionAdjustments. Each model's original
// row is first split across the dates the child used, then each date's
// corrected total is split back across the models; the adjustment is the
// difference. A date whose corrected part exceeds its original part abandons
// the whole session row (no partial correction), which is why the caller
// reports the refusal when the result is empty.
func buildSessionAdjustments(originals []Metric, correctedByDate []Metric) ([]Metric, error) {
	originalPartsByModel := make([][]Metric, len(originals))
	for index, original := range originals {
		weights := make([]Metric, len(correctedByDate))
		for dateIndex, usage := range correctedByDate {
			weight := original
			weight.UsageDate = usage.UsageDate
			weight.TotalTokens = usage.TotalTokens
			weights[dateIndex] = weight
		}
		originalPartsByModel[index] = DistributeMetric(original, weights)
	}
	adjustments := []Metric{}
	for dateIndex, correctedTotal := range correctedByDate {
		originalParts := make([]Metric, len(originalPartsByModel))
		for modelIndex := range originalPartsByModel {
			originalParts[modelIndex] = originalPartsByModel[modelIndex][dateIndex]
		}
		correctedParts := DistributeMetric(correctedTotal, originalParts)
		if !canSubtractMetrics(originalParts, correctedParts) {
			return []Metric{}, nil
		}
		for partIndex, originalPart := range originalParts {
			adjustment, err := SubtractMetric(originalPart, correctedParts[partIndex])
			if err != nil {
				return nil, err
			}
			adjustments = append(adjustments, adjustment)
		}
	}
	return adjustments, nil
}

func readCorrectedSubagentMetrics(
	sessionFiles []resolvedSessionFile,
	meta subagentMeta,
	original Metric,
	timezone string,
	stderr func(string),
	readChildUsageByDate ReadChildUsageByDate,
	readChildUsageEvents ReadChildUsageEvents,
) ([]Metric, error) {
	var usageByDate []DatedUsage
	var err error
	if len(sessionFiles) == 1 {
		usageByDate, err = readChildUsageByDate(
			sessionFiles[0].readFilePath, meta.startedAt, timezone, stderr, sessionFiles[0].sourceFilePath)
	} else {
		usageByDate, err = readCrossProfileChildUsageByDate(sessionFiles, meta.startedAt, timezone, stderr, readChildUsageEvents)
	}
	if err != nil {
		return nil, err
	}
	// last_token_usage is the provider-recorded per-request usage. If Codex
	// sent copied parent context again, that charged input remains in this
	// child total.
	if len(usageByDate) == 0 {
		return nil, nil
	}
	totalUsage := SumDatedUsage(usageByDate)
	if totalUsage.TotalTokens <= 0 || totalUsage.TotalTokens > original.TotalTokens {
		// The correction is abandoned and the session row keeps its
		// uncorrected — and therefore too high — value, because the child
		// reports more usage than the row it would be subtracted from. The
		// sibling refusal below reports its own; this branch returns before
		// buildSessionAdjustments runs, so without this line nothing
		// downstream could tell it apart from "there was nothing to correct".
		emitStderr(stderr, fmt.Sprintf(
			"Skipping Codex subagent usage correction for %s/%s: child usage %s exceeds session row %s",
			original.UsageDate, original.Model,
			formatJSNumber(totalUsage.TotalTokens), formatJSNumber(original.TotalTokens)))
		return nil, nil
	}
	metrics := make([]Metric, 0, len(usageByDate))
	for _, usage := range usageByDate {
		metrics = append(metrics, Metric{
			UsageDate:           usage.UsageDate,
			Model:               original.Model,
			InputTokens:         correctedChildInputTokens(usage),
			OutputTokens:        usage.OutputTokens,
			CacheCreationTokens: usage.CacheCreationTokens,
			CacheReadTokens:     usage.CacheReadTokens,
			TotalTokens:         usage.TotalTokens,
			CostUSD:             ProrateCost(original.CostUSD, usage.TotalTokens, original.TotalTokens),
		})
	}
	return metrics, nil
}

// correctedChildInputTokens decides whether cached input is already inside
// input_tokens. Legacy Codex records report cached input inside input_tokens,
// while newer records report it as a separate additive field. The total proves
// which representation produced this event; without that proof preserve input.
func correctedChildInputTokens(usage DatedUsage) float64 {
	cacheReadIsIncludedInInput := usage.CacheReadTokens <= usage.InputTokens &&
		usage.TotalTokens == usage.InputTokens+usage.CacheCreationTokens+usage.OutputTokens
	if !cacheReadIsIncludedInInput {
		return usage.InputTokens
	}
	value, err := subtractNonNegative(usage.InputTokens, usage.CacheReadTokens, "subagent input")
	if err != nil {
		// The TS helper throws here; the caller treats a non-negative input
		// as guaranteed by the representation check above, so an error means
		// the caller's own invariant is broken and must not be clamped.
		panic(err)
	}
	return value
}

func readCrossProfileChildUsageByDate(
	sessionFiles []resolvedSessionFile,
	timestamp string,
	timezone string,
	stderr func(string),
	readChildUsageEvents ReadChildUsageEvents,
) ([]DatedUsage, error) {
	merger := NewChildUsageEventMerger()
	for _, sessionFile := range sessionFiles {
		events, err := readChildUsageEvents(
			sessionFile.readFilePath, timestamp, timezone, stderr, sessionFile.sourceFilePath)
		if err != nil {
			return nil, err
		}
		if err := merger.Add(events); err != nil {
			return nil, err
		}
	}
	return merger.ToUsageByDate(), nil
}

// subtractAdjustment ports subtractAdjustment: refuse to subtract more than
// the snapshot holds, then validate the result exactly as the Zod parse does.
func subtractAdjustment(
	snapshot contract.Snapshot,
	adjustment Metric,
	stderr func(string),
) (contract.Snapshot, error) {
	if !canSubtractAdjustment(snapshot, adjustment) {
		emitStderr(stderr, fmt.Sprintf(
			"Skipping Codex subagent usage correction for %s/%s: corrected usage exceeds daily snapshot",
			snapshot.UsageDate, snapshot.Model))
		return snapshot, nil
	}
	label := snapshotKey(snapshot.UsageDate, snapshot.Model)
	corrected := snapshot
	var err error
	if corrected.InputTokens, err = subtractAdjustmentInt(snapshot.InputTokens, adjustment.InputTokens, label); err != nil {
		return contract.Snapshot{}, err
	}
	if corrected.OutputTokens, err = subtractAdjustmentInt(snapshot.OutputTokens, adjustment.OutputTokens, label); err != nil {
		return contract.Snapshot{}, err
	}
	if corrected.CacheCreation, err = subtractAdjustmentInt(snapshot.CacheCreation, adjustment.CacheCreationTokens, label); err != nil {
		return contract.Snapshot{}, err
	}
	if corrected.CacheRead, err = subtractAdjustmentInt(snapshot.CacheRead, adjustment.CacheReadTokens, label); err != nil {
		return contract.Snapshot{}, err
	}
	if corrected.TotalTokens, err = subtractAdjustmentInt(snapshot.TotalTokens, adjustment.TotalTokens, label); err != nil {
		return contract.Snapshot{}, err
	}
	costUsd, err := subtractNonNegative(snapshot.CostUSD, adjustment.CostUSD, label)
	if err != nil {
		return contract.Snapshot{}, err
	}
	corrected.CostUSD = costUsd
	if err := corrected.Validate(); err != nil {
		return contract.Snapshot{}, err
	}
	return corrected, nil
}

// subtractAdjustmentInt applies the shared subtraction to an integer counter
// and refuses a non-integral or out-of-range result. Every component here is a
// validated safe integer in TS; a value outside int64 cannot reach this path
// from a decoded snapshot, and failing closed is the only safe answer if it
// somehow does.
func subtractAdjustmentInt(left int64, right float64, label string) (int64, error) {
	value, err := subtractNonNegative(float64(left), right, label)
	if err != nil {
		return 0, err
	}
	if value != math.Trunc(value) || value > maxSafeInteger {
		return 0, fmt.Errorf("Codex subagent usage correction produced a non-integer value for %s", label)
	}
	return int64(value), nil
}

func canSubtractAdjustment(snapshot contract.Snapshot, adjustment Metric) bool {
	return canSubtract(float64(snapshot.InputTokens), adjustment.InputTokens) &&
		canSubtract(float64(snapshot.OutputTokens), adjustment.OutputTokens) &&
		canSubtract(float64(snapshot.CacheCreation), adjustment.CacheCreationTokens) &&
		canSubtract(float64(snapshot.CacheRead), adjustment.CacheReadTokens) &&
		canSubtract(float64(snapshot.TotalTokens), adjustment.TotalTokens) &&
		canSubtract(snapshot.CostUSD, adjustment.CostUSD)
}

func canSubtractMetrics(left []Metric, right []Metric) bool {
	for index, metric := range left {
		candidate := right[index]
		if !canSubtract(metric.InputTokens, candidate.InputTokens) ||
			!canSubtract(metric.OutputTokens, candidate.OutputTokens) ||
			!canSubtract(metric.CacheCreationTokens, candidate.CacheCreationTokens) ||
			!canSubtract(metric.CacheReadTokens, candidate.CacheReadTokens) ||
			!canSubtract(metric.TotalTokens, candidate.TotalTokens) ||
			!canSubtract(metric.CostUSD, candidate.CostUSD) {
			return false
		}
	}
	return true
}

func canSubtract(left float64, right float64) bool {
	return left-right >= -0.000001
}

func readModelMetrics(row *subagentRecord) ([]Metric, error) {
	usageDate, err := readSessionDate(row)
	if err != nil {
		return nil, err
	}
	modelRows := extractModelRows(row)
	metrics := make([]Metric, 0, len(modelRows))
	for _, modelRow := range modelRows {
		metrics = append(metrics, Metric{
			UsageDate:           usageDate,
			Model:               modelRow.model,
			InputTokens:         modelRow.metrics.readNumber([]string{"inputTokens"}),
			OutputTokens:        modelRow.metrics.readNumber([]string{"outputTokens"}),
			CacheCreationTokens: modelRow.metrics.readCacheCreationTokens(),
			CacheReadTokens:     modelRow.metrics.readCacheReadTokens(),
			TotalTokens:         modelRow.metrics.readTotalTokens(),
			CostUSD:             readCostUsd(modelRow.metrics, row),
		})
	}
	return metrics, nil
}

type subagentModelRow struct {
	model   string
	metrics *subagentRecord
}

// extractModelRows ports extractModelRows: the `models` object's entries in
// document order, else the row itself under its own model name.
func extractModelRows(row *subagentRecord) []subagentModelRow {
	if models, ok := row.Get("models"); ok {
		if record, ok := subagentRecordOf(models); ok {
			out := []subagentModelRow{}
			for _, model := range record.Keys() {
				metrics, ok := subagentRecordOf(record.values[model])
				if !ok {
					continue
				}
				out = append(out, subagentModelRow{model: model, metrics: metrics})
			}
			return out
		}
	}
	return []subagentModelRow{{model: readModel(row), metrics: row}}
}

// readSubagentMeta ports readSubagentMeta: the first session_meta row that
// carries subagent metadata supplies the child's start timestamp. Rows after
// it are not read: once the identity is known the rest of the file belongs to
// the usage read.
func readSubagentMeta(filePath string, stderr func(string)) (*subagentMeta, error) {
	var meta *subagentMeta
	readErr := ReadJSONLRecords(filePath, stderr, codexChildSessionReadLimits(), func(record UnknownRecord) error {
		if ReadString(record, []string{"type"}) != "session_meta" {
			return nil
		}
		payload := ReadRecord(record["payload"])
		startedAt := ReadString(payload, []string{"timestamp"})
		if startedAt == "" {
			startedAt = ReadString(record, []string{"timestamp"})
		}
		if startedAt == "" || !hasSubagentMetadata(payload) {
			return nil
		}
		meta = &subagentMeta{startedAt: startedAt}
		return ErrStopJSONL
	})
	if readErr != nil && !errors.Is(readErr, ErrStopJSONL) {
		return nil, readErr
	}
	return meta, nil
}

func readSubagentMetaFromFiles(
	sessionFiles []resolvedSessionFile,
	stderr func(string),
) (*subagentMeta, error) {
	for _, sessionFile := range sessionFiles {
		meta, err := readSubagentMeta(sessionFile.readFilePath, stderr)
		if err != nil {
			return nil, err
		}
		if meta != nil {
			return meta, nil
		}
	}
	return nil, nil
}

func resolveSubagentSessionFiles(
	row *subagentRecord,
	codexHomes []string,
	codexSymlinkRoots []string,
) ([]resolvedSessionFile, error) {
	files := map[string]resolvedSessionFile{}
	order := []string{}
	for _, codexHome := range codexHomes {
		file, err := resolveSubagentSessionFileInHome(row, codexHome, codexSymlinkRoots)
		if err != nil {
			return nil, err
		}
		if file == nil {
			continue
		}
		if _, seen := files[file.sourceFilePath]; !seen {
			order = append(order, file.sourceFilePath)
		}
		files[file.sourceFilePath] = *file
	}
	out := make([]resolvedSessionFile, 0, len(order))
	for _, key := range order {
		out = append(out, files[key])
	}
	return out, nil
}

func resolveSubagentSessionFileInHome(
	row *subagentRecord,
	codexHome string,
	codexSymlinkRoots []string,
) (*resolvedSessionFile, error) {
	for _, rootName := range []string{"sessions", "archived_sessions"} {
		sessionsDir := filepath.Join(codexHome, rootName)
		resolvedSessionsDir, ok, err := sessionwalk.ResolveRoot(sessionsDir, sessionwalk.Options{
			RejectRootSymlink:   true,
			AllowedRootSymlinks: codexSymlinkRoots,
			RootBoundary:        codexHome,
		})
		if err != nil {
			return nil, err
		}
		if !ok {
			continue
		}
		sessionID := row.readString([]string{"sessionId"})
		if sessionID != "" {
			file, err := existingSubagentSessionFile(sessionsDir, resolvedSessionsDir, sessionID+".jsonl")
			if err != nil {
				return nil, err
			}
			if file != nil {
				return file, nil
			}
		}
		directory := row.readString([]string{"directory"})
		sessionFile := row.readString([]string{"sessionFile"})
		if directory != "" && sessionFile != "" {
			file, err := existingSubagentSessionFile(sessionsDir, resolvedSessionsDir, directory, sessionFile+".jsonl")
			if err != nil {
				return nil, err
			}
			if file != nil {
				return file, nil
			}
		}
	}
	return nil, nil
}

func existingSubagentSessionFile(
	sourceRoot string,
	readRoot string,
	segments ...string,
) (*resolvedSessionFile, error) {
	sourceFilePath := resolveSubagentPath(sourceRoot, segments...)
	readFilePath := resolveSubagentPath(readRoot, segments...)
	if !isPathInside(sourceRoot, sourceFilePath) || !isPathInside(readRoot, readFilePath) {
		return nil, nil
	}
	inspected, err := inspectSubagentSessionFilePath(readRoot, readFilePath)
	if err != nil {
		return nil, err
	}
	if !inspected {
		return nil, nil
	}
	return &resolvedSessionFile{sourceFilePath: sourceFilePath, readFilePath: readFilePath}, nil
}

// resolveSubagentPath ports path.resolve: join and clean, without following
// symlinks (the inspection below decides what a symlink means).
func resolveSubagentPath(base string, segments ...string) string {
	parts := append([]string{base}, segments...)
	return filepath.Clean(filepath.Join(parts...))
}

// inspectSubagentSessionFilePath ports inspectSessionFilePath: every component
// of the relative path must be a real directory, and the final component a
// real file. A symlink anywhere is refused rather than followed, so a session
// row cannot redirect the read outside the sessions tree.
func inspectSubagentSessionFilePath(sessionsDir string, filePath string) (bool, error) {
	relativePath, err := filepath.Rel(sessionsDir, filePath)
	if err != nil {
		return false, nil
	}
	pathSegments := strings.Split(relativePath, string(filepath.Separator))
	currentPath := sessionsDir
	for index, segment := range pathSegments {
		details, err := inspectSubagentPathEntry(currentPath)
		if err != nil {
			return false, err
		}
		if details == nil {
			return false, nil
		}
		if details.Mode()&os.ModeSymlink != 0 {
			return false, errors.New("Unable to read Codex subagent session file: symbolic links are not supported")
		}
		if !details.IsDir() {
			return false, errors.New("Unable to read Codex subagent session file: session path is not a directory")
		}
		currentPath = filepath.Join(currentPath, segment)
		if index != len(pathSegments)-1 {
			continue
		}
		fileDetails, err := inspectSubagentPathEntry(currentPath)
		if err != nil {
			return false, err
		}
		if fileDetails == nil {
			return false, nil
		}
		if fileDetails.Mode()&os.ModeSymlink != 0 {
			return false, errors.New("Unable to read Codex subagent session file: symbolic links are not supported")
		}
		return fileDetails.Mode().IsRegular(), nil
	}
	return false, nil
}

// inspectSubagentPathEntry ports inspectPathEntry: a missing entry is nil; any
// other failure is reported with the TS wrapper.
func inspectSubagentPathEntry(path string) (os.FileInfo, error) {
	details, err := os.Lstat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("Unable to inspect Codex subagent session path: %s", errorText(err))
	}
	return details, nil
}

func hasSubagentMetadata(payload UnknownRecord) bool {
	source := ReadRecord(payload["source"])
	return ReadRecord(source["subagent"]) != nil
}

func readSessionDate(row *subagentRecord) (string, error) {
	value := row.readString([]string{"lastActivity", "date", "usageDate"})
	if value == "" {
		return "", errors.New("Codex session row is missing last activity")
	}
	return NormalizeDate(value)
}

func readModel(row *subagentRecord) string {
	model := row.readString([]string{"model", "modelName", "name"})
	if model == "" {
		return "all"
	}
	return model
}

// readCostUsd ports readCostUsd: a row's own cost wins; a model entry without
// one inherits the parent's cost prorated by its share of the parent's tokens.
func readCostUsd(row *subagentRecord, parent *subagentRecord) float64 {
	directCost := row.readFiniteNumber([]string{"costUsd", "costUSD", "cost"})
	if directCost > 0 || row == parent {
		return directCost
	}
	parentCost := parent.readFiniteNumber([]string{"costUsd", "costUSD", "cost"})
	parentTokens := parent.readTotalTokens()
	rowTokens := row.readTotalTokens()
	if parentCost <= 0 || parentTokens <= 0 || rowTokens <= 0 {
		return 0
	}
	return parentCost * (rowTokens / parentTokens)
}
