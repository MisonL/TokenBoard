// Providers report every unpriced model on every collection run, and a heavy Claude/Codex
// day repeats the same model names across dozens of syncs. A single line per provider per
// run keeps the collector stderr (which lands in daily-sync.err.log) readable without
// losing which models lacked catalogue pricing.
const unpricedPattern = /^TokenBoard model pricing unavailable for (.+?) model (.+?); preserving/

export type PricingDiagnosticSink = {
  stderr: (line: string) => void
  flush: () => void
}

export function createPricingDiagnosticSink(stderr: (line: string) => void): PricingDiagnosticSink {
  const pending = new Map<string, { models: Set<string>; single: string }>()
  return {
    stderr(line: string) {
      const match = unpricedPattern.exec(line)
      if (!match) {
        stderr(line)
        return
      }
      const bucket = pending.get(match[1]) ?? { models: new Set<string>(), single: line }
      bucket.models.add(match[2])
      pending.set(match[1], bucket)
    },
    flush() {
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
