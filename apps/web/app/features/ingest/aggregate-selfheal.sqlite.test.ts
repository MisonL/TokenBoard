import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { createSqliteD1, runSql } from '../../test/sqlite-d1'
import { selfHealAggregates } from './repository/selfheal'

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations')

// B6: the daily pass that keeps the aggregates honest. The incremental totals path only moves
// the stored value by what the current batch saw, so anything that changes a summary behind the
// client's back is invisible to it — this pass is the only thing that fixes that class of error,
// and it has to exist before the per-request reconciliations are removed.
describe('aggregate self-heal', () => {
  const tempDirs: string[] = []
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function createDb() {
    const dir = mkdtempSync(join(tmpdir(), 'aggregate-selfheal-'))
    tempDirs.push(dir)
    const path = join(dir, 'tokenboard.db')
    for (const file of readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .sort()) {
      runSql(path, readFileSync(join(migrationsDir, file), 'utf8'))
    }
    runSql(
      path,
      `INSERT INTO users (id, email, name, created_at, updated_at)
       VALUES ('u1','u1@example.test','u1','2026-06-01T00:00:00.000Z','2026-06-01T00:00:00.000Z');
       -- The initial backfill must read as finished, or the totals writer's gate skips every fix.
       INSERT INTO usage_summary_backfill_state (id, phase, completed_at, updated_at)
       VALUES ('initial','totals','2026-06-01T00:00:00.000Z','2026-06-01T00:00:00.000Z');`
    )
    return { db: createSqliteD1(path), path }
  }

  function addUsage(
    path: string,
    values: { source?: string; model?: string; usageDate?: string; total?: number } = {}
  ) {
    const source = values.source ?? 'codex'
    const model = values.model ?? 'gpt-5'
    const usageDate = values.usageDate ?? '2026-06-01'
    const total = values.total ?? 100
    runSql(
      path,
      `INSERT INTO daily_usage (user_id, device_id, source, usage_date, timezone, model, input_tokens,
         output_tokens, cache_creation_tokens, cache_read_tokens, total_tokens, cost_usd, session_count,
         snapshot_hash, synced_at)
       VALUES ('u1','dev-a','${source}','${usageDate}','UTC','${model}',${total},0,0,0,${total},1.5,1,'h','2026-06-01T00:00:00.000Z');`
    )
  }

  function addSummary(path: string, total: number) {
    runSql(
      path,
      `INSERT INTO daily_usage_summary (user_id, usage_date, source, model, timezone, input_tokens,
         output_tokens, cache_creation_tokens, cache_read_tokens, total_tokens, total_tokens_without_cache_read,
         cost_usd, session_count, updated_at)
       VALUES ('u1','2026-06-01','codex','gpt-5','UTC',${total},0,0,0,${total},${total},1.5,1,'2026-06-01T10:00:00.000Z');`
    )
  }

  function addTotals(path: string, total: number) {
    runSql(
      path,
      `INSERT INTO user_usage_totals (user_id, total_tokens, total_tokens_without_cache_read, cost_usd, session_count, updated_at)
       VALUES ('u1',${total},${total},${total === 0 ? 0 : 1.5},1,'2026-06-01T10:00:00.000Z');`
    )
  }

  const scalar = (path: string, sql: string) => String(runSql(path, sql)).trim().split('\n').at(-1)

  test('repairs a summary row that disagrees with its raw rows', async () => {
    const { db, path } = createDb()
    addUsage(path, { total: 100 })
    addSummary(path, 7) // wrong: the raw rows add up to 100

    const result = await selfHealAggregates({ db, chunkSize: 500 })

    expect(result.summariesChecked).toBe(1)
    expect(result.summariesRepaired).toBe(1)
    expect(scalar(path, 'SELECT total_tokens FROM daily_usage_summary;')).toBe('100')
  })

  test('an already-correct summary is left alone', async () => {
    const { db, path } = createDb()
    addUsage(path, { total: 100 })
    addSummary(path, 100)

    const result = await selfHealAggregates({ db, chunkSize: 500 })

    expect(result.summariesRepaired).toBe(0)
    // untouched: updated_at only moves when a value actually changes (the W3 guard).
    expect(scalar(path, 'SELECT updated_at FROM daily_usage_summary;')).toBe('2026-06-01T10:00:00.000Z')
  })

  test('a summary with no raw rows behind it is removed', async () => {
    const { db, path } = createDb()
    addSummary(path, 50) // no daily_usage row for this key

    const result = await selfHealAggregates({ db, chunkSize: 500 })

    expect(result.summariesChecked).toBe(0) // nothing to check: there is no raw key
    expect(result.orphansRemoved).toBe(1)
    expect(scalar(path, 'SELECT COUNT(*) FROM daily_usage_summary;')).toBe('0')
  })

  // The exact failure the write probe reproduced: the difference update keeps an error the
  // stored totals already had, so a deleted summary row leaves the totals over-counting forever
  // unless the daily pass notices.
  test('repairs totals left over-counting after a summary row was deleted', async () => {
    const { db, path } = createDb()
    addUsage(path, { total: 125 })
    addSummary(path, 125)
    addTotals(path, 125)

    // Delete the summary behind the totals and re-derive it from the raw rows, which is what an
    // ingest does; the incremental difference would then double-count.
    runSql(path, 'DELETE FROM daily_usage_summary;')
    await selfHealAggregates({ db, chunkSize: 500 })
    expect(scalar(path, 'SELECT total_tokens FROM user_usage_totals;')).toBe('125')

    runSql(path, 'DELETE FROM daily_usage WHERE total_tokens = 125;')
    await selfHealAggregates({ db, chunkSize: 500 })

    // With no raw rows and no summaries left, the totals must fall to zero rather than stay at
    // the stale 125.
    expect(scalar(path, 'SELECT total_tokens FROM user_usage_totals;')).toBe('0')
  })

  test('repairs a totals row that disagrees while its summaries are correct', async () => {
    const { db, path } = createDb()
    addUsage(path, { total: 100 })
    addSummary(path, 100)
    addTotals(path, 999)

    const result = await selfHealAggregates({ db, chunkSize: 500 })

    expect(result.totalsChecked).toBe(1)
    expect(result.totalsRepaired).toBe(1)
    expect(scalar(path, 'SELECT total_tokens FROM user_usage_totals;')).toBe('100')
  })

  test('never creates an all-zero totals placeholder for a user with no data', async () => {
    const { db, path } = createDb()

    const result = await selfHealAggregates({ db, chunkSize: 500 })

    expect(result.roundCompleted).toBe(true)
    expect(scalar(path, 'SELECT COUNT(*) FROM user_usage_totals;')).toBe('0')
  })

  test('a round completes and the next call starts a fresh one', async () => {
    const { db, path } = createDb()
    addUsage(path, { total: 100 })
    addSummary(path, 100)
    addTotals(path, 100)

    const first = await selfHealAggregates({ db, chunkSize: 500 })
    expect(first.roundCompleted).toBe(true)

    const second = await selfHealAggregates({ db, chunkSize: 500 })
    expect(second.roundCompleted).toBe(true)
    expect(second.summariesChecked).toBe(1)
    // completion is stamped on the self-heal row only; the initial backfill row is untouched.
    expect(
      scalar(path, `SELECT completed_at IS NOT NULL FROM usage_summary_backfill_state WHERE id = 'initial';`)
    ).toBe('1')
    expect(scalar(path, `SELECT phase FROM usage_summary_backfill_state WHERE id = 'selfheal';`)).toBe('summaries')
  })

  // The per-call budget is the whole point of the cursor: a huge keyspace must not turn one
  // scheduled tick into an unbounded scan.
  test('resumes from its cursor across calls', async () => {
    const { db, path } = createDb()
    for (const day of ['2026-06-01', '2026-06-02', '2026-06-03']) {
      addUsage(path, { usageDate: day, total: 100 })
    }
    addSummary(path, 1) // only the first day's key exists, and it is wrong

    const first = await selfHealAggregates({ db, chunkSize: 2, maxChunks: 1 })
    expect(first.summariesChecked).toBe(2)
    expect(first.roundCompleted).toBe(false)

    const second = await selfHealAggregates({ db, chunkSize: 2, maxChunks: 1 })
    expect(second.summariesChecked).toBe(1) // the third key, from the persisted cursor

    expect(scalar(path, 'SELECT COUNT(*) FROM daily_usage_summary WHERE total_tokens = 100;')).toBe('3')
  })

  test('the totals gate keeps the pass silent while the initial backfill runs', async () => {
    const { db, path } = createDb()
    runSql(
      path,
      `UPDATE usage_summary_backfill_state SET phase = 'summaries', completed_at = NULL WHERE id = 'initial';`
    )
    addUsage(path, { total: 100 })
    addSummary(path, 100)
    addTotals(path, 999)

    const result = await selfHealAggregates({ db, chunkSize: 500 })

    expect(result.totalsRepaired).toBe(0)
    expect(scalar(path, 'SELECT total_tokens FROM user_usage_totals;')).toBe('999')
    // Summaries are not gated, so they are still kept correct during a backfill.
    expect(scalar(path, 'SELECT total_tokens FROM daily_usage_summary;')).toBe('100')
  })

  // The expected cost is the *billable* sum, matching what the writer stores: a user holding an
  // antigravity-family summary row must not be flagged as drifted merely because the raw cost is
  // nonzero, or every such user would be rewritten on every daily pass.
  test('an antigravity cost is compared billably, not raw', async () => {
    const { db, path } = createDb()
    runSql(
      path,
      `INSERT INTO daily_usage (user_id, device_id, source, usage_date, timezone, model, input_tokens,
         output_tokens, cache_creation_tokens, cache_read_tokens, total_tokens, cost_usd, session_count,
         snapshot_hash, synced_at)
       VALUES ('u1','dev-a','antigravity','2026-06-01','UTC','gemini',50,0,0,0,50,9,1,'h2','2026-06-01T00:00:00.000Z');
       INSERT INTO daily_usage_summary (user_id, usage_date, source, model, timezone, input_tokens,
         output_tokens, cache_creation_tokens, cache_read_tokens, total_tokens, total_tokens_without_cache_read,
         cost_usd, session_count, updated_at)
       VALUES ('u1','2026-06-01','antigravity','gemini','UTC',50,0,0,0,50,50,9,1,'2026-06-01T10:00:00.000Z');
       -- totals.cost_usd = 0 is what the billable writer produces for this source.
       INSERT INTO user_usage_totals (user_id, total_tokens, total_tokens_without_cache_read, cost_usd, session_count, updated_at)
       VALUES ('u1',50,50,0,1,'2026-06-01T10:00:00.000Z');`
    )

    const correct = await selfHealAggregates({ db, chunkSize: 500 })
    expect(correct.totalsChecked).toBe(1)
    expect(correct.totalsRepaired).toBe(0)

    // A totals row that *did* keep the raw cost is real drift and must be repaired back to 0.
    runSql(path, `UPDATE user_usage_totals SET cost_usd = 9;`)
    const drifted = await selfHealAggregates({ db, chunkSize: 500 })
    expect(drifted.totalsRepaired).toBe(1)
    expect(scalar(path, 'SELECT cost_usd FROM user_usage_totals;')).toBe('0')
  })
})
