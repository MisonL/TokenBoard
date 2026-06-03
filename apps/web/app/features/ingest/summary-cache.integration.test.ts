import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import worker from '../../server'
import { createSqliteD1, runSql } from '../../test/sqlite-d1'
import { backfillUsageSummaryCache } from './repository'

const currentDir = dirname(fileURLToPath(import.meta.url))
const migrationsDir = resolve(currentDir, '../../../db/migrations')
const verificationDate = new Date('2026-06-02T10:00:00.000Z')

describe('usage summary cache integration', () => {
  const tempDirs: string[] = []

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(verificationDate)
  })

  afterEach(() => {
    vi.useRealTimers()
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('scheduled backfill makes legacy usage visible through public JSON cache queries', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-summary-cache-'))
    tempDirs.push(tempDir)
    const dbPath = join(tempDir, 'tokenboard.db')
    applyMigrations(dbPath)
    const db = createSqliteD1(dbPath)
    const today = toIsoDate(verificationDate)
    const monthStart = `${today.slice(0, 8)}01`
    const todayIncludesBothRows = today === monthStart
    const expectedTodayTokens = todayIncludesBothRows ? 1600 : 1000
    const expectedTodayTokensWithoutCacheRead = todayIncludesBothRows ? 1450 : 900
    const expectedTodayCostUsd = todayIncludesBothRows ? 2.5 : 1.25

    await seedLegacyUsage(db, { today, monthStart })
    await expectScalar(db, 'SELECT COUNT(*) FROM daily_usage_summary', 0)
    await expectScalar(db, 'SELECT COUNT(*) FROM user_usage_totals', 0)

    const ctx = createExecutionContext()
    worker.scheduled?.(
      {
        scheduledTime: Date.parse(`${today}T10:00:00.000Z`),
        cron: '*/15 * * * *',
        noRetry() {}
      },
      createEnv(db),
      ctx
    )
    await Promise.all(ctx.waitUntilPromises)

    await expectScalar(db, 'SELECT COUNT(*) FROM daily_usage_summary', 2)
    await expectScalar(
      db,
      'SELECT total_tokens AS value FROM user_usage_totals WHERE user_id = ?',
      1600,
      ['smoke-user']
    )

    const response = await worker.fetch(
      workerRequest('https://tokenboard.example/api/public/smoke-user.json?cache-bust=summary-cache'),
      createEnv(db),
      createExecutionContext()
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      slug: 'smoke-user',
      displayName: 'Smoke User',
      total: {
        tokens: 1600,
        tokensWithoutCacheRead: 1450,
        costUsd: 2.5
      },
      today: {
        tokens: expectedTodayTokens,
        tokensWithoutCacheRead: expectedTodayTokensWithoutCacheRead,
        costUsd: expectedTodayCostUsd
      },
      month: {
        tokens: 1600,
        tokensWithoutCacheRead: 1450,
        costUsd: 2.5
      },
      sourceSplit: [
        {
          source: 'codex',
          totalTokens: 1000,
          totalTokensWithoutCacheRead: 900
        },
        {
          source: 'claude-code',
          totalTokens: 600,
          totalTokensWithoutCacheRead: 550
        }
      ],
      topModels: [
        {
          model: 'gpt-5',
          totalTokens: 1000,
          totalTokensWithoutCacheRead: 900,
          costUsd: 1.25
        },
        {
          model: 'claude-sonnet-4-5',
          totalTokens: 600,
          totalTokensWithoutCacheRead: 550,
          costUsd: 1.25
        }
      ]
    })
  })

  test('summary cache migration keeps historical usage visible before cron backfill', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-summary-cache-'))
    tempDirs.push(tempDir)
    const dbPath = join(tempDir, 'tokenboard.db')
    applyMigrations(dbPath, false)
    const db = createSqliteD1(dbPath)
    const today = toIsoDate(verificationDate)
    const monthStart = `${today.slice(0, 8)}01`
    const todayIncludesBothRows = today === monthStart
    const expectedTodayTokens = todayIncludesBothRows ? 1600 : 1000
    const expectedTodayTokensWithoutCacheRead = todayIncludesBothRows ? 1450 : 900
    const expectedTodayCostUsd = todayIncludesBothRows ? 2.5 : 1.25

    await seedLegacyUsage(db, { today, monthStart })
    applySummaryCacheMigration(dbPath)

    await expectScalar(db, 'SELECT COUNT(*) FROM daily_usage_summary', 0)
    await expectScalar(db, 'SELECT COUNT(*) FROM user_usage_totals', 0)

    const response = await worker.fetch(
      workerRequest('https://tokenboard.example/api/public/smoke-user.json?cache-bust=migration'),
      createEnv(db),
      createExecutionContext()
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      total: {
        tokens: 1600,
        tokensWithoutCacheRead: 1450,
        costUsd: 2.5
      },
      today: {
        tokens: expectedTodayTokens,
        tokensWithoutCacheRead: expectedTodayTokensWithoutCacheRead,
        costUsd: expectedTodayCostUsd
      },
      month: {
        tokens: 1600,
        tokensWithoutCacheRead: 1450,
        costUsd: 2.5
      }
    })

    const ctx = createExecutionContext()
    worker.scheduled?.(
      {
        scheduledTime: Date.parse(`${today}T10:00:00.000Z`),
        cron: '*/15 * * * *',
        noRetry() {}
      },
      createEnv(db),
      ctx
    )
    await Promise.all(ctx.waitUntilPromises)

    await expectScalar(db, 'SELECT COUNT(*) FROM daily_usage_summary', 2)
    await expectScalar(
      db,
      'SELECT total_tokens AS value FROM user_usage_totals WHERE user_id = ?',
      1600,
      ['smoke-user']
    )
  })

  test('bounded summary backfill delays totals until all historical summaries are present', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-summary-cache-'))
    tempDirs.push(tempDir)
    const dbPath = join(tempDir, 'tokenboard.db')
    applyMigrations(dbPath)
    const db = createSqliteD1(dbPath)
    const today = toIsoDate(verificationDate)
    const monthStart = `${today.slice(0, 8)}01`

    await seedLegacyUsage(db, { today, monthStart })

    const firstPass = await backfillUsageSummaryCache({ db, limit: 1 })

    expect(firstPass).toEqual({ backfilled: 1, totalsRefreshed: 0 })
    await expectScalar(db, 'SELECT COUNT(*) FROM daily_usage_summary', 1)
    await expectScalar(
      db,
      'SELECT COUNT(*) FROM user_usage_totals WHERE user_id = ?',
      0,
      ['smoke-user']
    )
    await expectScalar(
      db,
      'SELECT phase AS value FROM usage_summary_backfill_state WHERE id = ?',
      'summaries',
      ['initial']
    )

    const secondPass = await backfillUsageSummaryCache({ db, limit: 1 })

    expect(secondPass).toEqual({ backfilled: 1, totalsRefreshed: 0 })
    await expectScalar(db, 'SELECT COUNT(*) FROM daily_usage_summary', 2)
    await expectScalar(
      db,
      'SELECT COUNT(*) FROM user_usage_totals WHERE user_id = ?',
      0,
      ['smoke-user']
    )
    await expectScalar(
      db,
      'SELECT phase AS value FROM usage_summary_backfill_state WHERE id = ?',
      'totals',
      ['initial']
    )

    const thirdPass = await backfillUsageSummaryCache({ db, limit: 1 })

    expect(thirdPass).toEqual({ backfilled: 0, totalsRefreshed: 1 })
    await expectScalar(
      db,
      'SELECT total_tokens AS value FROM user_usage_totals WHERE user_id = ?',
      1600,
      ['smoke-user']
    )
    await expectScalar(
      db,
      'SELECT total_tokens_without_cache_read AS value FROM user_usage_totals WHERE user_id = ?',
      1450,
      ['smoke-user']
    )
    await expectScalar(
      db,
      'SELECT completed_at IS NOT NULL AS value FROM usage_summary_backfill_state WHERE id = ?',
      1,
      ['initial']
    )
  })

  test('webhook schedule migration backfills pending retry slots from the original daily schedule', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-webhook-schedule-'))
    tempDirs.push(tempDir)
    const dbPath = join(tempDir, 'tokenboard.db')
    runSql(dbPath, [
      `.read ${quoteSqlitePath(join(migrationsDir, '0000_initial.sql'))}`,
      `.read ${quoteSqlitePath(join(migrationsDir, '0001_devices.sql'))}`,
      `.read ${quoteSqlitePath(join(migrationsDir, '0002_upload_token_device.sql'))}`,
      `.read ${quoteSqlitePath(join(migrationsDir, '0003_better_auth.sql'))}`,
      `.read ${quoteSqlitePath(join(migrationsDir, '0013_webhook_notifications.sql'))}`,
      `
        INSERT INTO webhook_subscriptions (
          id,
          user_id,
          name,
          provider,
          webhook_url_encrypted,
          webhook_url_host,
          webhook_url_masked,
          timezone,
          schedule_time_local,
          next_run_at,
          pending_report_date,
          failure_count,
          created_at,
          updated_at
        )
        VALUES (
          'sub_retry',
          'seed-user',
          'Retry',
          'generic',
          'encrypted',
          'example.com',
          'https://example.com/webhook',
          'UTC',
          '09:30',
          '2026-04-29T10:05:00.000Z',
          '2026-04-29',
          1,
          '2026-04-29T09:31:00.000Z',
          '2026-04-29T09:31:00.000Z'
        );
      `,
      `.read ${quoteSqlitePath(join(migrationsDir, '0014_webhook_schedule_rules.sql'))}`
    ].join('\n'))

    const db = createSqliteD1(dbPath)

    await expectScalar(
      db,
      'SELECT pending_schedule_slot AS value FROM webhook_subscriptions WHERE id = ?',
      '2026-04-29T09:30',
      ['sub_retry']
    )
  })

  test('follow-up webhook migration repairs pending retry slots for databases that already ran 0014', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-webhook-schedule-'))
    tempDirs.push(tempDir)
    const dbPath = join(tempDir, 'tokenboard.db')
    runSql(dbPath, [
      `.read ${quoteSqlitePath(join(migrationsDir, '0000_initial.sql'))}`,
      `.read ${quoteSqlitePath(join(migrationsDir, '0001_devices.sql'))}`,
      `.read ${quoteSqlitePath(join(migrationsDir, '0002_upload_token_device.sql'))}`,
      `.read ${quoteSqlitePath(join(migrationsDir, '0003_better_auth.sql'))}`,
      `.read ${quoteSqlitePath(join(migrationsDir, '0013_webhook_notifications.sql'))}`,
      `.read ${quoteSqlitePath(join(migrationsDir, '0014_webhook_schedule_rules.sql'))}`,
      `
        INSERT INTO webhook_subscriptions (
          id,
          user_id,
          name,
          provider,
          webhook_url_encrypted,
          webhook_url_host,
          webhook_url_masked,
          timezone,
          schedule_time_local,
          schedule_times_local,
          schedule_weekdays,
          next_run_at,
          pending_report_date,
          pending_schedule_slot,
          failure_count,
          created_at,
          updated_at
        )
        VALUES (
          'sub_old_0014',
          'seed-user',
          'Old 0014',
          'generic',
          'encrypted',
          'example.com',
          'https://example.com/webhook',
          'UTC',
          '09:30',
          '09:30,18:00',
          '0,1,2,3,4,5,6',
          '2026-04-29T10:05:00.000Z',
          '2026-04-29',
          NULL,
          1,
          '2026-04-29T09:31:00.000Z',
          '2026-04-29T09:31:00.000Z'
        );
      `,
      `.read ${quoteSqlitePath(join(migrationsDir, '0019_backfill_webhook_pending_schedule_slots.sql'))}`
    ].join('\n'))

    const db = createSqliteD1(dbPath)

    await expectScalar(
      db,
      'SELECT pending_schedule_slot AS value FROM webhook_subscriptions WHERE id = ?',
      '2026-04-29T09:30',
      ['sub_old_0014']
    )
  })
})

