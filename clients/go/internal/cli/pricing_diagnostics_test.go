package cli

import (
	"bytes"
	"strings"
	"testing"
)

// Port of pricing-diagnostics: the per-model unpriced lines collapse to one
// line per provider per run, so daily-sync.err.log stays readable.

func TestPricingDiagnosticsPassThroughUnrelatedLines(t *testing.T) {
	var out bytes.Buffer
	sink := newPricingDiagnosticSink(&out)
	sink.Write([]byte("first line\nsecond line\n"))
	sink.Flush()
	if out.String() != "first line\nsecond line\n" {
		t.Errorf("out = %q", out.String())
	}
}

func TestPricingDiagnosticsKeepASingleUnpricedLineVerbatim(t *testing.T) {
	var out bytes.Buffer
	sink := newPricingDiagnosticSink(&out)
	line := "TokenBoard model pricing unavailable for Claude Code model claude-x; preserving ccusage result"
	sink.Write([]byte(line + "\n"))
	sink.Flush()
	if out.String() != line+"\n" {
		t.Errorf("out = %q", out.String())
	}
}

func TestPricingDiagnosticsAggregateMultipleModelsPerKind(t *testing.T) {
	var out bytes.Buffer
	sink := newPricingDiagnosticSink(&out)
	sink.Write([]byte(
		"TokenBoard model pricing unavailable for Claude Code model a; preserving x\n" +
			"TokenBoard model pricing unavailable for Claude Code model b; preserving x\n" +
			"TokenBoard model pricing unavailable for Codex model c; preserving y\n"))
	sink.Flush()
	got := out.String()
	if !strings.Contains(got, "TokenBoard model pricing unavailable for 2 Claude Code models; preserving collected results: a, b\n") {
		t.Errorf("missing aggregated Claude line: %q", got)
	}
	if strings.Contains(got, "Codex models") {
		t.Errorf("a single Codex model must keep its original line: %q", got)
	}
	if !strings.Contains(got, "TokenBoard model pricing unavailable for Codex model c; preserving y\n") {
		t.Errorf("missing Codex verbatim line: %q", got)
	}
}

func TestPricingDiagnosticsDeduplicateRepeatedModels(t *testing.T) {
	var out bytes.Buffer
	sink := newPricingDiagnosticSink(&out)
	for i := 0; i < 3; i++ {
		sink.Write([]byte("TokenBoard model pricing unavailable for Claude Code model a; preserving x\n"))
	}
	sink.Write([]byte("TokenBoard model pricing unavailable for Claude Code model b; preserving x\n"))
	sink.Flush()
	got := out.String()
	if !strings.Contains(got, "for 2 Claude Code models") {
		t.Errorf("repeated models must not inflate the count: %q", got)
	}
	if !strings.HasSuffix(got, "collected results: a, b\n") {
		t.Errorf("models listed once each, in order: %q", got)
	}
}

func TestPricingDiagnosticsCapTheListAtTwentyModels(t *testing.T) {
	var out bytes.Buffer
	sink := newPricingDiagnosticSink(&out)
	for _, model := range []string{
		"m01", "m02", "m03", "m04", "m05", "m06", "m07", "m08", "m09", "m10",
		"m11", "m12", "m13", "m14", "m15", "m16", "m17", "m18", "m19", "m20", "m21",
	} {
		sink.Write([]byte("TokenBoard model pricing unavailable for Codex model " + model + "; preserving y\n"))
	}
	sink.Flush()
	got := out.String()
	if !strings.Contains(got, "for 21 Codex models") {
		t.Errorf("count = %q", got)
	}
	if strings.Contains(got, "m21") {
		t.Errorf("the 21st model must be elided: %q", got)
	}
	if !strings.Contains(got, "m20, …") {
		t.Errorf("missing ellipsis suffix: %q", got)
	}
}

// A chunk boundary must not lose or duplicate a line: the sink buffers the
// unterminated tail between writes.
func TestPricingDiagnosticsHandlePartialLineWrites(t *testing.T) {
	var out bytes.Buffer
	sink := newPricingDiagnosticSink(&out)
	sink.Write([]byte("TokenBoard model pricing unavailable for Claude Code model a; preser"))
	sink.Write([]byte("ving x\nnext\n"))
	sink.Flush()
	got := out.String()
	if !strings.Contains(got, "next\n") {
		t.Errorf("unterminated line lost: %q", got)
	}
	if !strings.Contains(got, "model a; preserving x\n") {
		t.Errorf("split line not reassembled: %q", got)
	}
}

