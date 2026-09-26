import type { UsageSnapshot } from '@tokenboard/usage-core'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { AuthenticatedUser } from '../auth/middleware'
import { createSqliteD1, runSql } from '../../test/sqlite-d1'
import { checkExistingSnapshots, ingestSnapshots } from './service'

const legacyUser: AuthenticatedUser = {
  id: 'user_legacy',
  uploadTokenHash: 'hash:legacy-upload-token',
  deviceId: null,
  installationId: null
}

function makeSnapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    source: 'codex',
    usageDate: '2026-05-22',
    timezone: 'Asia/Shanghai',
    model: 'gpt-5',
    inputTokens: 100,
    outputTokens: 40,
    cacheCreationTokens: 0,
    cacheReadTokens: 20,
    totalTokens: 160,
    costUsd: 0.03,
    sessionCount: 2,
    collectedAt: '2026-05-22T08:00:00.000Z',
    ...overrides
  }
}

function createRecordingDb() {
  const bound: Array<{ sql: string; values: unknown[] }> = []
  const batches: unknown[][] = []

  const db = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          const statement = {
            sql,
            values,
            async run() {
              return { success: true }
            },
            async all() {
              return { results: [] }
            }
          }
          bound.push({ sql, values })
          return statement
        }
      }
    },
    async batch(statements: unknown[]) {
      batches.push(statements)
      return statements.map(() => ({ success: true }))
    }
  } as unknown as D1Database

  return { db, bound, batches }
}

