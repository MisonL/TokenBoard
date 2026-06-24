import { describe, expect, test } from 'vitest'
import { formatCostWithAvailability, formatSource, formatSourceCostNote, hasUnavailableCostSource } from './source-format'

describe('source-format', () => {
  test('formats all Antigravity sources', () => {
    expect(formatSource('antigravity-cli')).toBe('Antigravity CLI (agy)')
    expect(formatSource('antigravity')).toBe('Antigravity')
    expect(formatSource('antigravity-ide')).toBe('Antigravity IDE')
  })

  test('marks all Antigravity sources as cost unavailable', () => {
    const sourceSplit = [
      { source: 'codex' },
      { source: 'antigravity-ide' }
    ]

    expect(hasUnavailableCostSource(sourceSplit)).toBe(true)
    expect(formatCostWithAvailability(0.42, sourceSplit)).toBe('$0.42 (Antigravity IDE 费用不可用)')
    expect(formatSourceCostNote('antigravity')).toBe('Antigravity 费用不可用')
    expect(formatSourceCostNote('antigravity-cli')).toBe('Antigravity CLI 费用不可用')
    expect(formatCostWithAvailability(0.42, [
      { source: 'antigravity-cli' },
      { source: 'antigravity-ide' }
    ])).toBe('$0.42 (Antigravity 费用不可用)')
  })
})
