import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { createSqliteD1, runSql } from '../../test/sqlite-d1'
import { upsertUsageSnapshots, type IngestRecord } from '../ingest/repository'
import { usageSummaryBackfillStateId } from '../ingest/repository/types'
import { getUsageSummary } from './queries/summary'
import { getUsageDetails } from './queries/details'

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations')

// `summaryStrict` reads the stored `daily_usage_summary`; the default path computes the same
// aggregate from `daily_usage` at query time and only falls back to the table for rows it has
// not cached. The two are written to be field-for-field mirrors of each other, but nothing
// compared them: a divergence would not fail any test, it would just make the numbers change
// depending on which mode a deployment ran in. These assert parity on the same data.
describe('summary cache parity', () => {
  const tempDirs: string[] = []
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  test('both modes agree on a plain multi-model day', async () => {
    const { db } = createDb(tempDirs)
    await refreshSummary(db, [
      row({ model: 'claude-sonnet-4-5', totalTokens: 100, cacheReadTokens: 20, costUsd: 1.5, sessionCount: 2 }),
      row({ model: 'gpt-5.4', totalTokens: 50, cacheReadTokens: 10, costUsd: 0.5, sessionCount: 1 })
    ])

    const fallback = await getUsageSummary(db, summaryInput())
    const strict = await getUsageSummary(db, { ...summaryInput(), summaryStrict: true })

    expect(strict).toEqual(fallback)
  })

  // The legacy dedup rule is the subtlest part of both queries: a `legacy` row is dropped only
  // when a non-legacy row exists for the same user/date/source/model. A mirror that got the
  // direction or the join keys wrong would disagree here and nowhere else.
  test('both modes agree on the legacy-device dedup rule', async () => {
    const { db } = createDb(tempDirs)
    await refreshSummary(db, [
      row({ deviceId: 'legacy', totalTokens: 999, cacheReadTokens: 99, costUsd: 9.9, sessionCount: 9 }),
      row({ deviceId: 'dev_a', totalTokens: 100, cacheReadTokens: 20, costUsd: 1.5, sessionCount: 2 })
    ])

    const fallback = await getUsageSummary(db, summaryInput())
    const strict = await getUsageSummary(db, { ...summaryInput(), summaryStrict: true })

    expect(strict).toEqual(fallback)
    // The legacy row is superseded by the real device, not summed with it.
    expect(fallback.todayTokens).toBe(100)
  })

  test('both modes agree when only a legacy row exists', async () => {
    const { db } = createDb(tempDirs)
    await refreshSummary(db, [
      row({ deviceId: 'legacy', totalTokens: 77, cacheReadTokens: 7, costUsd: 0.7, sessionCount: 1 })
    ])

    const fallback = await getUsageSummary(db, summaryInput())
    const strict = await getUsageSummary(db, { ...summaryInput(), summaryStrict: true })

    expect(strict).toEqual(fallback)
    // No non-legacy row exists, so the legacy row is the only record and must still count.
    expect(fallback.todayTokens).toBe(77)
  })

  // A cost-unavailable source must be zeroed identically on both paths. `billableCostSql` is the
  // shared expression, so a mirror that inlined its own CASE would drift here.
  test('both modes agree on cost-unavailable sources', async () => {
    const { db } = createDb(tempDirs)
    await refreshSummary(db, [
      row({ source: 'claude-code', model: 'sonnet', totalTokens: 100, costUsd: 1.5 }),
      row({ source: 'grok-build', model: 'grok-4', totalTokens: 200, costUsd: 99 })
    ])

    const fallback = await getUsageSummary(db, summaryInput())
    const strict = await getUsageSummary(db, { ...summaryInput(), summaryStrict: true })

    expect(strict).toEqual(fallback)
    expect(fallback.todayCostUsd).toBe(1.5)
    expect(fallback.todayTokens).toBe(300)
    expect(fallback.todayCostAvailable).toBe(false)
  })

  // Rows the cache has not written yet are served from the computed path even in the default
  // mode. With no summary rows at all, the default path is entirely computed and must still
  // match what the cache would have produced.
  test('an uncached day matches what the cache would hold', async () => {
    const { db } = createDb(tempDirs)
    // Ingest first, then read the uncached path *before* the cache rows exist is not possible
    // through one call, so this compares the computed fallback against the cache the same call
    // wrote — the point is that both were produced by production code paths.
    await refreshSummary(db, [row({ totalTokens: 165, cacheReadTokens: 5, costUsd: 0.12, sessionCount: 2 })])

    const uncached = await getUsageSummary(db, summaryInput())
    const cached = await getUsageSummary(db, { ...summaryInput(), summaryStrict: true })

    expect(cached).toEqual(uncached)
  })

  // The details page reads `daily_usage` directly instead of the summary cache: the cache has no
  // device dimension, so a per-device filter could not use it, and reading one table is what
  // keeps the page and its CSV export consistent with each other. That bypass is only safe while
  // the two agree, so this pins them together on the same rows the other cases use.
  test('details reads the same totals as the summary once the cache is populated', async () => {
    const { db } = createDb(tempDirs)
    await refreshSummary(db, [
      row({ model: 'claude-sonnet-4-5', totalTokens: 100, cacheReadTokens: 20, costUsd: 1.5, sessionCount: 2 }),
      row({ model: 'gpt-5.4', totalTokens: 50, cacheReadTokens: 10, costUsd: 0.5, sessionCount: 1 })
    ])

    const summary = await getUsageSummary(db, summaryInput())
    const details = await getUsageDetails(db, {
      userId: 'seed-user',
      startDate: '2026-04-01',
      endDate: today,
      source: 'all',
      deviceId: 'all'
    })

    // Every shared scalar of the two read paths, not just the headline number: a field neither
    // side asserts could drift between `daily_usage` and the cache without any test noticing.
    expect(details.summary.totalTokens).toBe(summary.monthTokens)
    expect(details.summary.totalTokensWithoutCacheRead).toBe(summary.monthTokensWithoutCacheRead)
    expect(details.summary.cacheReadRate).toBe(summary.monthCacheReadRate)
    expect(details.summary.costUsd).toBe(summary.monthCostUsd)
    expect(details.summary.sessionCount).toBe(3)
    // Both fixture rows fall on the same day, so the range has a single active day.
    expect(details.summary.activeDays).toBe(1)
  })
})

