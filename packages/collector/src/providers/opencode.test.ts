import { describe, expect, test } from 'vitest'
import { collectOpenCodeUsage } from './opencode'

const dbPath = '/home/user/.local/share/opencode/opencode.db'
const statFile = async () => ({ mtimeMs: 1_700_000_000_000 })

// Field names and value shapes below were taken from a real opencode.db.
function usageRow(overrides: Record<string, unknown> = {}) {
  return {
    model: 'deepseek-v4-pro',
    createdMs: 1_779_755_333_700,
    inputTokens: 3272,
    outputTokens: 383,
    reasoningTokens: 419,
    cacheReadTokens: 52_480,
    cacheWriteTokens: 0,
    costUsd: 0.0023113,
    sessionId: 'ses_05c01faf7ffe6zgGkvn1d44SbX',
    ...overrides
  }
}

function collect(rows: Record<string, unknown>[], options: Record<string, unknown> = {}) {
  return collectOpenCodeUsage({
    dbPath,
    statFile,
    timezone: 'Asia/Shanghai',
    collectedAt: '2026-05-09T10:00:00.000Z',
    since: 'all',
    runQuery: async () => JSON.stringify(rows),
    ...options
  })
}

describe('collectOpenCodeUsage', () => {
  test('normalizes a message row into a daily snapshot', async () => {
    const snapshots = await collect([usageRow()])

    expect(snapshots).toEqual([{
      source: 'opencode',
      usageDate: '2026-05-26',
      timezone: 'Asia/Shanghai',
      model: 'deepseek-v4-pro',
      inputTokens: 3272,
      // 383 output + 419 reasoning: reasoning is billed as output, not a bucket.
      outputTokens: 802,
      cacheCreationTokens: 0,
      cacheReadTokens: 52_480,
      totalTokens: 56_554,
      costUsd: 0.0023113,
      sessionCount: 1,
      collectedAt: '2026-05-09T10:00:00.000Z'
    }])
  })

  test('keeps input fresh so totals stay disjoint', async () => {
    const [snapshot] = await collect([usageRow({
      inputTokens: 1000,
      outputTokens: 200,
      reasoningTokens: 0,
      cacheReadTokens: 5000,
      cacheWriteTokens: 300
    })])

    expect(snapshot.inputTokens).toBe(1000)
    expect(snapshot.totalTokens).toBe(6500)
    expect(snapshot.cacheReadTokens).toBeLessThanOrEqual(snapshot.totalTokens)
  })

  test('aggregates rows by date and model, counting distinct sessions', async () => {
    const snapshots = await collect([
      usageRow({ sessionId: 'ses_a' }),
      usageRow({ sessionId: 'ses_b', inputTokens: 1000, outputTokens: 10, reasoningTokens: 0, cacheReadTokens: 0 }),
      usageRow({ sessionId: 'ses_a', model: 'other-model', cacheReadTokens: 0 })
    ])

    expect(snapshots).toHaveLength(2)
    const primary = snapshots.find((item) => item.model === 'deepseek-v4-pro')
    expect(primary?.inputTokens).toBe(4272)
    expect(primary?.sessionCount).toBe(2)
    expect(snapshots.find((item) => item.model === 'other-model')?.sessionCount).toBe(1)
  })

  test('splits usage across local dates using the configured timezone', async () => {
    // 2026-05-27T17:30:00Z is still 2026-05-27 in UTC but already 2026-05-28 in Shanghai.
    const createdMs = Date.parse('2026-05-27T17:30:00.000Z')

    const shanghai = await collect([usageRow({ createdMs })])
    expect(shanghai[0].usageDate).toBe('2026-05-28')

    const utc = await collect([usageRow({ createdMs })], { timezone: 'UTC' })
    expect(utc[0].usageDate).toBe('2026-05-27')
  })

  test('skips rows without usable token metadata', async () => {
    const skipped: string[] = []
    const snapshots = await collect([
      usageRow({ inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
      usageRow({ createdMs: null }),
      usageRow({ createdMs: 0 })
    ], { stderr: (line: string) => skipped.push(line) })

    expect(snapshots).toEqual([])
    expect(skipped).toHaveLength(1)
    expect(skipped[0]).toContain('Skipped 3 OpenCode message rows')
  })

  test('falls back to a placeholder model and bounds long model ids', async () => {
    const [missing] = await collect([usageRow({ model: null })])
    expect(missing.model).toBe('unknown')

    const [blank] = await collect([usageRow({ model: '   ' })])
    expect(blank.model).toBe('unknown')

    const [long] = await collect([usageRow({ model: 'm'.repeat(400) })])
    expect(long.model).toHaveLength(160)
  })

  test('treats negative counts and costs as zero', async () => {
    const [snapshot] = await collect([usageRow({
      inputTokens: -5,
      cacheWriteTokens: -1,
      costUsd: -2
    })])

    expect(snapshot.inputTokens).toBe(0)
    expect(snapshot.cacheCreationTokens).toBe(0)
    expect(snapshot.costUsd).toBe(0)
  })

  test('applies the since window on local dates', async () => {
    const rows = [
      usageRow({ createdMs: Date.parse('2026-05-20T02:00:00.000Z') }),
      usageRow({ createdMs: Date.parse('2026-05-27T02:00:00.000Z') })
    ]

    expect(await collect(rows, { since: '2026-05-25' })).toHaveLength(1)
    expect(await collect(rows, { since: '20260525' })).toHaveLength(1)
    expect(await collect(rows, { since: 'all' })).toHaveLength(2)
    await expect(collect(rows, { since: 'last-week' })).rejects.toThrow('Invalid OpenCode since value')
  })

  test('reports a missing database instead of returning empty usage', async () => {
    await expect(collectOpenCodeUsage({
      dbPath,
      statFile: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) },
      runQuery: async () => '[]'
    })).rejects.toThrow(`OpenCode database not found: ${dbPath}`)
  })

  test('treats an empty result as no usage', async () => {
    expect(await collect([])).toEqual([])
    expect(await collectOpenCodeUsage({
      dbPath, statFile, since: 'all', runQuery: async () => '  '
    })).toEqual([])
  })

  test('never selects the message blob that holds prompts and local paths', async () => {
    let executedSql = ''
    await collect([], { runQuery: async (_db: string, sql: string) => { executedSql = sql; return '[]' } })

    expect(executedSql).toContain('json_extract(m.data')
    expect(executedSql).not.toMatch(/SELECT[\s\S]*\bm\.data\b(?!,?\s*'\$)/)
    for (const field of ['$.path', '$.content', '$.parentID', '$.agent']) {
      expect(executedSql).not.toContain(field)
    }
  })

  test('reads the WAL sidecar so checkpoint-lagging writes are seen', async () => {
    const statted: string[] = []
    await collect([], {
      statFile: async (path: string) => {
        statted.push(path)
        if (path.endsWith('-shm')) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        return { mtimeMs: 1 }
      }
    })

    expect(statted).toContain(dbPath)
    expect(statted).toContain(`${dbPath}-wal`)
  })
})
