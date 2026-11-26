import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { UsageSnapshot } from '@tokenboard/usage-core'
import { runCollectorCli } from './cli'
import {
  deliveredWatermarkFileName,
  loadDeliveredWatermark,
  recordDeliveredWatermark,
  tokenFingerprint
} from './delivered-watermark'
import {
  uploadBlockedSymbol,
  uploadDeliveredSymbol,
  uploadRejectedSymbol,
  type BlockedUploadSnapshot,
  type RejectedUploadSnapshot
} from './upload'

const endpoint = 'https://tb.example'
const uploadToken = 'tb_test_token'
const timeZone = 'Asia/Shanghai'
// The injected seven-day default the skill wrapper would have produced.
const injectedSince = '20261119'

type TestDeps = NonNullable<Parameters<typeof runCollectorCli>[2]>

function snapshot(source: UsageSnapshot['source'], usageDate: string): UsageSnapshot {
  return {
    source,
    usageDate,
    timezone: timeZone,
    model: 'test-model',
    inputTokens: 1,
    outputTokens: 2,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 3,
    costUsd: 0.01,
    sessionCount: 1,
    collectedAt: `${usageDate}T10:00:00.000Z`
  }
}

// Both core collectors are required on CliDeps; the unused one fails loudly
// instead of silently reporting an empty source as collected.
function testDeps(overrides: Partial<TestDeps> = {}): TestDeps {
  const unused = async (name: string): Promise<never> => {
    throw new Error(`${name} must not be collected in this test`)
  }
  return {
    stdout: () => undefined,
    stderr: () => undefined,
    collectClaudeCodeUsage: async () => unused('claude-code'),
    collectCodexUsage: async () => unused('codex'),
    collectCcusageToolUsage: async () => [],
    uploadSnapshots: async () => uploadResult({ delivered: [] }),
    ...overrides
  }
}

function uploadResult(input: {
  delivered: UsageSnapshot[]
  rejected?: RejectedUploadSnapshot[]
  blocked?: BlockedUploadSnapshot[]
}) {
  const payload: Record<string, unknown> = { upserted: input.delivered.length, skipped: 0 }
  const attach = (symbol: symbol, value: unknown) =>
    Object.defineProperty(payload, symbol, { value, enumerable: false, configurable: true })
  attach(uploadDeliveredSymbol, input.delivered)
  attach(uploadRejectedSymbol, input.rejected ?? [])
  attach(uploadBlockedSymbol, input.blocked ?? [])
  return payload
}

function todayInTimeZone(): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })
  const values: Record<string, string> = {}
  for (const part of formatter.formatToParts(new Date())) {
    if (part.type !== 'literal') values[part.type] = part.value
  }
  return `${values.year}-${values.month}-${values.day}`
}

function shiftDays(date: string, days: number): string {
  const value = new Date(0)
  value.setUTCHours(0, 0, 0, 0)
  value.setUTCFullYear(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)) + days)
  const year = String(value.getUTCFullYear()).padStart(4, '0')
  const month = String(value.getUTCMonth() + 1).padStart(2, '0')
  const day = String(value.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

let stateDir: string

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'cli-watermark-'))
})

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true })
})

async function seedWatermark(source: string, usageDate: string, hash = tokenFingerprint(uploadToken)) {
  await recordDeliveredWatermark({
    stateDir,
    endpoint,
    tokenHash: hash,
    advances: { [source]: usageDate },
    now: new Date(),
    timeZone
  })
}

function baseEnv(extra: Record<string, string> = {}) {
  return {
    TOKENBOARD_TIMEZONE: timeZone,
    TOKENBOARD_STATE_DIR: stateDir,
    TOKENBOARD_SINCE: injectedSince,
    // The watermark is scoped by endpoint and token; preview does not need them,
    // but the lookup does.
    TOKENBOARD_ENDPOINT: endpoint,
    TOKENBOARD_UPLOAD_TOKEN: uploadToken,
    ...extra
  }
}

function claudeCollector(seen: string[]): TestDeps['collectClaudeCodeUsage'] {
  return async (context) => {
    seen.push(context?.since ?? '')
    return []
  }
}

describe('automatic since from the delivered watermark', () => {
  test('stays off without TOKENBOARD_SINCE_AUTO', async () => {
    const today = todayInTimeZone()
    await seedWatermark('claude-code', shiftDays(today, -20))
    const seen: string[] = []
    const result = await runCollectorCli(
      ['preview', '--source', 'claude-code'],
      baseEnv(),
      testDeps({ collectClaudeCodeUsage: claudeCollector(seen) })
    )
    expect(result).toBe(0)
    expect(seen).toEqual([injectedSince])
  })

  test('widens to the watermark when the skill asks for it', async () => {
    const today = todayInTimeZone()
    const watermarkDate = shiftDays(today, -9)
    await seedWatermark('claude-code', watermarkDate)
    const seen: string[] = []
    const result = await runCollectorCli(
      ['preview', '--source', 'claude-code'],
      baseEnv({ TOKENBOARD_SINCE_AUTO: '1' }),
      testDeps({ collectClaudeCodeUsage: claudeCollector(seen) })
    )
    expect(result).toBe(0)
    // watermark-1, which is inside the [today-30, today-7] band for a 9-day-old watermark.
    expect(seen).toEqual([shiftDays(watermarkDate, -1)])
  })

  test('keeps the default without a watermark', async () => {
    const seen: string[] = []
    const result = await runCollectorCli(
      ['preview', '--source', 'claude-code'],
      baseEnv({ TOKENBOARD_SINCE_AUTO: '1' }),
      testDeps({ collectClaudeCodeUsage: claudeCollector(seen) })
    )
    expect(result).toBe(0)
    expect(seen).toEqual([injectedSince])
  })

  test('ignores hook runs', async () => {
    const today = todayInTimeZone()
    await seedWatermark('claude-code', shiftDays(today, -20))
    const seen: string[] = []
    const result = await runCollectorCli(
      ['sync', '--source', 'claude-code'],
      baseEnv({ TOKENBOARD_SINCE_AUTO: '1', TOKENBOARD_HOOK_MODE: '1' }),
      testDeps({ collectClaudeCodeUsage: claudeCollector(seen) })
    )
    expect(result).toBe(0)
    expect(seen).toEqual([injectedSince])
  })
})