function applyMigrations(dbPath: string, includeSummaryCache = true) {
  const migrations = [
    `.read ${quoteSqlitePath(join(migrationsDir, '0000_initial.sql'))}`,
    `.read ${quoteSqlitePath(join(migrationsDir, '0001_devices.sql'))}`,
    `.read ${quoteSqlitePath(join(migrationsDir, '0002_upload_token_device.sql'))}`,
    `.read ${quoteSqlitePath(join(migrationsDir, '0003_better_auth.sql'))}`,
    `.read ${quoteSqlitePath(join(migrationsDir, '0004_daily_usage_device.sql'))}`,
    `.read ${quoteSqlitePath(join(migrationsDir, '0005_leaderboard_public_profiles.sql'))}`,
    `.read ${quoteSqlitePath(join(migrationsDir, '0006_default_public_leaderboards.sql'))}`,
    `.read ${quoteSqlitePath(join(migrationsDir, '0007_daily_usage_snapshot_hash.sql'))}`,
    `.read ${quoteSqlitePath(join(migrationsDir, '0008_dedupe_legacy_daily_usage.sql'))}`,
    `.read ${quoteSqlitePath(join(migrationsDir, '0009_profile_timezone_source.sql'))}`,
    `.read ${quoteSqlitePath(join(migrationsDir, '0010_default_utc_timezone_source.sql'))}`,
    `.read ${quoteSqlitePath(join(migrationsDir, '0011_preserve_legacy_utc_timezone.sql'))}`,
    `.read ${quoteSqlitePath(join(migrationsDir, '0012_public_card_config.sql'))}`,
    `.read ${quoteSqlitePath(join(migrationsDir, '0013_webhook_notifications.sql'))}`,
    `.read ${quoteSqlitePath(join(migrationsDir, '0014_webhook_schedule_rules.sql'))}`,
    `.read ${quoteSqlitePath(join(migrationsDir, '0015_daily_report_history.sql'))}`
  ]
  if (includeSummaryCache) {
    migrations.push(summaryCacheMigrationCommand())
    migrations.push(refreshSummaryCacheMigrationCommand())
    migrations.push(summaryBackfillStateMigrationCommand())
  }
  runSql(dbPath, migrations.join('\n'))
}

