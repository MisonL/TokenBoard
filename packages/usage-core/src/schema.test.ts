import { describe, expect, test } from 'vitest'
import { usageSnapshotSchema, usageSourceSchema, type UsageSnapshot } from './schema'

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
  test('accepts Antigravity CLI source', () => {
    expect(usageSourceSchema.parse('antigravity-cli')).toBe('antigravity-cli')
    expect(usageSnapshotSchema.parse({
      ...baseSnapshot,
      source: 'antigravity-cli'
    }).source).toBe('antigravity-cli')
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