describe('recording delivered watermarks', () => {
  test('records the latest date the run delivered or permanently rejected', async () => {
    const result = await runCollectorCli(
      ['sync', '--source', 'claude-code'],
      baseEnv(),
      testDeps({
        collectClaudeCodeUsage: async () => [snapshot('claude-code', '2026-11-24')],
        uploadSnapshots: async () =>
          uploadResult({
            delivered: [snapshot('claude-code', '2026-11-24'), snapshot('claude-code', '2026-11-20')],
            // Permanently unuploadable: counts as delivered for the watermark.
            rejected: [{ snapshot: snapshot('claude-code', '2026-11-22'), issue: 'before-history-window' }]
          })
      })
    )
    expect(result).toBe(0)
    const entries = await loadDeliveredWatermark(stateDir)
    expect(entries['claude-code'].usageDate).toBe('2026-11-24')
    expect(entries['claude-code'].endpoint).toBe(endpoint)
    expect(entries['claude-code'].tokenHash).toBe(tokenFingerprint(uploadToken))
  })

  test('drops a date for a source the run did not collect', async () => {
    const result = await runCollectorCli(
      ['sync', '--source', 'claude-code'],
      baseEnv(),
      testDeps({
        collectClaudeCodeUsage: async () => [snapshot('claude-code', '2026-11-24')],
        // The uploader should never return a row the run did not collect; if it
        // does, the watermark must not claim that source was delivered.
        uploadSnapshots: async () =>
          uploadResult({
            delivered: [snapshot('claude-code', '2026-11-24'), snapshot('codex', '2026-11-22')]
          })
      })
    )
    expect(result).toBe(0)
    const entries = await loadDeliveredWatermark(stateDir)
    expect(entries['claude-code'].usageDate).toBe('2026-11-24')
    expect(entries.codex).toBeUndefined()
  })

  test('does not record dates for a source with pending rows', async () => {
    const today = todayInTimeZone()
    const result = await runCollectorCli(
      ['sync', '--source', 'claude-code'],
      baseEnv(),
      testDeps({
        collectClaudeCodeUsage: async () => [snapshot('claude-code', shiftDays(today, -1))],
        // A blocked row still has an undelivered date; advancing past it would
        // lose that date for good.
        uploadSnapshots: async () =>
          uploadResult({
            delivered: [snapshot('claude-code', shiftDays(today, -1))],
            blocked: [{ snapshot: snapshot('claude-code', shiftDays(today, -2)), code: 'invalid-value' }]
          })
      })
    )
    expect(result).toBe(0)
    const entries = await loadDeliveredWatermark(stateDir)
    expect(entries['claude-code']).toBeUndefined()
  })

  test('withholds a source whose rows were dropped as too far in the future', async () => {
    const today = todayInTimeZone()
    const result = await runCollectorCli(
      ['sync', '--source', 'codex'],
      baseEnv(),
      testDeps({
        collectCodexUsage: async () => [snapshot('codex', shiftDays(today, -1))],
        uploadSnapshots: async () =>
          uploadResult({
            delivered: [snapshot('codex', shiftDays(today, -1))],
            rejected: [{ snapshot: snapshot('codex', shiftDays(today, 3)), issue: 'too-far-future' }]
          })
      })
    )
    expect(result).toBe(0)
    expect(await loadDeliveredWatermark(stateDir)).toEqual({})
  })

  test('a preview never writes the watermark', async () => {
    const result = await runCollectorCli(
      ['preview', '--source', 'claude-code'],
      baseEnv(),
      testDeps({
        collectClaudeCodeUsage: async () => [snapshot('claude-code', '2026-11-24')],
        uploadSnapshots: async () => {
          throw new Error('preview must not upload')
        }
      })
    )
    expect(result).toBe(0)
    await expect(stat(join(stateDir, deliveredWatermarkFileName))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('a failed upload never writes the watermark', async () => {
    const result = await runCollectorCli(
      ['sync', '--source', 'claude-code'],
      baseEnv(),
      testDeps({
        collectClaudeCodeUsage: async () => [snapshot('claude-code', '2026-11-24')],
        uploadSnapshots: async () => {
          throw new Error('request failed with status 500')
        }
      })
    )
    expect(result).not.toBe(0)
    await expect(stat(join(stateDir, deliveredWatermarkFileName))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
