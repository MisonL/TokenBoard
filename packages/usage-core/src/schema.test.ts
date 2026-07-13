import { describe, expect, test, vi } from 'vitest'
import { isValidTimezone, usageSnapshotSchema, usageSourceSchema, type UsageSnapshot } from './schema'

const baseSnapshot: UsageSnapshot = {
  source: 'codex',
  usageDate: '2026-05-09',
  timezone: 'Asia/Shanghai',
  model: 'gpt-5',
  inputTokens: 10,
  outputTokens: 2,
  cacheCreationTokens: 0,
  cacheReadTokens: 5,
  totalTokens: 17,
  costUsd: 0.01,
  sessionCount: 1,
  collectedAt: '2026-05-09T10:00:00.000Z'
}

describe('usage snapshot schema', () => {
  test('accepts Antigravity sources', () => {
    for (const source of ['antigravity-cli', 'antigravity', 'antigravity-ide'] as const) {
      expect(usageSourceSchema.parse(source)).toBe(source)
      expect(usageSnapshotSchema.parse({
        ...baseSnapshot,
        source,
        costUsd: 0
      }).source).toBe(source)
    }
  })

  test('rejects Antigravity source costs', () => {
    for (const source of ['antigravity-cli', 'antigravity', 'antigravity-ide'] as const) {
      expect(() =>
        usageSnapshotSchema.parse({
          ...baseSnapshot,
          source,
          costUsd: 0.01
        })
      ).toThrow('Antigravity source costs are unavailable')
    }
  })

  test('rejects unknown sources', () => {
    expect(() => usageSourceSchema.parse('agy')).toThrow()
  })

  test('rejects invalid IANA timezones', () => {
    expect(() =>
      usageSnapshotSchema.parse({
        ...baseSnapshot,
        timezone: 'Mars/Base'
      })
    ).toThrow()
  })

  test('does not retain attacker-controlled invalid timezone keys', () => {
    const formatter = Intl.DateTimeFormat
    const constructor = vi.spyOn(Intl, 'DateTimeFormat')
      .mockImplementation(function (...args) { return new formatter(...args) })

    expect(isValidTimezone('Invalid/NegativeCacheProbe')).toBe(false)
    expect(isValidTimezone('Invalid/NegativeCacheProbe')).toBe(false)
    expect(constructor).toHaveBeenCalledTimes(2)

    constructor.mockRestore()
  })

  test('rejects oversized timezone and model fields', () => {
    expect(() =>
      usageSnapshotSchema.parse({
        ...baseSnapshot,
        timezone: 'A'.repeat(81)
      })
    ).toThrow()

    expect(() =>
      usageSnapshotSchema.parse({
        ...baseSnapshot,
        model: 'g'.repeat(161)
      })
    ).toThrow()
  })
})
