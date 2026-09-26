import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createSqliteD1, runSql } from '../test/sqlite-d1'
import {
  assertRateLimitAvailable,
  clientIpRateLimitSubject,
  enforceRateLimit,
  pruneExpiredRateLimits,
  type RateLimitPolicy
} from './rate-limit'

describe('D1 rate limiter', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('blocks requests after the fixed window budget is exhausted', async () => {
    const db = createRateLimitDb(tempDirs)
    const policy: RateLimitPolicy = {
      id: 'ingest',
      maxRequests: 2,
      windowSeconds: 60
    }
    const now = new Date('2026-06-11T00:00:00.000Z')

    await expect(
      enforceRateLimit(db, {
        policy,
        subject: { kind: 'upload-token', value: 'secret-token-hash' },
        now
      })
    ).resolves.toMatchObject({ remaining: 1 })
    await expect(
      enforceRateLimit(db, {
        policy,
        subject: { kind: 'upload-token', value: 'secret-token-hash' },
        now
      })
    ).resolves.toMatchObject({ remaining: 0 })

    await expect(
      enforceRateLimit(db, {
        policy,
        subject: { kind: 'upload-token', value: 'secret-token-hash' },
        now
      })
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      headers: { 'Retry-After': '60' }
    })
  })

  test('checks an exhausted window without updating its stored timestamp', async () => {
    const db = createRateLimitDb(tempDirs)
    const policy: RateLimitPolicy = {
      id: 'read-only-check',
      maxRequests: 1,
      windowSeconds: 60
    }
    const now = new Date('2026-06-11T00:00:00.000Z')

    await enforceRateLimit(db, {
      policy,
      subject: { kind: 'ip', value: 'read-only-check' },
      now
    })
    const before = await db
      .prepare('SELECT count, reset_at AS resetAt, updated_at AS updatedAt FROM api_rate_limits LIMIT 1')
      .bind()
      .first<{ count: number; resetAt: string; updatedAt: string }>()

    await expect(
      assertRateLimitAvailable(db, {
        policy,
        subject: { kind: 'ip', value: 'read-only-check' },
        now
      })
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 })

    const after = await db
      .prepare('SELECT count, reset_at AS resetAt, updated_at AS updatedAt FROM api_rate_limits LIMIT 1')
      .bind()
      .first<{ count: number; resetAt: string; updatedAt: string }>()
    expect(after).toEqual(before)
  })

  test('resets the budget after the fixed window expires and does not store raw subjects', async () => {
    const db = createRateLimitDb(tempDirs)
    const policy: RateLimitPolicy = {
      id: 'device-pair',
      maxRequests: 1,
      windowSeconds: 60
    }

    await enforceRateLimit(db, {
      policy,
      subject: { kind: 'ip', value: '203.0.113.10' },
      now: new Date('2026-06-11T00:00:00.000Z')
    })
    const result = await enforceRateLimit(db, {
      policy,
      subject: { kind: 'ip', value: '203.0.113.10' },
      now: new Date('2026-06-11T00:01:00.000Z')
    })
    const row = await db.prepare('SELECT key FROM api_rate_limits LIMIT 1').bind().first<{ key: string }>()

    expect(result.remaining).toBe(0)
    expect(row?.key).toMatch(/^rl:v1:device-pair:ip:/)
    expect(row?.key).not.toContain('203.0.113.10')
  })

  test('prunes expired windows without deleting active windows', async () => {
    const db = createRateLimitDb(tempDirs)
    const policy: RateLimitPolicy = {
      id: 'ingest',
      maxRequests: 2,
      windowSeconds: 60
    }

    await enforceRateLimit(db, {
      policy,
      subject: { kind: 'ip', value: 'expired' },
      now: new Date('2026-06-11T00:00:00.000Z')
    })
    await enforceRateLimit(db, {
      policy,
      subject: { kind: 'ip', value: 'active' },
      now: new Date('2026-06-11T00:02:00.000Z')
    })

    await pruneExpiredRateLimits(db, new Date('2026-06-11T00:01:30.000Z'))

    const rows = await db.prepare('SELECT key FROM api_rate_limits ORDER BY key').bind().all<{ key: string }>()

    expect(rows.results).toHaveLength(1)
    expect(rows.results[0]?.key).toMatch(/^rl:v1:ingest:ip:/)
  })

  test('repairs an invalid stored reset timestamp and resets the window', async () => {
    const db = createRateLimitDb(tempDirs)
    const policy: RateLimitPolicy = {
      id: 'invalid-reset',
      maxRequests: 1,
      windowSeconds: 90
    }
    const now = new Date('2026-06-11T00:00:00.000Z')

    await expect(
      enforceRateLimit(db, {
        policy,
        subject: { kind: 'ip', value: 'invalid-reset' },
        now
      })
    ).resolves.toBeDefined()
    await db
      .prepare('UPDATE api_rate_limits SET reset_at = ? WHERE key LIKE ?')
      .bind('not-a-timestamp', 'rl:v1:invalid-reset:%')
      .run()

    await expect(
      enforceRateLimit(db, {
        policy,
        subject: { kind: 'ip', value: 'invalid-reset' },
        now
      })
    ).resolves.toMatchObject({ remaining: 0, resetAt: '2026-06-11T00:01:30.000Z' })
    const row = await db
      .prepare('SELECT count, reset_at AS resetAt FROM api_rate_limits WHERE key LIKE ?')
      .bind('rl:v1:invalid-reset:%')
      .first<{ count: number; resetAt: string }>()
    expect(row).toEqual({ count: 1, resetAt: '2026-06-11T00:01:30.000Z' })
  })

  test('prunes invalid reset timestamps instead of retaining them forever', async () => {
    const db = createRateLimitDb(tempDirs)
    const policy: RateLimitPolicy = {
      id: 'invalid-prune',
      maxRequests: 1,
      windowSeconds: 60
    }

    await enforceRateLimit(db, {
      policy,
      subject: { kind: 'ip', value: 'invalid-prune' },
      now: new Date('2026-06-11T00:00:00.000Z')
    })
    await db
      .prepare('UPDATE api_rate_limits SET reset_at = ? WHERE key LIKE ?')
      .bind('not-a-timestamp', 'rl:v1:invalid-prune:%')
      .run()

    await pruneExpiredRateLimits(db, new Date('2026-06-11T00:00:00.000Z'))

    const row = await db
      .prepare('SELECT 1 AS present FROM api_rate_limits WHERE key LIKE ?')
      .bind('rl:v1:invalid-prune:%')
      .first<{ present: number }>()
    expect(row).toBeUndefined()
  })

  test('uses the expression index when pruning reset timestamps', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-rate-limit-plan-'))
    tempDirs.push(tempDir)
    const dbPath = join(tempDir, 'rate-limit.db')
    applyRateLimitMigrations(dbPath)

    const plan = runSql(
      dbPath,
      `EXPLAIN QUERY PLAN
       DELETE FROM api_rate_limits
       WHERE julianday(reset_at) IS NULL
          OR julianday(reset_at) <= julianday('2026-06-11T00:00:00.000Z');`
    )

    expect(plan).toContain('api_rate_limits_reset_julianday_idx')
  })
})

