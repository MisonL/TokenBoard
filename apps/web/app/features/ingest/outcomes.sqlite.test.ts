import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { createSqliteD1, runSql } from '../../test/sqlite-d1'
import { upsertUsageSnapshots, type IngestRecord } from './repository'
import { classifyUnchangedRecords, classifyUnchangedRow, type StoredRow } from './repository/outcomes'
import { snapshotHash } from './repository/types'

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations')

// The upsert's WHERE clause can skip a row silently, and a client that acks cursors on
// "the batch returned 200" would then drop that row's data for good. `outcomes` names every
// unwritten row so the client can tell delivered-and-unchanged (`same`, `protected`) from
// not-delivered (`stale`, `unknown`). These tests run the real statements against real SQLite
// so the classification is verified against the SQL that actually decided the skip — a mocked
// D1 cannot make that claim.
describe('ingest row outcomes', () => {
  const tempDirs: string[] = []
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  test('a re-uploaded identical snapshot reports same', async () => {
    const { db } = createDb(tempDirs)
    const record = makeRecord()
    await upsertUsageSnapshots(db, [record])

    const retry = await upsertUsageSnapshots(db, [record])

    expect(retry).toEqual({ upserted: 0, outcomes: [{ index: 0, status: 'same' }] })
  })

  test('a Codex all-zero report against a stored row with usage reports protected', async () => {
    const { db } = createDb(tempDirs)
    const stored = makeRecord({ source: 'codex', collectedAt: '2026-04-28T08:00:00.000Z' })
    await upsertUsageSnapshots(db, [stored])

    const nothing = await upsertUsageSnapshots(db, [
      makeRecord({
        source: 'codex',
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        sessionCount: 0,
        collectedAt: '2026-04-28T09:00:00.000Z'
      })
    ])

    expect(nothing).toEqual({ upserted: 0, outcomes: [{ index: 0, status: 'protected' }] })
  })

  // The session-only CASE guard *writes* (session_count and hash land), so it reports
  // upserted and never reaches the classifier. If that CASE guard were ever changed to skip
  // instead, this row would classify `unknown`, not `protected` — the WHERE-clause half only
  // covers the all-zero report — which is the fail-closed behaviour the client wants anyway.
  test('a Codex session-only report that preserves tokens still counts as written', async () => {
    const { db } = createDb(tempDirs)
    const stored = makeRecord({ source: 'codex', collectedAt: '2026-04-28T08:00:00.000Z' })
    await upsertUsageSnapshots(db, [stored])

    const sessionOnly = await upsertUsageSnapshots(db, [
      makeRecord({
        source: 'codex',
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        sessionCount: 4,
        collectedAt: '2026-04-28T09:00:00.000Z'
      })
    ])

    expect(sessionOnly).toEqual({ upserted: 1, outcomes: [] })
  })

  test('an older collectedAt against a newer stored row reports stale', async () => {
    const { db } = createDb(tempDirs)
    const newer = makeRecord({ collectedAt: '2026-04-28T09:00:00.000Z' })
    await upsertUsageSnapshots(db, [newer])

    const older = await upsertUsageSnapshots(db, [
      makeRecord({ totalTokens: 100, collectedAt: '2026-04-28T08:00:00.000Z' })
    ])

    expect(older).toEqual({ upserted: 0, outcomes: [{ index: 0, status: 'stale' }] })
  })

  test('outcomes carry the index in the posted array, not the position inside the batch', async () => {
    const { db } = createDb(tempDirs)
    const same = makeRecord({ model: 'm-same', collectedAt: '2026-04-28T08:00:00.000Z' })
    const written = makeRecord({ model: 'm-new', collectedAt: '2026-04-28T08:00:00.000Z' })
    // Stored first with a newer collectedAt, so the batch's third row (same key, older
    // collection time, different metrics) meets the freshness guard and must report stale.
    const staleSeed = makeRecord({
      model: 'm-stale',
      totalTokens: 265,
      collectedAt: '2026-04-28T09:00:00.000Z'
    })
    const stale = makeRecord({
      model: 'm-stale',
      totalTokens: 100,
      collectedAt: '2026-04-28T08:00:00.000Z'
    })
    await upsertUsageSnapshots(db, [same, staleSeed])

    const mixed = await upsertUsageSnapshots(db, [same, written, stale])

    expect(mixed).toEqual({
      upserted: 1,
      outcomes: [
        { index: 0, status: 'same' },
        { index: 2, status: 'stale' }
      ]
    })
  })

  // SQL decides freshness with julianday, which resolves sub-millisecond fractions that
  // Date.parse truncates: a stored `.000900Z` beats an incoming `.000Z` (the upsert skips)
  // while both parse to the same millisecond. That is still a newer stored row — stale,
  // with the clock warning — not an unexplained `unknown`.
  test('a sub-millisecond newer stored row still reports stale', async () => {
    const { db } = createDb(tempDirs)
    const stored = makeRecord({ totalTokens: 265, collectedAt: '2026-04-28T09:00:00.000900Z' })
    await upsertUsageSnapshots(db, [stored])

    const truncated = await upsertUsageSnapshots(db, [
      makeRecord({ totalTokens: 100, collectedAt: '2026-04-28T09:00:00.000Z' })
    ])

    expect(truncated).toEqual({ upserted: 0, outcomes: [{ index: 0, status: 'stale' }] })
  })

  // The stored-row lookup queries per (user, device); the classifier must key its map the
  // same way. A batch mixing devices (possible through direct repository callers) would
  // otherwise let one device's row explain the other's skip and acknowledge it as `same`.
  test('records from different devices do not share stored rows', async () => {
    const { db } = createDb(tempDirs)
    // Device B's stored measurement is exactly what device A's stale re-send carries.
    // A classifier that dropped the device from its key would let B's row explain A's
    // skip as `same` — the wrong status — instead of the freshness skip it really was.
    const deviceA = makeRecord({ deviceId: 'dev-a', model: 'shared', totalTokens: 265 })
    const deviceB = makeRecord({
      deviceId: 'dev-b',
      model: 'shared',
      totalTokens: 100,
      collectedAt: '2026-04-28T06:00:00.000Z'
    })
    await upsertUsageSnapshots(db, [deviceA])
    await upsertUsageSnapshots(db, [deviceB])

    const aOlder = makeRecord({
      deviceId: 'dev-a',
      model: 'shared',
      totalTokens: 100,
      collectedAt: '2026-04-28T06:00:00.000Z'
    })
    const result = await upsertUsageSnapshots(db, [aOlder, deviceB])

    expect(result).toEqual({
      upserted: 0,
      outcomes: [
        { index: 0, status: 'stale' },
        { index: 1, status: 'same' }
      ]
    })
  })

  // Two rows for one key inside a single statement batch: the first insert wins, and the
  // second meets the row the same batch just wrote. It skipped for freshness, so the outcome
  // must say stale (not delivered) — acking it would discard a real measurement.
  test('a same-key second row beaten by the first row of the batch reports stale', async () => {
    const { db } = createDb(tempDirs)
    const first = makeRecord({ totalTokens: 265, collectedAt: '2026-04-28T09:00:00.000Z' })
    const second = makeRecord({ totalTokens: 100, collectedAt: '2026-04-28T08:00:00.000Z' })

    const result = await upsertUsageSnapshots(db, [first, second])

    expect(result).toEqual({ upserted: 1, outcomes: [{ index: 1, status: 'stale' }] })
  })

  // 40 rows span two upsert batches (30 + 10): the second batch's outcomes must be re-keyed
  // to the posted-array index (30..39), not the batch-relative one.
  test('outcomes keep the posted-array index across upsert batches', async () => {
    const { db } = createDb(tempDirs)
    const records = Array.from({ length: 40 }, (_, index) =>
      makeRecord({ model: `chunk-model-${index}`, totalTokens: 165 + index })
    )
    await upsertUsageSnapshots(db, records)

    const retry = await upsertUsageSnapshots(db, records)

    expect(retry.upserted).toBe(0)
    expect(retry.outcomes).toHaveLength(40)
    expect(retry.outcomes.every((outcome) => outcome.status === 'same')).toBe(true)
    expect(retry.outcomes.map((outcome) => outcome.index)).toEqual(Array.from({ length: 40 }, (_, i) => i))
  })

  // The classifier's stored-row lookup chunks at 32 keys. The upsert path never reaches that
  // (batches are 30 wide), but direct callers may; a broken chunk offset would mis-key every
  // row past the first chunk.
  test('stored-row lookup covers more than one query chunk', async () => {
    const { db } = createDb(tempDirs)
    const records = Array.from({ length: 40 }, (_, index) =>
      makeRecord({ model: `lookup-model-${index}`, totalTokens: 165 + index })
    )
    await upsertUsageSnapshots(db, records)

    const outcomes = await classifyUnchangedRecords(
      db,
      records,
      await Promise.all(records.map((record) => snapshotHash(record)))
    )

    expect(outcomes).toHaveLength(40)
    expect(outcomes.every((outcome) => outcome.status === 'same')).toBe(true)
  })
})

// The unreachable-by-SQL branch — a skip with no stored row to explain it — is only reachable
// through a racing delete, so it gets a direct unit case instead of an end-to-end one.
describe('classifyUnchangedRow fail-closed cases', () => {
  const record = makeRecord()

  test('a missing stored row is unknown', async () => {
    expect(classifyUnchangedRow(record, await snapshotHash(record), undefined)).toBe('unknown')
  })

  test('an unparseable stored timestamp with an equal-or-older incoming row is unknown', async () => {
    const stored: StoredRow = {
      userId: record.userId,
      deviceId: record.deviceId,
      source: record.source,
      usageDate: record.usageDate,
      model: record.model,
      snapshotHash: 'different-hash',
      syncedAt: 'not-a-timestamp',
      storedHasUsage: 1
    }
    expect(classifyUnchangedRow(record, await snapshotHash(record), stored)).toBe('unknown')
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
  const dir = mkdtempSync(join(tmpdir(), 'tokenboard-outcomes-'))
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
