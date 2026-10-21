package cli

import (
	"io"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

// Port of pricing-diagnostics.ts: providers report every unpriced model on
// every run, and a heavy Claude/Codex day repeats the same model names across
// dozens of syncs. A single line per provider per run keeps the collector
// stderr (which lands in daily-sync.err.log) readable without losing which
// models lacked catalogue pricing.

var unpricedPattern = regexp.MustCompile(`^TokenBoard model pricing unavailable for (.+?) model (.+?); preserving`)

// The oversized-row summaries fold for a different reason than the unpriced
// models: a full Codex scan emits one summary per child scan that hit an
// oversized row, so one run printed ten near-identical lines (13, 7, 1, 13,
// 13, 3, 3, 3, 3, 6 rows). Each summary already aggregates across files
// within one scan; folding across scans finishes the job.
//
// Each family has two shapes. A single scan reports rows and largest size; a
// caller that already aggregated several scans adds "across N scans" before
// the largest clause. Both arrive here and fold into the same total. The two
// families stay apart: a child session row and a context pricing row are
// different conditions with different follow-up.
var oversizedRowPatterns = []struct {
	family  string
	pattern *regexp.Regexp
}{
	{
		"child session",
		regexp.MustCompile(`^Skipped ([1-9][0-9]*) oversized Codex child session JSONL rows? without usage or subagent metadata (?:across ([1-9][0-9]*) scans? )?\(largest ([1-9][0-9]*) bytes\)$`),
	},
	{
		"context pricing",
		regexp.MustCompile(`^Skipped ([1-9][0-9]*) oversized Codex context pricing JSONL rows? without usage or subagent metadata (?:across ([1-9][0-9]*) scans? )?\(largest ([1-9][0-9]*) bytes\)$`),
	},
}

// A full scan warms one attribution per session, and many sessions change
// between the frozen copy and the cache write. The message names a normal
// skip, not a failure, and the per-session detail adds nothing a count does
// not: one week of this machine's log held 525 of them across 69 runs.
const staleAttributionMessage = "Skipping stale Codex canonical attribution cache write for a session that changed after copy"

type oversizedBucket struct {
	rows         int
	scans        int
	largestBytes int
}

// matchOversizedFamily reports which family a summary line belongs to and
// what it aggregates. A line without the "across N scans" clause describes
// exactly one scan.
func matchOversizedFamily(line string) (string, *oversizedBucket, bool) {
	for _, candidate := range oversizedRowPatterns {
		match := candidate.pattern.FindStringSubmatch(line)
		if match == nil {
			continue
		}
		rows, _ := strconv.Atoi(match[1])
		scans := 1
		if match[2] != "" {
			scans, _ = strconv.Atoi(match[2])
		}
		largest, _ := strconv.Atoi(match[3])
		return candidate.family, &oversizedBucket{rows: rows, scans: scans, largestBytes: largest}, true
	}
	return "", nil, false
}

type unpricedBucket struct {
	models map[string]bool
	order  []string
	single string
}

// pricingDiagnosticSink is an io.Writer that swallows the per-model unpriced
// lines and re-emits them aggregated on Flush. Every other line passes
// through immediately, the way the TS sink does.
type pricingDiagnosticSink struct {
	out               io.Writer
	mu                sync.Mutex
	partial           string
	pending           map[string]*unpricedBucket
	kinds             []string
	oversized         map[string]*oversizedBucket
	families          []string
	staleAttributions int
}

func newPricingDiagnosticSink(out io.Writer) *pricingDiagnosticSink {
	return &pricingDiagnosticSink{out: out, pending: map[string]*unpricedBucket{}, oversized: map[string]*oversizedBucket{}}
}

func (s *pricingDiagnosticSink) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	text := s.partial + string(p)
	lines := strings.Split(text, "\n")
	s.partial = lines[len(lines)-1]
	for _, line := range lines[:len(lines)-1] {
		s.emit(line)
	}
	return len(p), nil
}

func (s *pricingDiagnosticSink) emit(line string) {
	if line == staleAttributionMessage {
		s.staleAttributions++
		return
	}
	match := unpricedPattern.FindStringSubmatch(line)
	if match == nil {
		if family, summary, ok := matchOversizedFamily(line); ok {
			bucket, seen := s.oversized[family]
			if !seen {
				bucket = &oversizedBucket{}
				s.oversized[family] = bucket
				s.families = append(s.families, family)
			}
			bucket.rows += summary.rows
			bucket.scans += summary.scans
			if summary.largestBytes > bucket.largestBytes {
				bucket.largestBytes = summary.largestBytes
			}
			return
		}
		_, _ = io.WriteString(s.out, line+"\n")
		return
	}
	kind, model := match[1], match[2]
	bucket, ok := s.pending[kind]
	if !ok {
		bucket = &unpricedBucket{models: map[string]bool{}, single: line}
		s.pending[kind] = bucket
		s.kinds = append(s.kinds, kind)
	}
	if !bucket.models[model] {
		bucket.models[model] = true
		bucket.order = append(bucket.order, model)
	}
}

// Flush writes the buffered unpriced lines: one line when a provider had a
// single unpriced model, otherwise a summary capped at 20 model names.
func (s *pricingDiagnosticSink) Flush() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.partial != "" {
		s.emit(s.partial)
		s.partial = ""
	}
	if s.staleAttributions == 1 {
		_, _ = io.WriteString(s.out, staleAttributionMessage+"\n")
	} else if s.staleAttributions > 1 {
		_, _ = io.WriteString(s.out, "Skipped stale Codex canonical attribution cache writes for "+
			strconv.Itoa(s.staleAttributions)+" sessions that changed after copy\n")
	}
	for _, family := range s.families {
		bucket := s.oversized[family]
		rowLabel := "rows"
		if bucket.rows == 1 {
			rowLabel = "row"
		}
		scanLabel := "scans"
		if bucket.scans == 1 {
			scanLabel = "scan"
		}
		_, _ = io.WriteString(s.out, "Skipped "+strconv.Itoa(bucket.rows)+" oversized Codex "+family+
			" JSONL "+rowLabel+" across "+strconv.Itoa(bucket.scans)+" "+scanLabel+
			" without usage or subagent metadata (largest "+strconv.Itoa(bucket.largestBytes)+" bytes)\n")
	}
	for _, kind := range s.kinds {
		bucket := s.pending[kind]
		if len(bucket.models) == 1 {
			_, _ = io.WriteString(s.out, bucket.single+"\n")
			continue
		}
		listed := bucket.order
		suffix := ""
		if len(listed) > 20 {
			listed = listed[:20]
			suffix = ", …"
		}
		_, _ = io.WriteString(s.out, "TokenBoard model pricing unavailable for "+
			strconv.Itoa(len(bucket.models))+" "+kind+" models; preserving collected results: "+
			strings.Join(listed, ", ")+suffix+"\n")
	}
	s.pending = map[string]*unpricedBucket{}
	s.kinds = nil
	s.oversized = map[string]*oversizedBucket{}
	s.families = nil
	s.staleAttributions = 0
}
