import { describe, expect, test } from 'vitest'
import { createPricingDiagnosticSink } from './pricing-diagnostics'

// The sink exists because a heavy Codex day repeats the same diagnostics
// dozens of times per run, and the collector stderr lands in a long-lived
// log. Each test below names one message family it folds.

describe('createPricingDiagnosticSink', () => {
  test('passes every unrecognized line through unchanged', () => {
    const lines: string[] = []
    const sink = createPricingDiagnosticSink((line) => lines.push(line))
    sink.stderr('TokenBoard model pricing: using cached catalogue (100 models)')
    sink.stderr('Skipping unavailable pi source: No Pi sessions found: /x')
    sink.flush()
    expect(lines).toEqual([
      'TokenBoard model pricing: using cached catalogue (100 models)',
      'Skipping unavailable pi source: No Pi sessions found: /x'
    ])
  })

  test('folds repeated unpriced-model lines per provider into one', () => {
    const lines: string[] = []
    const sink = createPricingDiagnosticSink((line) => lines.push(line))
    sink.stderr('TokenBoard model pricing unavailable for Claude Code model a; preserving x')
    sink.stderr('TokenBoard model pricing unavailable for Claude Code model b; preserving y')
    sink.flush()
    expect(lines).toEqual([
      'TokenBoard model pricing unavailable for 2 Claude Code models; preserving collected results: a, b'
    ])
  })

  test('keeps a single unpriced model on its original line', () => {
    const lines: string[] = []
    const sink = createPricingDiagnosticSink((line) => lines.push(line))
    sink.stderr('TokenBoard model pricing unavailable for Codex model gpt-x; preserving y')
    sink.flush()
    expect(lines).toEqual(['TokenBoard model pricing unavailable for Codex model gpt-x; preserving y'])
  })

  // A full Codex scan reports one oversized-row summary per child scan that
  // hit one: the same run printed 13, 7, 1, 13, 13, 3, 3, 3, 3 and 6 in a row.
  // Ten lines for one condition bury the lines that need action.
  test('folds oversized Codex row summaries into one line per run', () => {
    const lines: string[] = []
    const sink = createPricingDiagnosticSink((line) => lines.push(line))
    sink.stderr(
      'Skipped 13 oversized Codex child session JSONL rows without usage or subagent metadata (largest 4055723 bytes)'
    )
    sink.stderr(
      'Skipped 7 oversized Codex child session JSONL rows without usage or subagent metadata (largest 2605115 bytes)'
    )
    sink.stderr(
      'Skipped 1 oversized Codex child session JSONL row without usage or subagent metadata (largest 3042255 bytes)'
    )
    sink.flush()
    expect(lines).toEqual([
      'Skipped 21 oversized Codex child session JSONL rows across 3 scans without usage or subagent metadata (largest 4055723 bytes)'
    ])
  })

  test('folds context pricing oversized rows separately from child session rows', () => {
    const lines: string[] = []
    const sink = createPricingDiagnosticSink((line) => lines.push(line))
    sink.stderr(
      'Skipped 2 oversized Codex context pricing JSONL rows without usage or subagent metadata (largest 900 bytes)'
    )
    sink.stderr(
      'Skipped 1 oversized Codex child session JSONL row without usage or subagent metadata (largest 300 bytes)'
    )
    sink.stderr(
      'Skipped 3 oversized Codex context pricing JSONL rows without usage or subagent metadata (largest 1200 bytes)'
    )
    sink.flush()
    expect(lines.sort()).toEqual([
      'Skipped 1 oversized Codex child session JSONL row across 1 scan without usage or subagent metadata (largest 300 bytes)',
      'Skipped 5 oversized Codex context pricing JSONL rows across 2 scans without usage or subagent metadata (largest 1200 bytes)'
    ])
  })

  // A caller that already aggregated several scans prints the "across N scans" shape;
  // one week of this machine's log held 636 of them next to 2839 single-scan lines.
  // Both shapes must fold into the same running summary, adding their scan counts.
  test('folds the already-aggregated across-N-scans shape too', () => {
    const lines: string[] = []
    const sink = createPricingDiagnosticSink((line) => lines.push(line))
    sink.stderr(
      'Skipped 4 oversized Codex child session JSONL rows without usage or subagent metadata across 4 scans (largest 1154359 bytes)'
    )
    sink.stderr(
      'Skipped 2 oversized Codex child session JSONL rows without usage or subagent metadata (largest 300 bytes)'
    )
    sink.flush()
    expect(lines).toEqual([
      'Skipped 6 oversized Codex child session JSONL rows across 5 scans without usage or subagent metadata (largest 1154359 bytes)'
    ])
  })

  // A full scan warms one attribution per session; many sessions changed
  // between the frozen copy and the cache write, so one run printed 7.6 of
  // these on average. The message names a normal skip, not a failure, and the
  // per-session detail adds nothing the count does not.
  test('folds repeated stale canonical attribution skips into one line', () => {
    const lines: string[] = []
    const sink = createPricingDiagnosticSink((line) => lines.push(line))
    for (let index = 0; index < 3; index += 1) {
      sink.stderr('Skipping stale Codex canonical attribution cache write for a session that changed after copy')
    }
    sink.flush()
    expect(lines).toEqual([
      'Skipped stale Codex canonical attribution cache writes for 3 sessions that changed after copy'
    ])
  })

  test('keeps a single stale canonical attribution skip on its original line', () => {
    const lines: string[] = []
    const sink = createPricingDiagnosticSink((line) => lines.push(line))
    sink.stderr('Skipping stale Codex canonical attribution cache write for a session that changed after copy')
    sink.flush()
    expect(lines).toEqual([
      'Skipping stale Codex canonical attribution cache write for a session that changed after copy'
    ])
  })

  test('does not fold a summary that names no rows', () => {
    const lines: string[] = []
    const sink = createPricingDiagnosticSink((line) => lines.push(line))
    // The pattern is anchored and rejects a zero count; such a line is not a
    // report this sink knows how to merge and must survive verbatim.
    sink.stderr(
      'Skipped 0 oversized Codex child session JSONL rows without usage or subagent metadata (largest 0 bytes)'
    )
    sink.flush()
    expect(lines).toEqual([
      'Skipped 0 oversized Codex child session JSONL rows without usage or subagent metadata (largest 0 bytes)'
    ])
  })
})