// An unterminated final line still reaches stderr on Flush.
func TestPricingDiagnosticsFlushEmitsTheUnterminatedTail(t *testing.T) {
	var out bytes.Buffer
	sink := newPricingDiagnosticSink(&out)
	sink.Write([]byte("TokenBoard model pricing unavailable for Codex model z; preserving y"))
	sink.Flush()
	if out.String() != "TokenBoard model pricing unavailable for Codex model z; preserving y\n" {
		t.Errorf("out = %q", out.String())
	}
}

// A full Codex scan reports one oversized-row summary per child scan that hit
// one; one run printed ten near-identical lines. The TS sink folds them, and
// the Go side has to fold them the same way or the log noise returns the
// moment a machine moves to the binary client.
func TestPricingDiagnosticsFoldOversizedRowSummaries(t *testing.T) {
	var out bytes.Buffer
	sink := newPricingDiagnosticSink(&out)
	for _, line := range []string{
		"Skipped 13 oversized Codex child session JSONL rows without usage or subagent metadata (largest 4055723 bytes)",
		"Skipped 7 oversized Codex child session JSONL rows without usage or subagent metadata (largest 2605115 bytes)",
		"Skipped 1 oversized Codex child session JSONL row without usage or subagent metadata (largest 3042255 bytes)",
	} {
		sink.Write([]byte(line + "\n"))
	}
	sink.Flush()
	want := "Skipped 21 oversized Codex child session JSONL rows across 3 scans without usage or subagent metadata (largest 4055723 bytes)\n"
	if out.String() != want {
		t.Errorf("out = %q, want %q", out.String(), want)
	}
}

// A caller that already aggregated several scans prints the "across N scans"
// shape; both shapes arrive at the sink and fold into the same running total.
func TestPricingDiagnosticsFoldAlreadyAggregatedOversizedRows(t *testing.T) {
	var out bytes.Buffer
	sink := newPricingDiagnosticSink(&out)
	for _, line := range []string{
		"Skipped 4 oversized Codex child session JSONL rows without usage or subagent metadata across 4 scans (largest 1154359 bytes)",
		"Skipped 2 oversized Codex child session JSONL rows without usage or subagent metadata (largest 300 bytes)",
	} {
		sink.Write([]byte(line + "\n"))
	}
	sink.Flush()
	want := "Skipped 6 oversized Codex child session JSONL rows across 5 scans without usage or subagent metadata (largest 1154359 bytes)\n"
	if out.String() != want {
		t.Errorf("out = %q, want %q", out.String(), want)
	}
}

// Child session rows and context pricing rows are different conditions with
// different follow-up; folding them together would misreport both.
func TestPricingDiagnosticsKeepOversizedFamiliesApart(t *testing.T) {
	var out bytes.Buffer
	sink := newPricingDiagnosticSink(&out)
	sink.Write([]byte("Skipped 2 oversized Codex context pricing JSONL rows without usage or subagent metadata (largest 900 bytes)\n"))
	sink.Write([]byte("Skipped 1 oversized Codex child session JSONL row without usage or subagent metadata (largest 300 bytes)\n"))
	sink.Write([]byte("Skipped 3 oversized Codex context pricing JSONL rows without usage or subagent metadata (largest 1200 bytes)\n"))
	sink.Flush()
	got := out.String()
	if !strings.Contains(got, "Skipped 5 oversized Codex context pricing JSONL rows across 2 scans") {
		t.Errorf("context pricing summary = %q", got)
	}
	if !strings.Contains(got, "Skipped 1 oversized Codex child session JSONL row across 1 scan") {
		t.Errorf("child session summary = %q", got)
	}
}

// A full scan warms one attribution per session, and many sessions change
// between the frozen copy and the cache write. The message names a normal
// skip, not a failure; one week of this machine's log held 525 of them.
func TestPricingDiagnosticsFoldStaleAttributionSkips(t *testing.T) {
	var out bytes.Buffer
	sink := newPricingDiagnosticSink(&out)
	for index := 0; index < 3; index++ {
		sink.Write([]byte("Skipping stale Codex canonical attribution cache write for a session that changed after copy\n"))
	}
	sink.Flush()
	want := "Skipped stale Codex canonical attribution cache writes for 3 sessions that changed after copy\n"
	if out.String() != want {
		t.Errorf("out = %q, want %q", out.String(), want)
	}
}

func TestPricingDiagnosticsKeepASingleStaleAttributionSkip(t *testing.T) {
	var out bytes.Buffer
	sink := newPricingDiagnosticSink(&out)
	sink.Write([]byte("Skipping stale Codex canonical attribution cache write for a session that changed after copy\n"))
	sink.Flush()
	want := "Skipping stale Codex canonical attribution cache write for a session that changed after copy\n"
	if out.String() != want {
		t.Errorf("out = %q, want %q", out.String(), want)
	}
}
