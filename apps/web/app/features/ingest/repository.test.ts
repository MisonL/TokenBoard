import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { createSqliteD1, runSql } from '../../test/sqlite-d1'
import {
  backfillUsageSummaryCache,
  findExistingSnapshotHashes,
  markIngestSynced,
  upsertUsageSnapshots,
  type IngestRecord
} from './repository'

function makeRecord(overrides: Partial<IngestRecord> = {}): IngestRecord {
  return {
    userId: 'seed-user',
    deviceId: 'dev_123',
    source: 'claude-code',
    usageDate: '2026-04-28',
    timezone: 'Asia/Shanghai',
    model: 'claude-sonnet-4-5',
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationTokens: 10,
    cacheReadTokens: 5,
    totalTokens: 165,
    costUsd: 0.12,
    sessionCount: 2,
    collectedAt: '2026-04-28T07:00:00.000Z',
    ...overrides
  }
}

describe('upsertUsageSnapshots', () => {
  test('upserts daily usage rows with the device-level aggregate primary key', async () => {
    const bindings: unknown[][] = []
    const sqlStatements: string[] = []
    const batches: unknown[][] = []
    let runCount = 0
    let statementIndex = 0
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              sql,
              values,
              statementIndex: statementIndex++,
              async run() {
                runCount += 1
                return { success: true }
              },
              async all() {
                // The totals-delta path probes which users already have a totals row; this
                // fixture reports one, so the batch takes the UPDATE path.
                if (sql.includes('FROM user_usage_totals')) return { results: [{ userId: 'seed-user' }] }
                return { results: [] }
              }
            }
          }
        }
      },
      async batch(statements: unknown[]) {
        batches.push(statements)
        return statements.map(() => ({ success: true }))
      }
    } as unknown as D1Database

    const result = await upsertUsageSnapshots(db, [makeRecord(), makeRecord({ model: 'claude-opus-4-5' })])

    expect(result).toEqual({ upserted: 2 })
    expect(sqlStatements[0]).toContain('INSERT INTO daily_usage')
    expect(sqlStatements[0]).toContain('ON CONFLICT(user_id, device_id, source, usage_date, model) DO UPDATE SET')
    expect(sqlStatements[0]).toContain('daily_usage.snapshot_hash IS NULL')
    expect(sqlStatements[0]).toContain('OR daily_usage.snapshot_hash <> excluded.snapshot_hash')
    expect(sqlStatements[0]).toContain("excluded.source = 'codex'")
    expect(sqlStatements[0]).toContain('daily_usage.total_tokens > 0')
    expect(runCount).toBe(0)
    // batch 0: the two usage upserts. batch 1: one totals-delta UPDATE for the two summary keys
    // sharing the user, then one summary upsert per key. No full totals refresh, because the
    // user's totals row already exists.
    expect(batches).toHaveLength(2)
    expect(batches[0]).toHaveLength(2)
    expect(batches[1]).toHaveLength(3)
    expect((batches[1][0] as { sql: string }).sql.includes('UPDATE user_usage_totals')).toBe(true)
    expect(sqlStatements.some((sql) => sql.includes('INSERT INTO daily_usage_summary'))).toBe(true)
    expect(sqlStatements.some((sql) => sql.includes('INSERT INTO user_usage_totals'))).toBe(false)
    const upsertBindings = bindings.filter((values) => values.length === 22)
    expect(upsertBindings.map((values) => values[5]).sort()).toEqual(['claude-opus-4-5', 'claude-sonnet-4-5'])
    expect(upsertBindings.find((values) => values[5] === 'claude-sonnet-4-5')).toEqual([
      'seed-user',
      'dev_123',
      'claude-code',
      '2026-04-28',
      'Asia/Shanghai',
      'claude-sonnet-4-5',
      100,
      50,
      10,
      5,
      165,
      0.12,
      2,
      expect.stringMatching(/^[a-f0-9]{64}$/),
      '2026-04-28T07:00:00.000Z',
      0,
      0,
      0,
      0,
      0,
      0,
      0
    ])
  })

  test('keeps each ingest phase inside D1 batch limits', async () => {
    const batches: unknown[][] = []
    let statementIndex = 0
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              sql,
              values,
              statementIndex: statementIndex++,
              async all() {
                if (sql.includes('FROM user_usage_totals')) return { results: [{ userId: 'seed-user' }] }
                return { results: [] }
              }
            }
          }
        }
      },
      async batch(statements: unknown[]) {
        batches.push(statements)
        return statements.map(() => ({ success: true }))
      }
    } as unknown as D1Database

    const records = Array.from({ length: 501 }, (_, index) =>
      makeRecord({
        model: `claude-sonnet-4-5-${index}`,
        totalTokens: 165 + index
      })
    )

    const result = await upsertUsageSnapshots(db, records)

    // 17 usage batches (30 records each, 21 models in the last), then one derived batch per
    // usage batch: 30 changed keys -> 2 totals-delta statements (15 keys each) + 30 summary
    // upserts (no full refresh: the user's totals row exists). Every batch stays under the
    // 100-statement ceiling, and each key's delta and its summary upsert share one batch —
    // runStatementBatches splits above 100 into separate transactions, and they must never
    // straddle such a split.
    expect(result).toEqual({ upserted: 501 })
    expect(batches).toHaveLength(34)
    expect(batches.every((batch) => batch.length <= 100)).toBe(true)
    // Usage and derived batches alternate: 16 full cycles of [30, 32], then [21,23] for the
    // final 21 records (21 summary upserts + 2 delta statements of 15 + 6 keys).
    expect(batches.map((batch) => batch.length)).toEqual([
      30, 32, 30, 32, 30, 32, 30, 32, 30, 32, 30, 32, 30, 32, 30, 32, 30, 32, 30, 32, 30, 32, 30, 32, 30, 32, 30, 32,
      30, 32, 30, 32, 21, 23
    ])
  })

  test('throws when D1 reports a failed ingest batch statement', async () => {
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              sql,
              values,
              async all() {
                if (sql.includes('FROM user_usage_totals')) return { results: [{ userId: 'seed-user' }] }
                return { results: [] }
              }
            }
          }
        }
      },
      async batch(statements: unknown[]) {
        return statements.map((_, index) => ({
          success: index !== 1,
          error: index === 1 ? 'constraint failed' : undefined
        }))
      }
    } as unknown as D1Database

    await expect(upsertUsageSnapshots(db, [makeRecord()])).rejects.toThrow(
      'D1 batch statement 2 failed: constraint failed'
    )
  })

  test('refreshes deduped summary rows once per changed logical usage key', async () => {
    const bindings: unknown[][] = []
    const sqlStatements: string[] = []
    const batches: unknown[][] = []
    let statementIndex = 0
    const statements: Array<{ sql: string; values: unknown[] }> = []
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            statements.push({ sql, values })
            return {
              sql,
              values,
              statementIndex: statementIndex++,
              async all() {
                if (sql.includes('FROM user_usage_totals')) return { results: [{ userId: 'seed-user' }] }
                return { results: [] }
              }
            }
          }
        }
      },
      async batch(statements2: unknown[]) {
        batches.push(statements2)
        return statements2.map(() => ({ success: true }))
      }
    } as unknown as D1Database

    await upsertUsageSnapshots(db, [
      makeRecord({ deviceId: 'dev_1' }),
      makeRecord({ deviceId: 'dev_2' }),
      makeRecord({ usageDate: '2026-04-29' })
    ])

    // The two devices collapse into one logical key, so the batch refreshes two summary rows.
    // Summary binds are four key columns + four join columns + the batch timestamp; the
    // totals-delta statement binds four key columns per key + the same batch timestamp, so it
    // carries eight binds for two keys. The delta runs before the summary upserts that
    // overwrite the rows it reads, and every statement in the batch shares one timestamp.
    const summaryBindings = bindings.filter((values) => values.length === 9)
    const deltaBindings = statements
      .filter((entry) => entry.sql.includes('UPDATE user_usage_totals'))
      .map((entry) => entry.values)
    expect(summaryBindings).toContainEqual([
      'seed-user',
      '2026-04-28',
      'claude-code',
      'claude-sonnet-4-5',
      'seed-user',
      '2026-04-28',
      'claude-code',
      'claude-sonnet-4-5',
      expect.any(String)
    ])
    expect(summaryBindings).toContainEqual([
      'seed-user',
      '2026-04-29',
      'claude-code',
      'claude-sonnet-4-5',
      'seed-user',
      '2026-04-29',
      'claude-code',
      'claude-sonnet-4-5',
      expect.any(String)
    ])
    const stamp = summaryBindings[0][8]
    expect(summaryBindings.every((values) => values[8] === stamp)).toBe(true)
    // One delta statement for the two changed keys (far under the 15-key chunk split).
    expect(deltaBindings).toHaveLength(1)
    expect(deltaBindings[0]).toEqual([
      'seed-user',
      '2026-04-28',
      'claude-code',
      'claude-sonnet-4-5',
      'seed-user',
      '2026-04-29',
      'claude-code',
      'claude-sonnet-4-5',
      stamp
    ])
    // No full totals refresh: the user already has a totals row, so the delta path is enough.
    expect(sqlStatements.some((sql) => sql.includes('INSERT INTO user_usage_totals'))).toBe(false)
    const deltaSql = sqlStatements.find((sql) => sql.includes('UPDATE user_usage_totals')) ?? ''
    expect(deltaSql).toContain('WITH newkeys(user_id, usage_date, source, model) AS')
    expect(deltaSql).toContain('totals_refresh_allowed')
    expect(deltaSql).toContain('daily_usage_summary')
    expect(batches).toHaveLength(2)
    expect(batches[0]).toHaveLength(3)
    expect(batches[1]).toHaveLength(3)
  })

  test('skips summary and total refreshes for unchanged snapshot upserts', async () => {
    const batches: unknown[][] = []
    const sqlStatements: string[] = []
    let statementIndex = 0
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind(...values: unknown[]) {
            return {
              sql,
              values,
              statementIndex: statementIndex++,
              async all() {
                return { results: [] }
              }
            }
          }
        }
      },
      async batch(statements: unknown[]) {
        batches.push(statements)
        return statements.map((statement) => ({
          success: true,
          meta: { changes: (statement as { sql: string }).sql.includes('INSERT INTO daily_usage') ? 0 : 1 }
        }))
      }
    } as unknown as D1Database

    const result = await upsertUsageSnapshots(db, [makeRecord(), makeRecord({ model: 'claude-opus-4-5' })])

    expect(result).toEqual({ upserted: 0 })
    // The unchanged rows still get the summary freshness check (a lost summary row must be
    // repaired on the next retry), but with no key needing a refresh there is no derived batch
    // at all — and the old per-request totals reconciliation query is gone with it.
    expect(sqlStatements.some((sql) => sql.includes('expected_summary'))).toBe(true)
    expect(sqlStatements.some((sql) => sql.includes('expected_totals'))).toBe(false)
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(2)
    expect(
      batches[0].every((statement) => (statement as { sql: string }).sql.includes('INSERT INTO daily_usage'))
    ).toBe(true)
  })

  test('repairs missing summary and totals after an unchanged retry', async () => {
    const bindings: unknown[][] = []
    const sqlStatements: string[] = []
    const batches: unknown[][] = []
    let statementIndex = 0
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              sql,
              values,
              statementIndex: statementIndex++,
              async all() {
                if (sql.includes('expected_summary')) {
                  return {
                    results: [
                      {
                        userId: 'seed-user',
                        usageDate: '2026-04-28',
                        source: 'claude-code',
                        model: 'claude-sonnet-4-5'
                      }
                    ]
                  }
                }
                return { results: [] }
              }
            }
          }
        }
      },
      async batch(statements: unknown[]) {
        batches.push(statements)
        return statements.map((statement) => ({
          success: true,
          meta: { changes: (statement as { sql: string }).sql.includes('INSERT INTO daily_usage') ? 0 : 1 }
        }))
      }
    } as unknown as D1Database

    const result = await upsertUsageSnapshots(db, [makeRecord()])

    expect(result).toEqual({ upserted: 0 })
    expect(sqlStatements.some((sql) => sql.includes('expected_summary'))).toBe(true)
    expect(sqlStatements.some((sql) => sql.includes('expected_totals'))).toBe(false)
    expect(sqlStatements.filter((sql) => sql.includes('INSERT INTO daily_usage_summary'))).toHaveLength(1)
    expect(sqlStatements.filter((sql) => sql.includes('INSERT INTO user_usage_totals'))).toHaveLength(1)
    expect(bindings.some((values) => values.length === 9)).toBe(true)
    expect(
      bindings.some((values) => values.length === 3 && values[0] === 'seed-user' && values[2] === 'seed-user')
    ).toBe(true)
    expect(batches).toHaveLength(2)
    expect(batches[0]).toHaveLength(1)
    expect(batches[1]).toHaveLength(2)
  })

  test('an unchanged retry with current summaries writes no aggregate statements at all', async () => {
    // The pre-B2 behaviour here was a full per-request totals reconciliation scan (and, on the
    // check endpoint, a per-user summary scan) that re-derived totals on every retry. With the
    // incremental path plus the daily self-heal pass, a fully-cached retry touches no aggregate.
    const sqlStatements: string[] = []
    const batches: unknown[][] = []
    let statementIndex = 0
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind(...values: unknown[]) {
            return {
              sql,
              values,
              statementIndex: statementIndex++,
              async all() {
                return { results: [] }
              }
            }
          }
        }
      },
      async batch(statements: unknown[]) {
        batches.push(statements)
        return statements.map((statement) => ({
          success: true,
          meta: { changes: (statement as { sql: string }).sql.includes('INSERT INTO daily_usage') ? 0 : 1 }
        }))
      }
    } as unknown as D1Database

    const result = await upsertUsageSnapshots(db, [makeRecord()])

    expect(result).toEqual({ upserted: 0 })
    expect(batches).toHaveLength(1)
    expect(sqlStatements.some((sql) => sql.includes('INSERT INTO user_usage_totals'))).toBe(false)
    expect(sqlStatements.some((sql) => sql.includes('UPDATE user_usage_totals'))).toBe(false)
    expect(sqlStatements.some((sql) => sql.includes('INSERT INTO daily_usage_summary'))).toBe(false)
  })

  test('marks the upload token and device as synced after ingest', async () => {
    const bindings: unknown[][] = []
    const sqlStatements: string[] = []
    const batches: unknown[][] = []
    let runCount = 0
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async run() {
                runCount += 1
                return { success: true }
              }
            }
          }
        }
      },
      async batch(statements: unknown[]) {
        batches.push(statements)
        return statements.map(() => ({ success: true }))
      }
    } as unknown as D1Database

    await markIngestSynced(db, {
      uploadTokenHash: 'hash:upload-token',
      deviceId: 'dev_123',
      installationId: 'inst_123',
      syncedAt: '2026-04-28T08:00:00.000Z'
    })

    expect(sqlStatements[0]).toContain('UPDATE upload_tokens')
    expect(sqlStatements[0]).toContain('last_used_at = ?')
    expect(sqlStatements[0]).toContain('julianday(last_used_at) <= julianday(?)')
    expect(bindings[0]).toEqual(['2026-04-28T08:00:00.000Z', 'hash:upload-token', '2026-04-28T08:00:00.000Z'])
    expect(sqlStatements[1]).toContain('UPDATE devices')
    expect(sqlStatements[1]).toContain('last_synced_at = ?')
    expect(sqlStatements[1]).toContain('julianday(last_synced_at) <= julianday(?)')
    expect(bindings[1]).toEqual([
      '2026-04-28T08:00:00.000Z',
      '2026-04-28T08:00:00.000Z',
      'dev_123',
      '2026-04-28T08:00:00.000Z',
      'hash:upload-token'
    ])
    expect(sqlStatements[2]).toContain('UPDATE device_installations')
    expect(sqlStatements[2]).toContain('last_seen_at = ?')
    expect(sqlStatements[2]).toContain('julianday(last_seen_at) <= julianday(?)')
    expect(bindings[2]).toEqual([
      '2026-04-28T08:00:00.000Z',
      '2026-04-28T08:00:00.000Z',
      'inst_123',
      '2026-04-28T08:00:00.000Z',
      'hash:upload-token'
    ])
    expect(runCount).toBe(0)
    expect(batches).toEqual([[expect.any(Object), expect.any(Object), expect.any(Object)]])
  })

  test('updates sync timestamps only when the incoming time is newer', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-ingest-sync-'))
    const dbPath = join(tempDir, 'sync.db')

    try {
      runSql(
        dbPath,
        `
          CREATE TABLE users (id TEXT PRIMARY KEY);
          CREATE TABLE upload_tokens (
            token_hash TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            last_used_at TEXT
          );
          CREATE TABLE devices (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            last_synced_at TEXT,
            updated_at TEXT
          );
          CREATE TABLE device_installations (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            last_seen_at TEXT,
            updated_at TEXT
          );
          INSERT INTO users (id) VALUES ('user_1');
          INSERT INTO upload_tokens (token_hash, user_id, last_used_at)
          VALUES ('token_hash', 'user_1', '2026-04-28T10:00:00.000Z');
          INSERT INTO devices (id, user_id, last_synced_at, updated_at)
          VALUES ('device_1', 'user_1', '2026-04-28T10:00:00.000Z', '2026-04-28T10:00:00.000Z');
          INSERT INTO devices (id, user_id, last_synced_at, updated_at)
          VALUES ('device_other', 'user_2', '2026-04-28T10:00:00.000Z', '2026-04-28T10:00:00.000Z');
          INSERT INTO device_installations (id, user_id, last_seen_at, updated_at)
          VALUES ('installation_1', 'user_1', '2026-04-28T10:00:00.000Z', '2026-04-28T10:00:00.000Z');
        `
      )
      const db = createSqliteD1(dbPath)

      await markIngestSynced(db, {
        uploadTokenHash: 'token_hash',
        deviceId: 'device_1',
        installationId: 'installation_1',
        syncedAt: '2026-04-28T09:00:00Z'
      })

      await expectSyncTimestamps(db, '2026-04-28T10:00:00.000Z')

      await markIngestSynced(db, {
        uploadTokenHash: 'token_hash',
        deviceId: 'device_other',
        installationId: null,
        syncedAt: '2026-04-28T11:00:00Z'
      })

      const otherDevice = await db
        .prepare('SELECT last_synced_at AS lastSyncedAt FROM devices WHERE id = ?')
        .bind('device_other')
        .first<{ lastSyncedAt: string }>()
      expect(otherDevice?.lastSyncedAt).toBe('2026-04-28T10:00:00.000Z')

      await markIngestSynced(db, {
        uploadTokenHash: 'token_hash',
        deviceId: 'device_1',
        installationId: 'installation_1',
        syncedAt: '2026-04-28 11:00:00+00:00'
      })

      await expectSyncTimestamps(db, '2026-04-28T11:00:00.000Z')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('repairs malformed stored timestamps and rejects malformed incoming timestamps', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-ingest-sync-'))
    const dbPath = join(tempDir, 'sync.db')

    try {
      runSql(
        dbPath,
        `
          CREATE TABLE upload_tokens (
            token_hash TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            last_used_at TEXT
          );
          CREATE TABLE devices (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            last_synced_at TEXT,
            updated_at TEXT
          );
          CREATE TABLE device_installations (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            last_seen_at TEXT,
            updated_at TEXT
          );
          INSERT INTO upload_tokens (token_hash, user_id, last_used_at)
          VALUES ('token_hash', 'user_1', 'not-a-timestamp');
          INSERT INTO devices (id, user_id, last_synced_at, updated_at)
          VALUES ('device_1', 'user_1', 'not-a-timestamp', 'not-a-timestamp');
          INSERT INTO device_installations (id, user_id, last_seen_at, updated_at)
          VALUES ('installation_1', 'user_1', 'not-a-timestamp', 'not-a-timestamp');
        `
      )
      const db = createSqliteD1(dbPath)

      await markIngestSynced(db, {
        uploadTokenHash: 'token_hash',
        deviceId: 'device_1',
        installationId: 'installation_1',
        syncedAt: '2026-04-28 11:00:00+00:00'
      })

      await expectSyncTimestamps(db, '2026-04-28T11:00:00.000Z')
      await expect(
        markIngestSynced(db, {
          uploadTokenHash: 'token_hash',
          deviceId: 'device_1',
          installationId: 'installation_1',
          syncedAt: 'not-a-timestamp'
        })
      ).rejects.toThrow('Invalid syncedAt timestamp')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})

async function expectSyncTimestamps(db: D1Database, expected: string) {
  const row = await db
    .prepare(
      `
        SELECT
          (SELECT last_used_at FROM upload_tokens WHERE token_hash = ?) AS token,
          (SELECT last_synced_at FROM devices WHERE id = ?) AS device,
          (SELECT last_seen_at FROM device_installations WHERE id = ?) AS installation
      `
    )
    .bind('token_hash', 'device_1', 'installation_1')
    .first<{ token: string; device: string; installation: string }>()

  expect(row).toEqual({ token: expected, device: expected, installation: expected })
}

describe('backfillUsageSummaryCache', () => {
  test('refreshes summary keys with a bounded cursor before totals', async () => {
    const bindings: unknown[][] = []
    const sqlStatements: string[] = []
    const batches: unknown[][] = []
    const runValues: unknown[][] = []
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              sql,
              values,
              async first() {
                return null
              },
              async all() {
                if (!sql.includes('FROM daily_usage') || sql.includes('daily_usage_summary')) {
                  return { results: [] }
                }
                return {
                  results: [
                    {
                      userId: 'user_1',
                      usageDate: '2026-04-28',
                      source: 'codex',
                      model: 'gpt-5'
                    },
                    {
                      userId: 'user_1',
                      usageDate: '2026-04-29',
                      source: 'claude-code',
                      model: 'claude-sonnet-4-5'
                    },
                    {
                      userId: 'user_2',
                      usageDate: '2026-04-30',
                      source: 'codex',
                      model: 'gpt-5'
                    }
                  ]
                }
              },
              async run() {
                runValues.push(values)
                return { success: true }
              }
            }
          }
        }
      },
      async batch(statements: unknown[]) {
        batches.push(statements)
        return statements.map(() => ({ success: true }))
      }
    } as unknown as D1Database

    const result = await backfillUsageSummaryCache({ db, limit: 2 })

    expect(result).toEqual({ backfilled: 2, totalsRefreshed: 0 })
    expect(sqlStatements[0]).toContain('FROM usage_summary_backfill_state')
    expect(sqlStatements[1]).toContain('FROM daily_usage')
    expect(sqlStatements[1]).toContain('GROUP BY user_id, usage_date, source, model')
    expect(sqlStatements[1]).toContain('ORDER BY user_id ASC, usage_date ASC, source ASC, model ASC')
    expect(sqlStatements[1]).not.toContain('aggregate_usage AS')
    expect(sqlStatements[1]).not.toContain('WHERE (user_id, usage_date, source, model) >')
    expect(bindings[1].at(-1)).toBe(3)
    expect(sqlStatements.filter((sql) => sql.includes('INSERT INTO daily_usage_summary'))).toHaveLength(2)
    expect(sqlStatements.filter((sql) => sql.includes('INSERT INTO user_usage_totals'))).toHaveLength(0)
    expect(runValues.at(-1)).toEqual([
      'initial',
      'summaries',
      'user_1',
      '2026-04-29',
      'claude-code',
      'claude-sonnet-4-5',
      null
    ])
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(2)
  })

  test('continues summary backfill with a composite cursor instead of an OR scan', async () => {
    const bindings: unknown[][] = []
    const sqlStatements: string[] = []
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async first() {
                return {
                  phase: 'summaries',
                  cursorUserId: 'user_1',
                  cursorUsageDate: '2026-04-28',
                  cursorSource: 'codex',
                  cursorModel: 'gpt-5',
                  completedAt: null
                }
              },
              async all() {
                return {
                  results: [
                    {
                      userId: 'user_1',
                      usageDate: '2026-04-29',
                      source: 'claude-code',
                      model: 'claude-sonnet-4-5'
                    }
                  ]
                }
              },
              async run() {
                return { success: true }
              }
            }
          }
        }
      },
      async batch(statements: unknown[]) {
        return statements.map(() => ({ success: true }))
      }
    } as unknown as D1Database

    const result = await backfillUsageSummaryCache({ db, limit: 1 })

    expect(result).toEqual({ backfilled: 1, totalsRefreshed: 0 })
    expect(sqlStatements[1]).toContain('WHERE (user_id, usage_date, source, model) > (?, ?, ?, ?)')
    expect(sqlStatements[1]).not.toContain('OR user_id >')
    expect(bindings[1]).toEqual(['user_1', '2026-04-28', 'codex', 'gpt-5', 2])
  })

  test('treats missing cursor columns as an initial summary backfill state', async () => {
    const bindings: unknown[][] = []
    const sqlStatements: string[] = []
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async first() {
                return { phase: 'summaries' }
              },
              async all() {
                return { results: [] }
              },
              async run() {
                return { success: true }
              }
            }
          }
        }
      },
      async batch(statements: unknown[]) {
        return statements.map(() => ({ success: true }))
      }
    } as unknown as D1Database

    const result = await backfillUsageSummaryCache({ db, limit: 1 })

    expect(result).toEqual({ backfilled: 0, totalsRefreshed: 0 })
    expect(sqlStatements[1]).toContain('FROM daily_usage')
    expect(sqlStatements[1]).not.toContain('WHERE (user_id, usage_date, source, model) >')
    expect(bindings[1]).toEqual([2])
  })

  test('refreshes totals from summaries after summary backfill completes', async () => {
    const bindings: unknown[][] = []
    const sqlStatements: string[] = []
    const batches: unknown[][] = []
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              sql,
              values,
              async first() {
                return {
                  phase: 'totals',
                  cursorUserId: null,
                  cursorUsageDate: null,
                  cursorSource: null,
                  cursorModel: null,
                  completedAt: null
                }
              },
              async all() {
                return { results: [{ userId: 'user_1' }, { userId: 'user_2' }] }
              },
              async run() {
                return { success: true }
              }
            }
          }
        }
      },
      async batch(statements: unknown[]) {
        batches.push(statements)
        return statements.map(() => ({ success: true }))
      }
    } as unknown as D1Database

    const result = await backfillUsageSummaryCache({ db, limit: 50 })

    expect(result).toEqual({ backfilled: 0, totalsRefreshed: 2 })
    expect(sqlStatements[1]).toContain('FROM daily_usage_summary')
    expect(sqlStatements[1]).not.toContain('WHERE ? IS NULL')
    expect(sqlStatements.join('\n')).not.toContain('aggregate_totals AS')
    expect(sqlStatements.filter((sql) => sql.includes('INSERT INTO daily_usage_summary'))).toHaveLength(0)
    expect(sqlStatements.filter((sql) => sql.includes('INSERT INTO user_usage_totals'))).toHaveLength(2)
    expect(bindings.some((values) => values.length === 3 && values[0] === 'user_1' && values[2] === 'user_1')).toBe(
      true
    )
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(2)
  })

  test('continues totals backfill with a user id cursor instead of a nullable OR scan', async () => {
    const bindings: unknown[][] = []
    const sqlStatements: string[] = []
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async first() {
                return {
                  phase: 'totals',
                  cursorUserId: 'user_1',
                  cursorUsageDate: null,
                  cursorSource: null,
                  cursorModel: null,
                  completedAt: null
                }
              },
              async all() {
                return { results: [{ userId: 'user_2' }] }
              },
              async run() {
                return { success: true }
              }
            }
          }
        }
      },
      async batch(statements: unknown[]) {
        return statements.map(() => ({ success: true }))
      }
    } as unknown as D1Database

    const result = await backfillUsageSummaryCache({ db, limit: 1 })

    expect(result).toEqual({ backfilled: 0, totalsRefreshed: 1 })
    expect(sqlStatements[1]).toContain('FROM daily_usage_summary')
    expect(sqlStatements[1]).toContain('WHERE user_id > ?')
    expect(sqlStatements[1]).not.toContain('WHERE ? IS NULL')
    expect(bindings[1]).toEqual(['user_1', 2])
  })
})