describe('client IP subject', () => {
  test('uses Cloudflare client IP as the trusted source', () => {
    const headers = new Headers({
      'cf-connecting-ip': '203.0.113.10',
      'x-forwarded-for': '198.51.100.20'
    })

    expect(clientIpRateLimitSubject(headers)).toEqual({ kind: 'ip', value: '203.0.113.10' })
  })

  test('uses an unknown bucket when the trusted Cloudflare header is absent', () => {
    const headers = new Headers({ 'x-forwarded-for': '198.51.100.20' })

    expect(clientIpRateLimitSubject(headers)).toEqual({ kind: 'ip', value: 'unknown' })
  })
})

function createRateLimitDb(tempDirs: string[]) {
  return createSqliteD1(applyRateLimitMigrations(tempDirForRateLimit(tempDirs)))
}

function tempDirForRateLimit(tempDirs: string[]) {
  const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-rate-limit-'))
  tempDirs.push(tempDir)
  return join(tempDir, 'rate-limit.db')
}

function applyRateLimitMigrations(dbPath: string) {
  for (const migration of [
    '0021_api_rate_limits.sql',
    '0033_rate_limit_reset_julianday_index.sql',
    '0034_drop_api_rate_limits_reset_index.sql'
  ]) {
    runSql(dbPath, readFileSync(`db/migrations/${migration}`, 'utf8'))
  }
  return dbPath
}
