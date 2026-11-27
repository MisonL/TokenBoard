import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { createSqliteD1, runSql } from '../../test/sqlite-d1'
import { prepareSummaryRefresh, prepareUserTotalFromSummaryRefresh } from './repository/refresh'

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations')

// Both aggregate upserts carry a value-equality guard, and each guard earns its keep twice:
// D1 bills one index write per indexed column on every UPDATE, and the two `updated_at`
// columns here are inputs to the public-card cache key (profile.ts folds
// `MAX(daily_usage_summary.updated_at)` and `user_usage_totals.updated_at` into it) as well as
// the freshness comparison in public-card/service/totals.ts. An unchanged re-upload therefore
// must neither pay the write nor invalidate a cached card.
describe('aggregate upsert value guards', () => {
  const tempDirs: string[] = []
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function createDb() {
    const dir = mkdtempSync(join(tmpdir(), 'aggregate-guards-'))
    tempDirs.push(dir)
    const path = join(dir, 'tokenboard.db')
    for (const file of readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .sort()) {
      runSql(path, readMigration(file))
    }
    runSql(
      path,
      `INSERT INTO users (id, email, name, created_at, updated_at)
       VALUES ('u1','u1@example.test','u1','2026-06-01T00:00:00.000Z','2026-06-01T00:00:00.000Z');`
    )
    return { db: createSqliteD1(path), path }
  }

  function readMigration(file: string) {
    return readFileSync(join(migrationsDir, file), 'utf8')
  }

  function insertSummaryRow(path: string, values: { totalTokens: number; costUsd: number; updatedAt: string }) {
    runSql(
      path,
      `INSERT INTO daily_usage_summary (
         user_id, usage_date, source, model, timezone, input_tokens, output_tokens,
         cache_creation_tokens, cache_read_tokens, total_tokens, total_tokens_without_cache_read,
         cost_usd, session_count, updated_at)
       VALUES ('u1','2026-06-01','codex','gpt-5','UTC',100,60,0,50,
         ${values.totalTokens},${values.totalTokens - 50},${values.costUsd},2,'${values.updatedAt}');`
    )
  }

  // The summary upsert derives its values from daily_usage, so an "unchanged" row needs a
  // matching device row: total_tokens 160 = 100 input + 60 output, without-cache-read 110,
  // cost 1.25, session_count 2 — the same tuple insertSummaryRow stores.
  function insertUsageRow(path: string, overrides: { totalTokens?: number; costUsd?: number } = {}) {
    const totalTokens = overrides.totalTokens ?? 160
    const costUsd = overrides.costUsd ?? 1.25
    runSql(
      path,
      `INSERT INTO daily_usage (
         user_id, device_id, source, usage_date, timezone, model, input_tokens, output_tokens,
         cache_creation_tokens, cache_read_tokens, total_tokens, cost_usd, session_count,
         snapshot_hash, synced_at)
       VALUES ('u1','dev-a','codex','2026-06-01','UTC','gpt-5',100,60,0,50,
         ${totalTokens},${costUsd},2,'hash-1','2026-06-01T00:00:00.000Z');`
    )
  }

  test('a summary refresh with unchanged values writes nothing and keeps updated_at', async () => {
    const { db, path } = createDb()
    insertUsageRow(path)
    // The stored summary already matches what the device row aggregates to.
    insertSummaryRow(path, { totalTokens: 160, costUsd: 1.25, updatedAt: '2026-06-01T10:00:00.000Z' })

    const result = await prepareSummaryRefresh(db, {
      userId: 'u1',
      usageDate: '2026-06-01',
      source: 'codex',
      model: 'gpt-5'
    }).run()

    expect(Number(result.meta?.changes)).toBe(0)
    expect(
      runSql(path, `SELECT updated_at FROM daily_usage_summary WHERE user_id = 'u1';`).trim().split('\n').at(-1)
    ).toBe('2026-06-01T10:00:00.000Z')
  })

  test('a summary refresh whose values changed still writes and advances updated_at', async () => {
    const { db, path } = createDb()
    insertUsageRow(path, { totalTokens: 999, costUsd: 9.5 })
    insertSummaryRow(path, { totalTokens: 160, costUsd: 1.25, updatedAt: '2026-06-01T10:00:00.000Z' })

    const result = await prepareSummaryRefresh(db, {
      userId: 'u1',
      usageDate: '2026-06-01',
      source: 'codex',
      model: 'gpt-5'
    }).run()

    expect(Number(result.meta?.changes)).toBe(1)
    const stored = runSql(path, `SELECT total_tokens, updated_at FROM daily_usage_summary WHERE user_id = 'u1';`)
    expect(stored).toContain('999')
    expect(stored).not.toContain('2026-06-01T10:00:00.000Z')
  })

  test('a summary row that differs only in timezone is rewritten', async () => {
    const { db, path } = createDb()
    insertUsageRow(path)
    insertSummaryRow(path, { totalTokens: 160, costUsd: 1.25, updatedAt: '2026-06-01T10:00:00.000Z' })
    runSql(path, `UPDATE daily_usage_summary SET timezone = 'Asia/Shanghai' WHERE user_id = 'u1';`)

    const result = await prepareSummaryRefresh(db, {
      userId: 'u1',
      usageDate: '2026-06-01',
      source: 'codex',
      model: 'gpt-5'
    }).run()

    // timezone is a persisted business field, so the guard has to cover it: a user who changes
    // their date-attribution zone must see it reflected, not skipped as "unchanged".
    expect(Number(result.meta?.changes)).toBe(1)
  })

  test('a totals refresh with unchanged values writes nothing and keeps updated_at', async () => {
    const { db, path } = createDb()
    runSql(
      path,
      `INSERT INTO usage_summary_backfill_state (id, phase, completed_at, updated_at)
       VALUES ('initial','totals','2026-06-01T00:00:00.000Z','2026-06-01T00:00:00.000Z');`
    )
    insertSummaryRow(path, { totalTokens: 160, costUsd: 1.25, updatedAt: '2026-06-01T10:00:00.000Z' })
    runSql(
      path,
      `INSERT INTO user_usage_totals (user_id, total_tokens, total_tokens_without_cache_read, cost_usd, session_count, updated_at)
       VALUES ('u1',160,110,1.25,2,'2026-06-01T10:00:00.000Z');`
    )

    const result = await prepareUserTotalFromSummaryRefresh(db, 'u1').run()

    expect(Number(result.meta?.changes)).toBe(0)
    expect(runSql(path, `SELECT updated_at FROM user_usage_totals;`).trim().split('\n').at(-1)).toBe(
      '2026-06-01T10:00:00.000Z'
    )
  })

  test('a totals refresh after the summary changed still writes', async () => {
    const { db, path } = createDb()
    runSql(
      path,
      `INSERT INTO usage_summary_backfill_state (id, phase, completed_at, updated_at)
       VALUES ('initial','totals','2026-06-01T00:00:00.000Z','2026-06-01T00:00:00.000Z');`
    )
    insertSummaryRow(path, { totalTokens: 400, costUsd: 3, updatedAt: '2026-06-01T10:00:00.000Z' })
    runSql(
      path,
      `INSERT INTO user_usage_totals (user_id, total_tokens, total_tokens_without_cache_read, cost_usd, session_count, updated_at)
       VALUES ('u1',160,110,1.25,2,'2026-06-01T10:00:00.000Z');`
    )

    const result = await prepareUserTotalFromSummaryRefresh(db, 'u1').run()

    expect(Number(result.meta?.changes)).toBe(1)
    expect(runSql(path, `SELECT total_tokens FROM user_usage_totals;`).trim().split('\n').at(-1)).toBe('400')
  })

  // The backfill gate must survive the guard: while the summary backfill is incomplete the
  // totals row stays untouched, which summary-cache.integration.test.ts asserts end to end.
  test('the totals guard does not bypass the backfill gate', async () => {
    const { db, path } = createDb()
    runSql(
      path,
      `INSERT INTO usage_summary_backfill_state (id, phase, updated_at)
       VALUES ('initial','summaries','2026-06-01T00:00:00.000Z');`
    )
    insertSummaryRow(path, { totalTokens: 160, costUsd: 1.25, updatedAt: '2026-06-01T10:00:00.000Z' })
    runSql(
      path,
      `INSERT INTO user_usage_totals (user_id, total_tokens, total_tokens_without_cache_read, cost_usd, session_count, updated_at)
       VALUES ('u1',9999,9999,9,9,'2026-06-01T10:00:00.000Z');`
    )

    const result = await prepareUserTotalFromSummaryRefresh(db, 'u1').run()

    expect(Number(result.meta?.changes)).toBe(0)
    expect(runSql(path, `SELECT total_tokens FROM user_usage_totals;`).trim().split('\n').at(-1)).toBe('9999')
  })
})