describe('findExistingSnapshotHashes', () => {
  test('queries existing hashes for the authenticated device and requested snapshot keys', async () => {
    const bindings: unknown[][] = []
    const sqlStatements: string[] = []
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async all() {
                if (sql.includes('expected_summary')) return { results: [] }
                return {
                  results: [
                    {
                      source: 'codex',
                      usageDate: '2026-04-28',
                      model: 'gpt-5',
                      snapshotHash: 'hash_1'
                    }
                  ]
                }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const result = await findExistingSnapshotHashes(db, {
      userId: 'seed-user',
      deviceId: 'dev_123',
      keys: [
        { source: 'codex', usageDate: '2026-04-28', model: 'gpt-5' },
        { source: 'claude-code', usageDate: '2026-04-29', model: 'claude-sonnet-4-5' }
      ]
    })

    expect(result).toEqual([
      {
        source: 'codex',
        usageDate: '2026-04-28',
        model: 'gpt-5',
        snapshotHash: 'hash_1'
      }
    ])
    expect(sqlStatements[0]).toContain('FROM daily_usage')
    expect(sqlStatements[0]).toContain('user_id = ?')
    expect(sqlStatements[0]).toContain('device_id = ?')
    // Row-value IN, not an OR chain: only this shape is sargable on the full logical key,
    // so the check seeks one row per key instead of the device's whole date range.
    expect(sqlStatements[0]).toContain('(source, usage_date, model) IN (VALUES (?, ?, ?), (?, ?, ?))')
    expect(sqlStatements[0]).not.toContain('(source = ? AND usage_date = ? AND model = ?)')
    expect(sqlStatements[1]).toContain('expected_summary')
    expect(bindings[0]).toEqual([
      'seed-user',
      'dev_123',
      'codex',
      '2026-04-28',
      'gpt-5',
      'claude-code',
      '2026-04-29',
      'claude-sonnet-4-5'
    ])
    expect(bindings[1]).toEqual(['seed-user', '2026-04-28', 'codex', 'gpt-5'])
  })

  test('does not report existing hashes when the summary cache is missing or stale', async () => {
    const db = {
      prepare(sql: string) {
        return {
          bind() {
            return {
              async all() {
                if (sql.includes('expected_summary')) {
                  return {
                    results: [
                      {
                        userId: 'seed-user',
                        usageDate: '2026-04-28',
                        source: 'codex',
                        model: 'gpt-5'
                      }
                    ]
                  }
                }
                return {
                  results: [
                    {
                      source: 'codex',
                      usageDate: '2026-04-28',
                      model: 'gpt-5',
                      snapshotHash: 'hash_1'
                    }
                  ]
                }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const result = await findExistingSnapshotHashes(db, {
      userId: 'seed-user',
      deviceId: 'dev_123',
      keys: [{ source: 'codex', usageDate: '2026-04-28', model: 'gpt-5' }]
    })

    expect(result).toEqual([])
  })

  // The per-request totals reconciliation is gone (batch B2/B4): totals drift no longer changes
  // what a snapshot-hash check proves, and the daily self-heal pass owns the repair. This test
  // pins the removal — a stale-totals user must still get its unchanged rows reported, and the
  // check must never issue an expected_totals query again.
  test('reports unchanged hashes without consulting user totals', async () => {
    const sqlStatements: string[] = []
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind() {
            return {
              async all() {
                if (sql.includes('expected_summary')) {
                  return { results: [] }
                }
                return {
                  results: [
                    {
                      source: 'codex',
                      usageDate: '2026-04-28',
                      model: 'gpt-5',
                      snapshotHash: 'hash_1'
                    }
                  ]
                }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const result = await findExistingSnapshotHashes(db, {
      userId: 'seed-user',
      deviceId: 'dev_123',
      keys: [{ source: 'codex', usageDate: '2026-04-28', model: 'gpt-5' }]
    })

    expect(result).toEqual([{ source: 'codex', usageDate: '2026-04-28', model: 'gpt-5', snapshotHash: 'hash_1' }])
    expect(sqlStatements.some((sql) => sql.includes('expected_totals'))).toBe(false)
    expect(sqlStatements.some((sql) => sql.includes('user_usage_totals'))).toBe(false)
  })

  test('keeps existing hash queries under the D1 bound parameter limit', async () => {
    const bindings: unknown[][] = []
    let requestIndex = 0
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async all() {
                if (sql.includes('expected_summary')) {
                  return { results: [] }
                }
                const chunkKeys = values.slice(2)
                const results = []
                for (let index = 0; index < chunkKeys.length; index += 3) {
                  results.push({
                    source: chunkKeys[index],
                    usageDate: chunkKeys[index + 1],
                    model: chunkKeys[index + 2],
                    snapshotHash: `hash_${requestIndex}_${index}`
                  })
                }
                requestIndex += 1
                return { results }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const keys = Array.from({ length: 40 }, (_, index) => ({
      source: 'codex' as const,
      usageDate: `2026-04-${String((index % 30) + 1).padStart(2, '0')}`,
      model: `gpt-5-${index}`
    }))

    await findExistingSnapshotHashes(db, {
      userId: 'seed-user',
      deviceId: 'dev_123',
      keys
    })

    expect(bindings.every((values) => values.length <= 100)).toBe(true)
    // Each chunk keeps one parameter of headroom below the D1 limit, so a statement that later
    // gains a binding still fits. 40 keys → 32+8 hash-query chunks, then the 40 hit rows feed
    // the 24+16 stale-summary check chunks.
    expect(bindings.map((values) => values.length)).toEqual([98, 26, 96, 64])
  })
})