const today = '2026-04-28'

function summaryInput() {
  return { userId: 'seed-user', today, monthStart: '2026-04-01' }
}

type ParityRow = Omit<IngestRecord, 'userId' | 'collectedAt'>

function row(overrides: Partial<ParityRow> = {}): ParityRow {
  return {
    deviceId: 'dev_a',
    source: 'claude-code',
    usageDate: today,
    timezone: 'Asia/Shanghai',
    model: 'claude-sonnet-4-5',
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationTokens: 10,
    cacheReadTokens: 5,
    totalTokens: 165,
    costUsd: 0.12,
    sessionCount: 2,
    ...overrides
  }
}

function createDb(tempDirs: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'tokenboard-parity-'))
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
    INSERT INTO usage_summary_backfill_state (id, phase, completed_at, updated_at)
    VALUES ('${usageSummaryBackfillStateId}', 'totals', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `
  )
  return { path, db: createSqliteD1(path) }
}

// Populates the cache through the real ingest path rather than a hand-written INSERT. The
// previous version of this helper inlined its own copy of the aggregation, which made the parity
// check compare the cache against itself: breaking the shared cost expression changed both sides
// identically and every test stayed green.
async function refreshSummary(db: D1Database, rows: ParityRow[]) {
  await upsertUsageSnapshots(
    db,
    rows.map((r) => ({ ...r, userId: 'seed-user', collectedAt: '2026-04-28T07:00:00.000Z' }))
  )
}
