import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { createSqliteD1, runSql } from '../../test/sqlite-d1'
import { upsertUsageSnapshots, type IngestRecord } from './repository'
import { totalsDeltaSql } from './repository/totals-delta'

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations')

// B2/B4: the incremental totals path. Instead of re-deriving each user's totals from a full
// summary scan per request, a batch moves the totals by exactly the difference each refreshed
// key's value changes by. The property that makes this safe — and the one every test here
// checks — is that after any sequence of uploads, `user_usage_totals` equals what a full
// re-derivation over `daily_usage_summary` would produce. A bug in the difference SQL shows up
// as the two sides disagreeing, so each test computes both and compares.
describe('incremental totals deltas', () => {
  const tempDirs: string[] = []
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function createDb() {
    const dir = mkdtempSync(join(tmpdir(), 'totals-delta-'))
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
       VALUES ('u1','u1@example.test','u1','2026-06-01T00:00:00.000Z','2026-06-01T00:00:00.000Z'),
              ('u2','u2@example.test','u2','2026-06-01T00:00:00.000Z','2026-06-01T00:00:00.000Z');
       -- The totals writers (delta and full refresh alike) gate on the initial backfill having
       -- reached its totals phase; without this row every delta statement is silent.
       INSERT INTO usage_summary_backfill_state (id, phase, completed_at, updated_at)
       VALUES ('initial','totals','2026-06-01T00:00:00.000Z','2026-06-01T00:00:00.000Z');`
    )
    return { db: createSqliteD1(path), path }
  }

  function makeRecord(overrides: Partial<IngestRecord> = {}): IngestRecord {
    return {
      userId: 'u1',
      deviceId: 'dev-a',
      source: 'claude-code',
      usageDate: '2026-06-01',
      timezone: 'UTC',
      model: 'claude-sonnet-4-5',
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 10,
      cacheReadTokens: 5,
      totalTokens: 165,
      costUsd: 0.12,
      sessionCount: 2,
      collectedAt: '2026-06-01T07:00:00.000Z',
      ...overrides
    }
  }

  // The end state the full-refresh path would have written: SUM over summary rows, with the
  // same billable-cost rule (costUnavailableSources contribute 0). Comparing the incrementally
  // maintained row against this is the whole point of the file.
  //
  // The cost column is compared within 1e-9: the delta keeps `stored + (new − stored)`, which is
  // not bit-identical to the full re-derivation's `SUM` for multi-term costs (IEEE-1589
  // associativity), while every integer column is exact either way. This mirrors the accepted
  // production semantics of the incremental path, not a test concession for a real disagreement.
  function expectTotalsMatchFullDerivation(path: string, userId = 'u1') {
    const stored = storedTotals(path, userId)
    const derived = fullDerivation(path, userId)
    expect(stored, `totals row missing for ${userId}`).not.toBeNull()
    expect(stored!.slice(0, 2)).toEqual(derived.slice(0, 2))
    expect(stored![2]).toBeCloseTo(derived[2], 9)
    expect(stored![3]).toEqual(derived[3])
  }

  // runSql's list-mode output ends with an empty line; take the last non-empty one.
  function lastRow(path: string, sql: string) {
    return runSql(path, sql)
      .split('\n')
      .filter((line) => line.trim() !== '')
      .at(-1)!
  }

  function fullDerivation(path: string, userId: string) {
    return lastRow(
      path,
      `SELECT COALESCE(SUM(total_tokens),0),
              COALESCE(SUM(total_tokens_without_cache_read),0),
              COALESCE(SUM(CASE WHEN source IN ('antigravity-cli','antigravity','antigravity-ide','grok-build','deepseek-harness') THEN 0 ELSE cost_usd END),0),
              COALESCE(SUM(session_count),0)
       FROM daily_usage_summary WHERE user_id='${userId}';`
    )
      .split('|')
      .map(Number)
  }

  function storedTotals(path: string, userId = 'u1') {
    const rows = runSql(
      path,
      `SELECT total_tokens, total_tokens_without_cache_read, cost_usd, session_count
       FROM user_usage_totals WHERE user_id='${userId}';`
    )
      .split('\n')
      .filter((line) => line.trim() !== '')
    if (rows.length === 0) return null
    return rows.at(-1)!.split('|').map(Number)
  }

  // A totals row that already exists is what the delta UPDATE adds to. When no row exists the
  // batch falls back to the user's full refresh — the creation path — so the very first upload
  // of a brand-new user must land correct totals without any delta having run.
  test('a first upload creates totals equal to the full derivation', async () => {
    const { db, path } = createDb()
    await upsertUsageSnapshots(db, [makeRecord()])
    expectTotalsMatchFullDerivation(path)
  })

  // The routine case: totals exist, a key moves. The delta must track the summary to its new
  // value and stay exactly equal to the full re-derivation afterwards.
  test('a re-measured key moves totals by the difference only', async () => {
    const { db, path } = createDb()
    await upsertUsageSnapshots(db, [makeRecord()])
    await upsertUsageSnapshots(db, [
      makeRecord({ totalTokens: 300, inputTokens: 235, collectedAt: '2026-06-01T09:00:00.000Z' })
    ])
    expectTotalsMatchFullDerivation(path)
    // The difference really moved the row (165 → 435: 165 + 300 − 165 − 165 would double-count;
    // equality alone cannot tell the delta from a rebuild, so pin the arithmetic).
    expect(storedTotals(path)?.[0]).toBe(300)
  })

  // Same (source, usage_date, model) from two devices: the summary aggregates both, and the
  // second device's key refresh must add only the increase, not the whole second row twice.
  test('two devices sharing a logical key land one correct aggregate', async () => {
    const { db, path } = createDb()
    await upsertUsageSnapshots(db, [makeRecord()])
    await upsertUsageSnapshots(db, [makeRecord({ deviceId: 'dev-b', collectedAt: '2026-06-01T08:00:00.000Z' })])
    expectTotalsMatchFullDerivation(path)
    expect(storedTotals(path)?.[0]).toBe(330)
  })

  // The legacy dedupe rule: a 'legacy' device row is counted only while no non-legacy row
  // exists for the key. After a real device reports the same key, the legacy row leaves the
  // aggregate, and the totals must shrink by exactly that.
  test('a legacy row is dropped from totals once a device row covers the key', async () => {
    const { db, path } = createDb()
    await upsertUsageSnapshots(db, [makeRecord({ deviceId: 'legacy' })])
    expectTotalsMatchFullDerivation(path)
    const legacyTotal = storedTotals(path)?.[0]
    expect(legacyTotal).toBe(165)

    await upsertUsageSnapshots(db, [makeRecord({ deviceId: 'dev-b', collectedAt: '2026-06-01T08:00:00.000Z' })])
    expectTotalsMatchFullDerivation(path)
    // Not 165 + 165: the aggregate is only dev-b's row now.
    expect(storedTotals(path)?.[0]).toBe(165)
  })

  // A correction snapshot carries zero tokens and a remainder cost. It creates a summary row
  // whose only contribution is cost, and the totals must pick up exactly that cost — the
  // session-only preservation rule must not let it double, either.
  test('a codex correction contributes its cost to totals', async () => {
    const { db, path } = createDb()
    await upsertUsageSnapshots(db, [makeRecord({ source: 'codex', model: 'gpt-5', costUsd: 0.4 })])
    await upsertUsageSnapshots(db, [
      makeRecord({
        source: 'codex',
        model: 'gpt-5',
        correction: 'codex-context-pricing',
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        costUsd: 0.05,
        sessionCount: 0,
        collectedAt: '2026-06-01T08:00:00.000Z'
      })
    ])
    expectTotalsMatchFullDerivation(path)
  })

  // A codex session-only report (all token columns zero, sessions > 0) over a row that has
  // tokens: the preservation rule keeps the stored tokens, so the refreshed aggregate — and the
  // delta that follows it — must change nothing on the token columns while the session count
  // still moves. A delta built from the *payload* instead of the stored aggregate would zero
  // the totals' tokens here.
  test('a codex session-only report preserves row tokens in totals', async () => {
    const { db, path } = createDb()
    await upsertUsageSnapshots(db, [makeRecord({ source: 'codex', model: 'gpt-5' })])
    await upsertUsageSnapshots(db, [
      makeRecord({
        source: 'codex',
        model: 'gpt-5',
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        sessionCount: 1,
        collectedAt: '2026-06-01T08:00:00.000Z'
      })
    ])
    expectTotalsMatchFullDerivation(path)
    expect(storedTotals(path)?.[0]).toBe(165)
  })

  // The B5 guard path meets the delta: an identical re-upload refreshes nothing, so it must
  // write neither a summary row nor a totals difference — and the totals stamps stay put.
  test('an identical re-upload leaves totals byte-identical', async () => {
    const { db, path } = createDb()
    await upsertUsageSnapshots(db, [makeRecord()])
    const before = runSql(
      path,
      `SELECT total_tokens, total_tokens_without_cache_read, cost_usd, session_count, updated_at
       FROM user_usage_totals WHERE user_id='u1';`
    ).trim()

    await upsertUsageSnapshots(db, [makeRecord({ collectedAt: '2026-06-01T09:00:00.000Z' })])

    expect(
      runSql(
        path,
        `SELECT total_tokens, total_tokens_without_cache_read, cost_usd, session_count, updated_at FROM user_usage_totals WHERE user_id='u1';`
      ).trim()
    ).toBe(before)
  })

  // Many keys in one batch, straddling the15-key delta chunk: a difference statement that
  // mis-joins a key onto the wrong totals row (or drops the user split) shows up only with
  // two users and enough keys to chunk.
  test("a large mixed batch keeps every user's totals exact", async () => {
    const { db, path } = createDb()
    const records: IngestRecord[] = []
    for (let index = 0; index < 20; index += 1) {
      records.push(
        makeRecord({
          userId: index % 2 === 0 ? 'u1' : 'u2',
          usageDate: `2026-06-${String((index % 28) + 1).padStart(2, '0')}`,
          model: `model-${index}`,
          totalTokens: 100 + index,
          inputTokens: 100 + index,
          collectedAt: `2026-06-01T0${index % 10}:00:00.000Z`
        })
      )
    }
    await upsertUsageSnapshots(db, records)
    // Second pass changes every key's value again, so deltas run over an existing totals row.
    await upsertUsageSnapshots(
      db,
      records.map((record, index) => ({
        ...record,
        totalTokens: record.totalTokens + 50,
        collectedAt: `2026-06-02T0${index % 10}:00:00.000Z`
      }))
    )
    expectTotalsMatchFullDerivation(path, 'u1')
    expectTotalsMatchFullDerivation(path, 'u2')
  })

  // Cost-unavailable sources: the stored daily_usage row keeps the client's self-reported cost
  // (older antigravity rows genuinely carried one — migration 0038 exists for exactly that),
  // while every aggregate writes the *billable* cost, which forces those sources to zero. A
  // delta built on raw cost instead of billable cost inflates the totals' cost here, so the
  // fixture must carry a positive raw cost; with zero both formulas agree and the test is vacuous.
  test('cost-unavailable sources contribute zero cost to the delta', async () => {
    const { db, path } = createDb()
    await upsertUsageSnapshots(db, [makeRecord()])
    await upsertUsageSnapshots(db, [
      makeRecord({ source: 'antigravity', model: 'gemini', costUsd: 3.5, collectedAt: '2026-06-01T08:00:00.000Z' })
    ])
    expectTotalsMatchFullDerivation(path)
    // Explicitly: the antigravity row added tokens and sessions but no billable cost.
    expect(storedTotals(path)?.[2]).toBe(0.12)
    expect(storedTotals(path)?.[0]).toBe(330)
    // And the second batch was a delta, not a rebuild: without the totals row existing after
    // batch one, this would silently take the full-refresh path instead.
    expect(runSql(path, "SELECT COUNT(*) FROM user_usage_totals WHERE user_id='u1';").trim()).toBe('1')
  })

  // The backfill gate re-checked inside the derived transaction: while the initial backfill has
  // not reached its totals phase, a delta UPDATE must leave a pre-seeded totals row alone (the
  // backfill itself will re-derive from the complete summaries).
  test('no delta lands while the initial backfill has not reached totals', async () => {
    const { db, path } = createDb()
    runSql(
      path,
      `UPDATE usage_summary_backfill_state SET phase='summaries', completed_at=NULL WHERE id='initial';
       INSERT INTO user_usage_totals (user_id, total_tokens, total_tokens_without_cache_read, cost_usd, session_count, updated_at)
       VALUES ('u1',0,0,0,0,'2026-06-01T00:00:00.000Z');`
    )
    await upsertUsageSnapshots(db, [makeRecord()])
    expect(storedTotals(path)).toEqual([0, 0, 0, 0])
    // The summary itself is still written — only the totals writers are gated.
    expect(Number(runSql(path, `SELECT COUNT(*) FROM daily_usage_summary WHERE user_id='u1';`).trim())).toBe(1)
  })

  // The EQP premise of the whole chunk: the difference statement must seek the summary
  // PRIMARY KEY per new key (4-column prefix), the daily_usage logical-key index, and the
  // totals row — not scan any of the three tables. (`SCAN newkeys` / `SCAN 15 CONSTANT ROWS`
  // in the plan are the bounded VALUES CTE.) If the planner regresses, B2's saved reads come
  // back as scan cost.
  test('the delta statement seeks every aggregate index', () => {
    const dir = mkdtempSync(join(tmpdir(), 'totals-delta-eqp-'))
    tempDirs.push(dir)
    const path = join(dir, 'tokenboard.db')
    for (const file of readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .sort()) {
      runSql(path, readFileSync(join(migrationsDir, file), 'utf8'))
    }
    const plan = runSql(path, `EXPLAIN QUERY PLAN ${totalsDeltaSql(15)}`)

    expect(plan).toContain(
      'SEARCH user_usage_totals USING COVERING INDEX sqlite_autoindex_user_usage_totals_1 (user_id=?)'
    )
    expect(plan).toContain(
      'SEARCH daily_usage_summary USING INDEX sqlite_autoindex_daily_usage_summary_1 (user_id=? AND usage_date=? AND source=? AND model=?)'
    )
    expect(plan).toContain('SEARCH new_usage USING INDEX daily_usage_logical_key_device_idx')
    expect(plan).not.toMatch(/SCAN (?:daily_usage_summary|daily_usage|user_usage_totals)\b/)
  })
})
