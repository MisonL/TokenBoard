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

type unpricedBucket struct {
	models map[string]bool
	order  []string
	single string
}

// pricingDiagnosticSink is an io.Writer that swallows the per-model unpriced
// lines and re-emits them aggregated on Flush. Every other line passes
// through immediately, the way the TS sink does.
type pricingDiagnosticSink struct {
	out     io.Writer
	mu      sync.Mutex
	partial string
	pending map[string]*unpricedBucket
	kinds   []string
}

func newPricingDiagnosticSink(out io.Writer) *pricingDiagnosticSink {
	return &pricingDiagnosticSink{out: out, pending: map[string]*unpricedBucket{}}
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
	match := unpricedPattern.FindStringSubmatch(line)
	if match == nil {
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
}
