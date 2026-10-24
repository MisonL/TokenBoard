import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createSqliteD1 } from '../../test/sqlite-d1'
import { runSqliteScript } from '../../test/sqlite-script'
import { createD1RateLimitStorage } from './rate-limit-storage'

// The limiter is only as good as its storage: a per-isolate Map lets a caller multiply the
// cap by however many isolates answer, so these run against a real SQLite-backed D1.
describe('D1 rate limit storage', () => {
  let dir: string
  let db: D1Database
  let storage: ReturnType<typeof createD1RateLimitStorage>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'auth-rl-'))
    const dbPath = join(dir, 'db.sqlite')
    runSqliteScript(
      dbPath,
      `
      CREATE TABLE api_rate_limits (
        key TEXT PRIMARY KEY NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        reset_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `
    )
    db = createSqliteD1(dbPath)
    storage = createD1RateLimitStorage(db)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('allows up to the cap and rejects the next request', async () => {
    const rule = { window: 10, max: 3 }
    for (let i = 0; i < 3; i++) {
      await expect(storage.consume('sign-in:1.2.3.4', rule)).resolves.toMatchObject({ allowed: true })
    }
    const denied = await storage.consume('sign-in:1.2.3.4', rule)
    expect(denied.allowed).toBe(false)
    expect(denied.retryAfter).toBeGreaterThan(0)
  })

  test('keeps separate budgets per key', async () => {
    const rule = { window: 10, max: 1 }
    await expect(storage.consume('sign-in:1.1.1.1', rule)).resolves.toMatchObject({ allowed: true })
    await expect(storage.consume('sign-in:1.1.1.1', rule)).resolves.toMatchObject({ allowed: false })
    // A different caller must not inherit the first one's exhausted budget.
    await expect(storage.consume('sign-in:2.2.2.2', rule)).resolves.toMatchObject({ allowed: true })
  })

  test('opens a fresh window once the current one has elapsed', async () => {
    const rule = { window: 1, max: 1 }
    await expect(storage.consume('sign-in:3.3.3.3', rule)).resolves.toMatchObject({ allowed: true })
    await expect(storage.consume('sign-in:3.3.3.3', rule)).resolves.toMatchObject({ allowed: false })

    // Backdate the row past its window rather than sleeping a real second.
    await db
      .prepare('UPDATE api_rate_limits SET reset_at = ?')
      .bind(new Date(Date.now() - 60_000).toISOString())
      .run()

    await expect(storage.consume('sign-in:3.3.3.3', rule)).resolves.toMatchObject({ allowed: true })
  })

  // Better Auth builds its key as `<ip>|<path>`, so storing it verbatim would put every
  // caller's address in the database. lib/rate-limit.ts already hashes its subject for
  // exactly this reason and asserts the same thing on its own keys.
  test('does not store the caller address in the key', async () => {
    await storage.consume('203.0.113.7|/sign-in/email', { window: 10, max: 3 })
    const row = await db.prepare('SELECT key FROM api_rate_limits LIMIT 1').bind().first<{ key: string }>()
    expect(row?.key).toMatch(/^auth:v1:[a-f0-9]{64}$/)
    expect(row?.key).not.toContain('203.0.113.7')
    expect(row?.key).not.toContain('/sign-in')
  })

  test('does not collide with the app rate limit keys in the same table', async () => {
    // lib/rate-limit.ts writes `rl:v1:<policy>:<kind>:<hash>`; the auth namespace differs.
    await db
      .prepare('INSERT INTO api_rate_limits (key, count, reset_at, updated_at) VALUES (?, ?, ?, ?)')
      .bind('rl:v1:ingest-ip:ip:abc', 999, new Date(Date.now() + 60_000).toISOString(), new Date().toISOString())
      .run()
    await expect(storage.consume('sign-in:4.4.4.4', { window: 10, max: 1 })).resolves.toMatchObject({
      allowed: true
    })
  })
})
