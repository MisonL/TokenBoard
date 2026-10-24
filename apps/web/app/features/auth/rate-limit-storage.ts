import type { D1Database } from '@cloudflare/workers-types'

// Better Auth only enables its built-in limiter when `NODE_ENV === 'production'`, and a
// Worker does not get that variable, so on this deployment the limiter was off: `/sign-in`
// and `/sign-up` — which Better Auth caps at 3 requests per 10 seconds by default — accepted
// unlimited attempts. Turning the limiter on is not enough by itself either, because its
// default storage is an in-process Map: Workers isolates do not share memory, so each
// isolate would count separately and the cap would mean nothing.
//
// This storage backs the limiter with the same D1 table the app's own rate limiting uses,
// and implements `consume` so the increment is a single atomic upsert. Better Auth's
// fallback path without `consume` is explicitly best-effort ("simultaneous requests can
// each pass the check before either write lands"), which is the wrong guarantee for a
// credential endpoint.
//
// The window is fixed — `reset_at` is anchored at the first request and held for the whole
// window — where Better Auth's own `decideConsume` rolls (`now - lastRequest > window`).
// The two differ only at a boundary, where a caller can land `max` requests at the tail of
// one window and `max` more at the head of the next: 6 rather than 3 over a 10.2s span,
// measured. That is the standard, bounded cost of fixed-window limiting, and it is the
// semantics the shared table already carries for `lib/rate-limit.ts`; matching upstream
// here instead would put the two consumers of `api_rate_limits` in disagreement.
export type RateLimitRule = { window: number; max: number }
// `retryAfter` is `number | null` rather than optional to match the storage contract.
export type RateLimitDecision = { allowed: boolean; retryAfter: number | null }

type RateLimitRow = { count: number; resetAt: string }
type StoredRateLimit = { key: string; count: number; lastRequest: number }

export function createD1RateLimitStorage(db: D1Database) {
  return {
    // `get`/`set` are required by the storage contract but are only reached when `consume`
    // is absent, which it is not here. They are implemented against the same row rather
    // than left as stubs so the two paths cannot disagree if a future version calls them.
    async get(key: string): Promise<StoredRateLimit | null> {
      const row = await db
        .prepare('SELECT count, updated_at as updatedAt FROM api_rate_limits WHERE key = ? LIMIT 1')
        .bind(await authRateLimitKey(key))
        .first<{ count: number; updatedAt: string }>()
      if (!row) return null
      const lastRequest = Date.parse(row.updatedAt)
      return { key, count: Number(row.count), lastRequest: Number.isFinite(lastRequest) ? lastRequest : 0 }
    },

    async set(key: string, value: StoredRateLimit): Promise<void> {
      const lastRequest = Number.isFinite(value.lastRequest) ? value.lastRequest : Date.now()
      await db
        .prepare(
          `INSERT INTO api_rate_limits (key, count, reset_at, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             count = excluded.count,
             reset_at = excluded.reset_at,
             updated_at = excluded.updated_at`
        )
        .bind(
          await authRateLimitKey(key),
          Number.isFinite(value.count) ? value.count : 0,
          new Date(lastRequest).toISOString(),
          new Date(lastRequest).toISOString()
        )
        .run()
    },

    async consume(key: string, rule: RateLimitRule): Promise<RateLimitDecision> {
      const now = Date.now()
      const nowIso = new Date(now).toISOString()
      const resetAt = new Date(now + rule.window * 1000).toISOString()
      // The `min(..., max + 1)` cap keeps a hammered key from growing without bound while
      // still reading as over-limit. A row whose window has passed starts a fresh count.
      const row = await db
        .prepare(
          `INSERT INTO api_rate_limits (key, count, reset_at, updated_at)
           VALUES (?, 1, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             count = CASE
               WHEN julianday(api_rate_limits.reset_at) IS NULL
                 OR julianday(api_rate_limits.reset_at) <= julianday(?) THEN 1
               ELSE min(api_rate_limits.count + 1, ?)
             END,
             reset_at = CASE
               WHEN julianday(api_rate_limits.reset_at) IS NULL
                 OR julianday(api_rate_limits.reset_at) <= julianday(?) THEN excluded.reset_at
               ELSE api_rate_limits.reset_at
             END,
             updated_at = excluded.updated_at
           RETURNING count, reset_at as resetAt`
        )
        .bind(await authRateLimitKey(key), resetAt, nowIso, nowIso, rule.max + 1, nowIso)
        .first<RateLimitRow>()

      const count = Number(row?.count ?? rule.max + 1)
      if (count <= rule.max) return { allowed: true, retryAfter: null }

      const resetTimestamp = Date.parse(row?.resetAt ?? resetAt)
      const retryAfter = Number.isFinite(resetTimestamp)
        ? Math.max(1, Math.ceil((resetTimestamp - now) / 1000))
        : rule.window
      return { allowed: false, retryAfter }
    }
  }
}

// Namespaced so an auth key can never collide with a policy key from lib/rate-limit.ts,
// which writes to the same table, and hashed for the same reason that module hashes its
// subject: Better Auth's key embeds the caller's address verbatim (`<ip>|<path>`), and the
// table is a durable record, so storing it raw would put every client address in the
// database. The hash keeps the key stable and collision-free without keeping the address.
async function authRateLimitKey(key: string) {
  return `auth:v1:${await sha256Hex(key)}`
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