describe('ingest service', () => {
  test('stores old upload token snapshots under the legacy device id', async () => {
    const { db, bound, batches } = createRecordingDb()

    const result = await ingestSnapshots(db, legacyUser, [makeSnapshot()], '2026-05-22T09:00:00.000Z')

    expect(result).toEqual({ upserted: 1 })
    expect(batches).toHaveLength(3)
    expect(batches[0]).toHaveLength(1)
    expect(batches[1]).toHaveLength(2)
    expect(batches[2]).toHaveLength(1)
    const usageUpsert = bound.find((entry) => entry.sql.includes('INSERT INTO daily_usage ('))
    expect(usageUpsert?.values.slice(0, 6)).toEqual([
      'user_legacy',
      'legacy',
      'codex',
      '2026-05-22',
      'Asia/Shanghai',
      'gpt-5'
    ])
    expect(usageUpsert?.values[14]).toBe('2026-05-22T08:00:00.000Z')
    const tokenUpdate = bound.find((entry) => entry.sql.includes('UPDATE upload_tokens'))
    expect(tokenUpdate?.values).toEqual([
      '2026-05-22T09:00:00.000Z',
      'hash:legacy-upload-token',
      '2026-05-22T09:00:00.000Z'
    ])
    expect(bound.some((entry) => entry.sql.includes('UPDATE devices'))).toBe(false)
  })

  test('checks existing hashes against legacy device rows for old upload tokens', async () => {
    const { db, bound } = createRecordingDb()

    await checkExistingSnapshots(db, legacyUser, [{ source: 'codex', usageDate: '2026-05-22', model: 'gpt-5' }])

    expect(bound[0].sql).toContain('FROM daily_usage')
    expect(bound[0].sql).toContain('device_id = ?')
    expect(bound[0].values.slice(0, 5)).toEqual(['user_legacy', 'legacy', 'codex', '2026-05-22', 'gpt-5'])
  })

  test('rejects an invalid sync timestamp before writing usage rows', async () => {
    const { db, bound, batches } = createRecordingDb()

    await expect(ingestSnapshots(db, legacyUser, [makeSnapshot()], 'not-a-timestamp')).rejects.toThrow(
      'Invalid syncedAt timestamp'
    )
    expect(bound).toHaveLength(0)
    expect(batches).toHaveLength(0)
  })

  test('keeps usage freshness based on collectedAt while heartbeats use server time', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-ingest-service-'))
    const dbPath = join(tempDir, 'ingest.db')

    try {
      runSql(
        dbPath,
        `
          CREATE TABLE daily_usage (
            user_id TEXT NOT NULL,
            device_id TEXT NOT NULL,
            source TEXT NOT NULL,
            usage_date TEXT NOT NULL,
            timezone TEXT NOT NULL,
            model TEXT NOT NULL,
            input_tokens INTEGER NOT NULL,
            output_tokens INTEGER NOT NULL,
            cache_creation_tokens INTEGER NOT NULL,
            cache_read_tokens INTEGER NOT NULL,
            total_tokens INTEGER NOT NULL,
            cost_usd REAL NOT NULL,
            session_count INTEGER NOT NULL,
            snapshot_hash TEXT,
            synced_at TEXT NOT NULL,
            PRIMARY KEY (user_id, device_id, source, usage_date, model)
          );
          CREATE TABLE daily_usage_summary (
            user_id TEXT NOT NULL,
            usage_date TEXT NOT NULL,
            source TEXT NOT NULL,
            model TEXT NOT NULL,
            timezone TEXT NOT NULL,
            input_tokens INTEGER NOT NULL,
            output_tokens INTEGER NOT NULL,
            cache_creation_tokens INTEGER NOT NULL,
            cache_read_tokens INTEGER NOT NULL,
            total_tokens INTEGER NOT NULL,
            total_tokens_without_cache_read INTEGER NOT NULL,
            cost_usd REAL NOT NULL,
            session_count INTEGER NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (user_id, usage_date, source, model)
          );
          CREATE TABLE user_usage_totals (
            user_id TEXT PRIMARY KEY,
            total_tokens INTEGER NOT NULL,
            total_tokens_without_cache_read INTEGER NOT NULL,
            cost_usd REAL NOT NULL,
            session_count INTEGER NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE usage_summary_backfill_state (
            id TEXT PRIMARY KEY,
            phase TEXT NOT NULL,
            cursor_user_id TEXT,
            cursor_usage_date TEXT,
            cursor_source TEXT,
            cursor_model TEXT,
            completed_at TEXT,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE upload_tokens (
            token_hash TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            last_used_at TEXT
          );
          INSERT INTO upload_tokens (token_hash, user_id) VALUES ('hash:legacy-upload-token', 'user_legacy');
        `
      )
      const db = createSqliteD1(dbPath)
      const newer = makeSnapshot({
        inputTokens: 300,
        outputTokens: 200,
        totalTokens: 500,
        collectedAt: '2026-05-22T10:05:00.000Z'
      })
      const older = {
        ...newer,
        inputTokens: 80,
        outputTokens: 20,
        totalTokens: 100,
        collectedAt: '2026-05-22T09:00:00.000Z'
      }

      await ingestSnapshots(db, legacyUser, [newer], '2026-05-22T10:10:00.000Z')
      await ingestSnapshots(db, legacyUser, [older], '2026-05-22T10:11:00.000Z')

      const usage = await db
        .prepare(
          `SELECT total_tokens AS totalTokens, synced_at AS syncedAt
           FROM daily_usage
           WHERE user_id = ? AND device_id = ? AND source = ? AND usage_date = ? AND model = ?`
        )
        .bind('user_legacy', 'legacy', newer.source, newer.usageDate, newer.model)
        .first<{ totalTokens: number; syncedAt: string }>()
      const token = await db
        .prepare('SELECT last_used_at AS lastUsedAt FROM upload_tokens WHERE token_hash = ?')
        .bind('hash:legacy-upload-token')
        .first<{ lastUsedAt: string }>()

      expect(usage).toEqual({ totalTokens: newer.totalTokens, syncedAt: newer.collectedAt })
      expect(token).toEqual({ lastUsedAt: '2026-05-22T10:11:00.000Z' })

      await ingestSnapshots(
        db,
        legacyUser,
        [
          {
            ...newer,
            inputTokens: 700,
            outputTokens: 0,
            totalTokens: 700,
            collectedAt: '2099-01-01T00:00:00.000Z'
          }
        ],
        '2026-05-22T10:12:00.000Z'
      )
      await ingestSnapshots(
        db,
        legacyUser,
        [
          {
            ...newer,
            inputTokens: 800,
            outputTokens: 0,
            totalTokens: 800,
            collectedAt: '2026-05-22T10:13:00.000Z'
          }
        ],
        '2026-05-22T10:14:00.000Z'
      )

      const afterClockSkew = await db
        .prepare(
          `SELECT total_tokens AS totalTokens, synced_at AS syncedAt
           FROM daily_usage
           WHERE user_id = ? AND device_id = ? AND source = ? AND usage_date = ? AND model = ?`
        )
        .bind('user_legacy', 'legacy', newer.source, newer.usageDate, newer.model)
        .first<{ totalTokens: number; syncedAt: string }>()
      expect(afterClockSkew).toEqual({ totalTokens: 800, syncedAt: '2026-05-22T10:13:00.000Z' })
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
