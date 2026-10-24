import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { createSqliteD1, runSql } from '../../../test/sqlite-d1'
import { findMismatchedUsageTimezones, listActiveUsageTimezones } from './usage-timezone-scope'

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../db/migrations')

// Runs the check against a real D1-shaped SQLite database rather than a stubbed `prepare`, so the
// correlated subquery that scopes the read to the latest usage date is exercised for real.
describe('usage timezone scope against SQLite', () => {
  const tempDirs: string[] = []
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  test('reads only the newest usage date, so an abandoned zone stops warning', async () => {
    const { db, path } = createDb(tempDirs)
    insertUsage(path, [
      ['2026-05-01', 'Asia/Shanghai'],
      ['2026-05-02', 'America/Los_Angeles']
    ])

    // The Shanghai row is older history; the collector has since been reinstalled in Los Angeles.
    expect(await listActiveUsageTimezones(db, 'u1')).toEqual(['America/Los_Angeles'])
    expect(findMismatchedUsageTimezones('America/Los_Angeles', await listActiveUsageTimezones(db, 'u1'))).toEqual([])
  })

  test('reports the disagreement a moved user actually hits', async () => {
    const { db, path } = createDb(tempDirs)
    insertUsage(path, [['2026-05-02', 'Asia/Shanghai']])

    const zones = await listActiveUsageTimezones(db, 'u1')

    expect(zones).toEqual(['Asia/Shanghai'])
    expect(findMismatchedUsageTimezones('America/Los_Angeles', zones)).toEqual(['Asia/Shanghai'])
  })

  test('does not read another user rows', async () => {
    const { db, path } = createDb(tempDirs)
    insertUsage(path, [['2026-05-02', 'Asia/Shanghai']])
    runSql(
      path,
      `
      INSERT INTO daily_usage (user_id, device_id, source, usage_date, timezone, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, total_tokens, cost_usd, session_count, snapshot_hash, synced_at)
      VALUES ('u2','d2','codex','2026-05-02','Europe/Paris','m',1,1,0,0,2,0,1,'h2','2026-05-02T10:00:00Z');
    `
    )

    expect(await listActiveUsageTimezones(db, 'u1')).toEqual(['Asia/Shanghai'])
  })

  test('returns nothing for a user with no usage', async () => {
    const { db } = createDb(tempDirs)

    expect(await listActiveUsageTimezones(db, 'u1')).toEqual([])
  })
})

function createDb(tempDirs: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'tokenboard-tzscope-'))
  tempDirs.push(dir)
  const path = join(dir, 'test.sqlite')
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
  runSql(path, files.map((file) => `.read ${join(migrationsDir, file)}`).join('\n'))
  runSql(
    path,
    `
    INSERT INTO profiles (user_id, slug, display_name, timezone, timezone_source, is_public, participates_in_leaderboards, created_at, updated_at)
    VALUES ('u1','eve','Eve','America/Los_Angeles','user',0,0,'2026-01-01','2026-01-01');
  `
  )
  return { path, db: createSqliteD1(path) }
}

function insertUsage(dbPath: string, rows: Array<[string, string]>) {
  for (const [usageDate, timezone] of rows) {
    runSql(
      dbPath,
      `
      INSERT INTO daily_usage (user_id, device_id, source, usage_date, timezone, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, total_tokens, cost_usd, session_count, snapshot_hash, synced_at)
      VALUES ('u1','d1','claude-code','${usageDate}','${timezone}','m',100,10,0,0,110,1.0,1,'h-${usageDate}','${usageDate}T10:00:00Z');
    `
    )
  }
}