function applySummaryCacheMigration(dbPath: string) {
  runSql(dbPath, [
    summaryCacheMigrationCommand(),
    refreshSummaryCacheMigrationCommand(),
    summaryBackfillStateMigrationCommand()
  ].join('\n'))
}

function summaryCacheMigrationCommand() {
  return `.read ${quoteSqlitePath(join(migrationsDir, '0016_usage_summary_cache.sql'))}`
}

function refreshSummaryCacheMigrationCommand() {
  return `.read ${quoteSqlitePath(join(migrationsDir, '0017_refresh_usage_summary_cache.sql'))}`
}

function summaryBackfillStateMigrationCommand() {
  return `.read ${quoteSqlitePath(join(migrationsDir, '0018_usage_summary_backfill_state.sql'))}`
}

async function seedLegacyUsage(
  db: D1Database,
  dates: {
    today: string
    monthStart: string
  }
) {
  await db
    .prepare(
      `
        INSERT INTO users (id, email, name, image, created_at, updated_at, email_verified)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `
    )
    .bind(
      'smoke-user',
      null,
      'Smoke User',
      null,
      '2026-04-28T00:00:00.000Z',
      '2026-04-28T00:00:00.000Z',
      0
    )
    .run()

  await db
    .prepare(
      `
        INSERT INTO profiles (
          user_id,
          slug,
          display_name,
          timezone,
          is_public,
          participates_in_leaderboards,
          created_at,
          updated_at,
          timezone_source
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .bind(
      'smoke-user',
      'smoke-user',
      'Smoke User',
      'UTC',
      1,
      1,
      '2026-04-28T00:00:00.000Z',
      '2026-04-28T00:00:00.000Z',
      'user'
    )
    .run()

  await db
    .prepare(
      `
        INSERT INTO daily_usage (
          user_id,
          device_id,
          source,
          usage_date,
          timezone,
          model,
          input_tokens,
          output_tokens,
          cache_creation_tokens,
          cache_read_tokens,
          total_tokens,
          cost_usd,
          session_count,
          snapshot_hash,
          synced_at
        )
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .bind(
      'smoke-user',
      'legacy',
      'codex',
      dates.today,
      'UTC',
      'gpt-5',
      700,
      200,
      0,
      100,
      1000,
      1.25,
      3,
      null,
      '2026-04-29T10:00:00.000Z',
      'smoke-user',
      'legacy',
      'claude-code',
      dates.monthStart,
      'UTC',
      'claude-sonnet-4-5',
      400,
      150,
      0,
      50,
      600,
      1.25,
      2,
      null,
      '2026-04-29T10:00:00.000Z'
    )
    .run()
}

async function expectScalar(
  db: D1Database,
  sql: string,
  expected: unknown,
  bindings: unknown[] = []
) {
  const row = await db.prepare(sql).bind(...bindings).first<{ value: unknown }>()
  expect(row?.value).toBe(expected)
}

function toIsoDate(date: Date) {
  return date.toISOString().slice(0, 10)
}

function quoteSqlitePath(path: string) {
  return `'${path.replaceAll("'", "''")}'`
}

function createEnv(db: D1Database) {
  return {
    DB: db,
    ASSETS: {
      fetch: async () => new Response('asset response')
    },
    BETTER_AUTH_URL: 'https://tokenboard.example'
  }
}

function createExecutionContext() {
  const waitUntilPromises: Promise<unknown>[] = []
  return {
    waitUntil(promise: Promise<unknown>) {
      waitUntilPromises.push(promise)
    },
    passThroughOnException() {},
    props: {},
    waitUntilPromises
  } as ExecutionContext & { waitUntilPromises: Promise<unknown>[] }
}

function workerRequest(url: string) {
  return new Request(url) as Parameters<typeof worker.fetch>[0]
}
