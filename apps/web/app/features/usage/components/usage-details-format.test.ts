import { describe, expect, test } from 'vitest'
import { formatInteger, formatPercent } from './usage-details-format'

describe('usage details format', () => {
  test('groups integers for readability', () => {
    expect(formatInteger(1234567)).toBe('1,234,567')
    expect(formatInteger(0)).toBe('0')
  })

  // A source listed in the split did put tokens on the board, so a contribution that rounds to
  // zero has to read as `1%` rather than `0%`. The leaderboard's source split uses the same
  // floor, and the two surfaces disagreeing on the same word was the bug this pins.
  test('floors a nonzero share at one percent', () => {
    expect(formatPercent(0.4, 100)).toBe('1%')
    expect(formatPercent(1, 1000)).toBe('1%')
    expect(formatPercent(5, 100)).toBe('5%')
    expect(formatPercent(50, 100)).toBe('50%')
  })

  test('reports a genuine zero share as zero', () => {
    expect(formatPercent(0, 100)).toBe('0%')
    expect(formatPercent(5, 0)).toBe('0%')
    expect(formatPercent(5, -1)).toBe('0%')
  })

  // `Math.round` alone would report 101% for a value that exceeded its total; the leaderboard
  // split does not clamp either, and the two share this contract.
  test('rounds half up without clamping an over-full share', () => {
    expect(formatPercent(99.5, 100)).toBe('100%')
    expect(formatPercent(100.6, 100)).toBe('101%')
  })
})
