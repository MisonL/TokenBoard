// Providers report every unpriced model on every collection run, and a heavy Claude/Codex
// day repeats the same model names across dozens of syncs. A single line per provider per
// run keeps the collector stderr (which lands in daily-sync.err.log) readable without
// losing which models lacked catalogue pricing.
//
// The oversized-row summaries get the same treatment for a different reason: a full Codex
// scan emits one summary per child scan that hit an oversized row, so a single run printed
// ten near-identical lines (13, 7, 1, 13, 13, 3, 3, 3, 3, 6 rows). They already aggregate
// across files within one scan; folding them across scans finishes the job.
const unpricedPattern = /^TokenBoard model pricing unavailable for (.+?) model (.+?); preserving/

// Two families, kept apart: a child session row and a context pricing row are different
// conditions with different follow-up, so summing them together would misreport both.
//
// Each family has two shapes. A single scan reports rows and largest size; a caller that
// already aggregated several scans adds "across N scans" before the largest clause. Both
// arrive at this sink — 2839 of the former and 636 of the latter in one week of this
// machine's log — and both must fold, or the run keeps printing ten lines for one
// condition.
const oversizedRowPatterns: Record<string, RegExp> = {
  'child session':
    /^Skipped ([1-9][0-9]*) oversized Codex child session JSONL rows? without usage or subagent metadata (?:across ([1-9][0-9]*) scans? )?\(largest ([1-9][0-9]*) bytes\)$/,
  'context pricing':
    /^Skipped ([1-9][0-9]*) oversized Codex context pricing JSONL rows? without usage or subagent metadata (?:across ([1-9][0-9]*) scans? )?\(largest ([1-9][0-9]*) bytes\)$/
}

// A full scan warms one attribution per session, and many sessions change
// between the frozen copy and the cache write. The message names a normal
// skip, not a failure, and the per-session detail adds nothing a count does
// not: one week of this machine's log held 525 of them across 69 runs.
const staleAttributionMessage =
  'Skipping stale Codex canonical attribution cache write for a session that changed after copy'

export type PricingDiagnosticSink = {
  stderr: (line: string) => void
  flush: () => void
}

export function createPricingDiagnosticSink(stderr: (line: string) => void): PricingDiagnosticSink {
  const pending = new Map<string, { models: Set<string>; single: string }>()
  const oversized = new Map<string, { rows: number; scans: number; largestBytes: number }>()
  let staleAttributions = 0
  return {
    stderr(line: string) {
      if (line === staleAttributionMessage) {
        staleAttributions += 1
        return
      }
      const match = unpricedPattern.exec(line)
      if (!match) {
        const oversizedMatch = matchOversizedFamily(line)
        if (oversizedMatch) {
          const summary = oversized.get(oversizedMatch.family) ?? { rows: 0, scans: 0, largestBytes: 0 }
          summary.rows += oversizedMatch.rows
          summary.scans += oversizedMatch.scans
          summary.largestBytes = Math.max(summary.largestBytes, oversizedMatch.largestBytes)
          oversized.set(oversizedMatch.family, summary)
          return
        }
        stderr(line)
        return
      }
      const bucket = pending.get(match[1]) ?? { models: new Set<string>(), single: line }
      bucket.models.add(match[2])
      pending.set(match[1], bucket)
    },
    flush() {
      if (staleAttributions === 1) {
        stderr(staleAttributionMessage)
      } else if (staleAttributions > 1) {
        stderr(
          `Skipped stale Codex canonical attribution cache writes for ${staleAttributions} sessions that changed after copy`
        )
      }
      for (const [family, summary] of oversized) {
        const rowLabel = summary.rows === 1 ? 'row' : 'rows'
        const scanLabel = summary.scans === 1 ? 'scan' : 'scans'
        stderr(
          `Skipped ${summary.rows} oversized Codex ${family} JSONL ${rowLabel} across ${summary.scans} ${scanLabel} ` +
            `without usage or subagent metadata (largest ${summary.largestBytes} bytes)`
        )
      }
      for (const [, bucket] of pending) {
        if (bucket.models.size === 1) {
          stderr(bucket.single)
          continue
        }
        const kind = unpricedPattern.exec(bucket.single)?.[1] ?? 'collector'
        const listed = [...bucket.models].slice(0, 20).join(', ')
        stderr(
          `TokenBoard model pricing unavailable for ${bucket.models.size} ${kind} models; preserving collected results: ` +
            `${listed}${bucket.models.size > 20 ? ', …' : ''}`
        )
      }
    }
  }
}

function matchOversizedFamily(
  line: string
): { family: string; rows: number; scans: number; largestBytes: number } | null {
  for (const [family, pattern] of Object.entries(oversizedRowPatterns)) {
    const match = pattern.exec(line)
    if (match) {
      // No "across N scans" clause means the line describes exactly one scan.
      return { family, rows: Number(match[1]), scans: match[2] ? Number(match[2]) : 1, largestBytes: Number(match[3]) }
    }
  }
  return null
}
