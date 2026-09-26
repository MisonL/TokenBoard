import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { createSqliteD1, runSql } from '../../test/sqlite-d1'
import { upsertUsageSnapshots, type IngestRecord } from './repository'

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations')

// Re-uploading is the normal case, not an edge one: a collector retries a batch after a partial
// failure, and a scheduled sync re-sends whatever it re-derived. Two independent guards keep that
// from double-counting, and this file pins both, because either alone looks sufficient until the
// other is removed:
//
//   1. the `WHERE daily_usage.snapshot_hash <> excluded.snapshot_hash` clause skips the update
//      entirely when the row already holds this exact measurement;
//   2. the `CASE WHEN ... ELSE excluded.x END` arms replace rather than add, which is what a
//      *changed* measurement for the same day needs — the collector re-derives a day's totals
//      each scan, so a later upload is the newer value and summing would grow without bound.
describe('ingest idempotency', () => {
  const tempDirs: string[] = []
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  test('re-uploading the identical snapshot does not double-count', async () => {
    const { db, path } = createDb(tempDirs)
    const record = makeRecord()

    await upsertUsageSnapshots(db, [record])
    await upsertUsageSnapshots(db, [record])

    expect(totalTokens(path)).toBe(165)
    expect(rowCount(path)).toBe(1)
  })

  // The same measurement re-sent after its `collectedAt` moved is still the same measurement:
  // the hash covers the metrics, not the timestamp. Without that, every scheduled sync would
  // count the day again.
  test('a re-send with a newer collectedAt is still the same measurement', async () => {
    const { db, path } = createDb(tempDirs)

    await upsertUsageSnapshots(db, [makeRecord({ collectedAt: '2026-04-28T07:00:00.000Z' })])
    await upsertUsageSnapshots(db, [makeRecord({ collectedAt: '2026-04-28T09:30:00.000Z' })])

    expect(totalTokens(path)).toBe(165)
    expect(rowCount(path)).toBe(1)
  })

  // The two guards overlap on totals, so a totals-only assertion cannot tell which one ran —
  // removing the hash short-circuit entirely left every other test in this file green. `synced_at`
  // is written only by the update branch, so it distinguishes them: an identical re-send must
  // leave the row untouched, while a changed measurement must rewrite it.
  test('an identical re-send leaves the stored row untouched', async () => {
    const { db, path } = createDb(tempDirs)

    await upsertUsageSnapshots(db, [makeRecord({ collectedAt: '2026-04-28T07:00:00.000Z' })])
    const firstSyncedAt = scalarText(path, 'SELECT synced_at FROM daily_usage')
    await upsertUsageSnapshots(db, [makeRecord({ collectedAt: '2026-04-28T09:30:00.000Z' })])
    const secondSyncedAt = scalarText(path, 'SELECT synced_at FROM daily_usage')

    expect(secondSyncedAt).toBe(firstSyncedAt)

    // A changed measurement must take the update branch and advance the marker.
    await upsertUsageSnapshots(db, [makeRecord({ totalTokens: 200, collectedAt: '2026-04-28T11:00:00.000Z' })])
    const thirdSyncedAt = scalarText(path, 'SELECT synced_at FROM daily_usage')

    expect(thirdSyncedAt).not.toBe(firstSyncedAt)
  })

  test('a retried batch re-sends stored rows alongside new ones', async () => {
    const { db, path } = createDb(tempDirs)
    const first = makeRecord({ usageDate: '2026-04-27', totalTokens: 100 })
    const second = makeRecord({ usageDate: '2026-04-28', totalTokens: 165 })

    await upsertUsageSnapshots(db, [first])
    await upsertUsageSnapshots(db, [first, second])

    expect(totalTokens(path)).toBe(265)
    expect(rowCount(path)).toBe(2)
  })

  // The collector re-derives a day's totals on every scan, so a changed measurement for the same
  // key must replace the stored one. Summing would make the day grow on every sync.
  test('a changed measurement for the same day replaces rather than accumulates', async () => {
    const { db, path } = createDb(tempDirs)

    await upsertUsageSnapshots(db, [makeRecord({ totalTokens: 165, inputTokens: 100 })])
    await upsertUsageSnapshots(db, [makeRecord({ totalTokens: 200, inputTokens: 135 })])

    expect(totalTokens(path)).toBe(200)
    expect(rowCount(path)).toBe(1)
  })

  test('different models on the same day stay separate rows', async () => {
    const { db, path } = createDb(tempDirs)

    await upsertUsageSnapshots(db, [
      makeRecord({ model: 'claude-sonnet-4-5', totalTokens: 100 }),
      makeRecord({ model: 'gpt-5.4', totalTokens: 50 })
    ])

    expect(rowCount(path)).toBe(2)
    expect(totalTokens(path)).toBe(150)
  })

  // Different devices are different rows under the same user, so one machine re-syncing must not
  // disturb another's totals.
  test('the same day on two devices stays separate', async () => {
    const { db, path } = createDb(tempDirs)

    await upsertUsageSnapshots(db, [makeRecord({ deviceId: 'dev_a', totalTokens: 100 })])
    await upsertUsageSnapshots(db, [makeRecord({ deviceId: 'dev_b', totalTokens: 50 })])

    expect(rowCount(path)).toBe(2)
    expect(totalTokens(path)).toBe(150)
  })
})

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

function createDb(tempDirs: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'tokenboard-idem-'))
  tempDirs.push(dir)
  const path = join(dir, 'test.sqlite')
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
  runSql(path, files.map((file) => `.read ${join(migrationsDir, file)}`).join('\n'))
  runSql(
    path,
    `
    INSERT INTO users (id, email, name, email_verified, created_at, updated_at)
    VALUES ('seed-user','seed@example.com','Seed',0,'2026-01-01','2026-01-01');
    INSERT INTO profiles (user_id, slug, display_name, timezone, timezone_source, is_public, participates_in_leaderboards, created_at, updated_at)
    VALUES ('seed-user','seed','Seed','UTC','default',0,0,'2026-01-01','2026-01-01');
  `
  )
  return { path, db: createSqliteD1(path) }
}

function totalTokens(dbPath: string) {
  return scalar(dbPath, 'SELECT COALESCE(SUM(total_tokens), 0) FROM daily_usage')
}

function rowCount(dbPath: string) {
  return scalar(dbPath, 'SELECT COUNT(*) FROM daily_usage')
}

function scalar(dbPath: string, sql: string) {
  return Number(runSql(dbPath, sql).trim())
}

function scalarText(dbPath: string, sql: string) {
  return runSql(dbPath, sql).trim()
}
