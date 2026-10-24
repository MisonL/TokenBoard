import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolveAuthSecret } from './auth'

// The limiter has two failure modes that both look like "no limiting" from the outside:
// it is off entirely (Better Auth defaults `enabled` to isProduction, and a Worker has no
// NODE_ENV), or it is on but cannot tell callers apart, so every caller shares one bucket.
// The second is worse than the first — one attacker locks out everyone — and it is silent,
// since the limiter still answers 429. Both are pinned here against the config source.
describe('auth rate limit configuration', () => {
  const source = readFileSync(new URL('./auth.ts', import.meta.url), 'utf8')

  test('enables the limiter explicitly rather than inheriting the isProduction default', () => {
    expect(source).toMatch(/rateLimit:\s*\{[\s\S]*?enabled:\s*true/)
  })

  test('backs the limiter with shared storage instead of the per-isolate default', () => {
    expect(source).toContain('customStorage: createD1RateLimitStorage(env.DB)')
  })

  test('resolves the client from the Cloudflare header, not the unset x-forwarded-for', () => {
    expect(source).toContain("ipAddressHeaders: ['cf-connecting-ip']")
  })
})

// Session cookies are signed with `BETTER_AUTH_SECRET`, so falling back to a value that is
// in this repository would let anyone who has read it mint a session for any account. The
// fallback used to be keyed only on a localhost origin, which looks like a guard but is
// derived from the request; these pin the behaviour that replaced it.
describe('auth secret configuration', () => {
  test('refuses to construct without a secret outside local development', () => {
    expect(() => resolveAuthSecret(undefined, 'https://tokenboard.example')).toThrow(/BETTER_AUTH_SECRET/)
  })

  test('keeps local development working without a configured secret', () => {
    expect(resolveAuthSecret(undefined, 'http://localhost:5173')).toBe('dev-tokenboard-local-secret')
    expect(resolveAuthSecret(undefined, 'http://127.0.0.1:5173')).toBe('dev-tokenboard-local-secret')
  })

  test('uses the configured secret whenever one is present', () => {
    expect(resolveAuthSecret('configured-value', 'https://tokenboard.example')).toBe('configured-value')
    expect(resolveAuthSecret('configured-value', 'http://localhost:5173')).toBe('configured-value')
  })

  // The deploy preflight must also refuse an inline secret, since `vars` is committed.
  test('production config validation rejects an inline auth secret', () => {
    const check = readFileSync(new URL('../../../scripts/check-production-config.mjs', import.meta.url), 'utf8')
    expect(check).toContain('vars.BETTER_AUTH_SECRET')
  })
})
