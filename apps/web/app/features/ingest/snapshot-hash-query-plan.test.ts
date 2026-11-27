import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { createSqliteD1, runSql } from '../../test/sqlite-d1'
import { snapshotHashKeyQuerySql } from './repository/snapshot-hashes'
import { findExistingSnapshotHashes } from './repository'

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations')

// The check endpoint runs its key filter on every batch the client sends, so its query
// shape decides whether a re-sync costs one row per key or the device's whole history:
// an OR chain of `(source = ? AND usage_date = ? AND model = ?)` is only sargable on
// `daily_usage_user_device_date_idx(user_id, device_id, usage_date)` and then filters
// every stored date. Pinned here, against a database built from the real migrations:
//
//   1. the planner seeks `daily_usage_logical_key_device_idx` for every column tuple;
//2. the row-value form returns exactly the requested keys and nothing else, so the
//      optimisation cannot silently change what the endpoint reports.
describe('snapshot hash key query plan', () => {
  const tempDirs: string[] = []
  const cleanup = () => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  }

  function createDb() {
    const dir = mkdtempSync(join(tmpdir(), 'snapshot-hash-plan-'))
    tempDirs.push(dir)
    const path = join(dir, 'tokenboard.db')
    for (const file of readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .sort()) {
      runSql(path, readFileSync(join(migrationsDir, file), 'utf8'))
    }
    return { db: createSqliteD1(path), path }
  }

  test('seeks the full logical key index instead of a device date scan', () => {
    const { path } = createDb()
    const sql = snapshotHashKeyQuerySql(30)

    const plan = runSql(path, `EXPLAIN QUERY PLAN ${sql}`)

    expect(plan).toContain('daily_usage_logical_key_device_idx')
    expect(plan).not.toContain('daily_usage_user_device_date_idx')
    cleanup()
  })

  test('the OR-chain shape it replaced would have used the device date index', () => {
    // Guards the premise of the rewrite: the assertion above would also pass on a
    // database where no index serves either form, which would mean the optimisation
    // bought nothing. This proves the old shape really was the wider scan.
    const { path } = createDb()
    const predicates = Array.from({ length: 30 }, () => '(source = ? AND usage_date = ? AND model = ?)').join(' OR ')

    const plan = runSql(
      path,
      `EXPLAIN QUERY PLAN SELECT source, usage_date, model, snapshot_hash FROM daily_usage
        WHERE user_id = ? AND device_id = ? AND snapshot_hash IS NOT NULL AND (${predicates})`
    )

    expect(plan).toContain('daily_usage_user_device_date_idx')
    cleanup()
  })

  test('returns exactly the requested keys', async () => {
    const { db, path } = createDb()
    const now = '2026-11-25T02:00:00.000Z'
    runSql(
      path,
      `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ('u1','u1@example.com','u1','${now}','${now}');`
    )
    const insert = (deviceId: string, source: string, usageDate: string, model: string, hash: string) =>
      runSql(
        path,
        `INSERT INTO daily_usage (user_id, device_id, source, usage_date, timezone, model, input_tokens,
           output_tokens, cache_creation_tokens, cache_read_tokens, total_tokens, cost_usd, session_count,
           snapshot_hash, synced_at)
         VALUES ('u1','${deviceId}','${source}','${usageDate}','UTC','${model}',1,2,3,4,10,0.01,1,'${hash}','${now}');`
      )

    insert('dev-a', 'codex', '2026-11-20', 'gpt-5', 'hash-requested')
    // Same source/date, different model: must not be reported for the requested key.
    insert('dev-a', 'codex', '2026-11-20', 'gpt-5-mini', 'hash-other-model')
    // Same key on another device: the check is scoped per device.
    insert('dev-b', 'codex', '2026-11-20', 'gpt-5', 'hash-other-device')
    // Same source/model, another date: outside the tuple.
    insert('dev-a', 'codex', '2026-11-21', 'gpt-5', 'hash-other-date')

    const rows = await findExistingSnapshotHashes(db, {
      userId: 'u1',
      deviceId: 'dev-a',
      keys: [{ source: 'codex', usageDate: '2026-11-20', model: 'gpt-5' }]
    })

    // The summary cache is unseeded, so the freshness filter reports the key as stale and
    // nothing is claimed as delivered; the raw tuple match is what this test measures.
    const raw = await db
      .prepare(snapshotHashKeyQuerySql(1))
      .bind('u1', 'dev-a', 'codex', '2026-11-20', 'gpt-5')
      .all<{ source: string; usageDate: string; model: string; snapshotHash: string }>()

    expect(raw.results).toEqual([
      { source: 'codex', usageDate: '2026-11-20', model: 'gpt-5', snapshotHash: 'hash-requested' }
    ])
    expect(rows).toEqual([])
    cleanup()
  })
})
