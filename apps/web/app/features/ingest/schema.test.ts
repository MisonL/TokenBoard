import { describe, expect, test } from 'vitest'
import { maxUploadIsoDate, type UsageSnapshot } from '@tokenboard/usage-core'
import { ingestRequestSchema, snapshotCheckRequestSchema } from './schema'

const legacyCollectorBatchSize = 500

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

describe('ingest schemas', () => {
  test('accepts empty snapshot batches for sync acknowledgements', () => {
    expect(ingestRequestSchema.parse({ snapshots: [] })).toEqual({ snapshots: [] })
  })

  test('rejects cache reads that exceed provider total tokens', () => {
    expect(() =>
      ingestRequestSchema.parse({
        snapshots: [
          {
            ...baseSnapshot,
            cacheReadTokens: baseSnapshot.totalTokens + 1
          }
        ]
      })
    ).toThrow('cacheReadTokens must not exceed totalTokens')
  })

  test('rejects Antigravity source costs', () => {
    for (const source of ['antigravity-cli', 'antigravity', 'antigravity-ide'] as const) {
      expect(() =>
        ingestRequestSchema.parse({
          snapshots: [
            {
              ...baseSnapshot,
              source,
              costUsd: 0.01
            }
          ]
        })
      ).toThrow('Antigravity source costs are unavailable')
    }
  })

  test('accepts legacy collector snapshot batches', () => {
    const snapshots = Array.from({ length: legacyCollectorBatchSize }, (_, index) => ({
      ...baseSnapshot,
      model: `gpt-5-${index}`
    }))

    expect(ingestRequestSchema.parse({ snapshots })).toEqual({ snapshots })
  })

  test('rejects snapshot batches that exceed legacy collector compatibility', () => {
    const snapshots = Array.from({ length: legacyCollectorBatchSize + 1 }, (_, index) => ({
      ...baseSnapshot,
      model: `gpt-5-${index}`
    }))

    expect(() => ingestRequestSchema.parse({ snapshots })).toThrow()
  })

  test('validates snapshot hash check keys', () => {
    expect(
      snapshotCheckRequestSchema.parse({
        keys: [
          {
            source: 'codex',
            usageDate: '2026-05-09',
            model: 'gpt-5'
          }
        ]
      })
    ).toEqual({
      keys: [
        {
          source: 'codex',
          usageDate: '2026-05-09',
          model: 'gpt-5'
        }
      ]
    })
  })

  test('caps snapshot hash checks to the upload batch size', () => {
    const keys = Array.from({ length: legacyCollectorBatchSize + 1 }, (_, index) => ({
      source: 'codex',
      usageDate: '2026-05-09',
      model: `gpt-5-${index}`
    }))

    expect(() => snapshotCheckRequestSchema.parse({ keys })).toThrow()
  })

  test('accepts legacy collector snapshot hash checks', () => {
    const keys = Array.from({ length: legacyCollectorBatchSize }, (_, index) => ({
      source: 'codex',
      usageDate: '2026-05-09',
      model: `gpt-5-${index}`
    }))

    expect(snapshotCheckRequestSchema.parse({ keys })).toEqual({ keys })
  })

  test('rejects oversized model names in snapshot hash checks', () => {
    expect(() =>
      snapshotCheckRequestSchema.parse({
        keys: [
          {
            source: 'codex',
            usageDate: '2026-05-09',
            model: 'g'.repeat(161)
          }
        ]
      })
    ).toThrow()
  })

  test('rejects impossible calendar dates in snapshot hash checks', () => {
    expect(() =>
      snapshotCheckRequestSchema.parse({
        keys: [
          {
            source: 'codex',
            usageDate: '2026-02-30',
            model: 'gpt-5'
          }
        ]
      })
    ).toThrow('Invalid ISO date')
  })

  // A usage date is a calendar day a collector observed. Nothing real sits beyond today plus
  // the UTC+14 headroom, and without a ceiling a clock-skewed or hostile client can write rows
  // no dashboard, leaderboard, or report will ever surface — rows that only a human with D1
  // access could remove.
  test('rejects usage dates beyond tomorrow on both ingest entry points', () => {
    expect(() =>
      ingestRequestSchema.parse({
        snapshots: [{ ...baseSnapshot, usageDate: '2099-01-01' }]
      })
    ).toThrow('usageDate too far in the future')

    expect(() =>
      snapshotCheckRequestSchema.parse({
        keys: [{ source: 'codex', usageDate: '2099-01-01', model: 'gpt-5' }]
      })
    ).toThrow('usageDate too far in the future')
  })

  test('accepts a usage date at the ceiling for the current clock', () => {
    const tomorrow = maxUploadIsoDate(new Date())

    expect(() => ingestRequestSchema.parse({ snapshots: [{ ...baseSnapshot, usageDate: tomorrow }] })).not.toThrow()
    expect(() =>
      snapshotCheckRequestSchema.parse({ keys: [{ source: 'codex', usageDate: tomorrow, model: 'gpt-5' }] })
    ).not.toThrow()
  })

  // The mirror of the future ceiling: a date before any AI coding tool existed is just as
  // unreachable for every display window, and a clock-skewed or hostile client could write
  // it just as easily. It is rejected on both ingest entry points with its own message.
  test('rejects usage dates before the supported history window on both ingest entry points', () => {
    expect(() =>
      ingestRequestSchema.parse({
        snapshots: [{ ...baseSnapshot, usageDate: '0000-01-01' }]
      })
    ).toThrow('usageDate before the supported history window')

    expect(() =>
      snapshotCheckRequestSchema.parse({
        keys: [{ source: 'codex', usageDate: '2022-12-31', model: 'gpt-5' }]
      })
    ).toThrow('usageDate before the supported history window')
  })

  // A malformed date is rejected by `usageSnapshotSchema.usageDate` itself. The request-level
  // window check must not re-report it: two identical issues at one path are harmless in the
  // response (the API collapses a ZodError to a generic 400) but they read as two independent
  // problems, and the base check already covers the case.
  test('reports a malformed usage date once, not once per check', () => {
    const result = ingestRequestSchema.safeParse({
      snapshots: [{ ...baseSnapshot, usageDate: '2026-13-45' }]
    })

    expect(result.success).toBe(false)
    const dateIssues = result.error?.issues.filter((issue) => issue.path.join('.') === 'snapshots.0.usageDate')
    expect(dateIssues).toHaveLength(1)
    expect(dateIssues?.[0]?.message).toBe('Invalid ISO date')
  })
})
