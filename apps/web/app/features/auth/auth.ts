import { betterAuth } from 'better-auth'
import type { Bindings } from '../../lib/db'
import { createD1RateLimitStorage } from './rate-limit-storage'

export const authBasePath = '/api/auth'

export function createAuth(
  env: Pick<Bindings, 'DB' | 'BETTER_AUTH_SECRET' | 'BETTER_AUTH_URL' | 'GITHUB_CLIENT_ID' | 'GITHUB_CLIENT_SECRET'>,
  request?: Request
) {
  const origin = request ? new URL(request.url).origin : undefined
  const secret = resolveAuthSecret(env.BETTER_AUTH_SECRET, origin)

  return betterAuth({
    appName: 'TokenBoard',
    basePath: authBasePath,
    baseURL: env.BETTER_AUTH_URL || origin,
    secret,
    database: env.DB,
    socialProviders: {
      github: {
        clientId: env.GITHUB_CLIENT_ID || '',
        clientSecret: env.GITHUB_CLIENT_SECRET || ''
      }
    },
    trustedOrigins: origin ? [origin] : undefined,
    // `enabled` is set explicitly because Better Auth's default is `isProduction`, which
    // reads `NODE_ENV` — a variable a Worker does not receive, so the default left the
    // limiter off on this deployment. The storage is D1-backed for the same reason the
    // default in-memory Map is unsuitable here: isolates do not share memory, so the
    // per-isolate count would let a caller multiply the cap by however many isolates
    // answer. Its built-in rules (3 requests / 10s on /sign-in and /sign-up) then apply.
    rateLimit: {
      enabled: true,
      customStorage: createD1RateLimitStorage(env.DB)
    },
    // Better Auth reads `x-forwarded-for` by default, which Cloudflare does not set; it
    // sets `cf-connecting-ip` and overwrites it at the edge, so it cannot be spoofed by the
    // caller. Without this the limiter resolves no address and falls back to one shared
    // bucket per path — a single caller exhausting the sign-in budget would then lock out
    // every other user, which is worse than the missing limit it replaces.
    advanced: {
      ipAddress: {
        ipAddressHeaders: ['cf-connecting-ip']
      }
    },
    user: {
      modelName: 'users',
      fields: {
        emailVerified: 'email_verified',
        createdAt: 'created_at',
        updatedAt: 'updated_at'
      }
    },
    session: {
      modelName: 'sessions',
      fields: {
        userId: 'user_id',
        expiresAt: 'expires_at',
        ipAddress: 'ip_address',
        userAgent: 'user_agent',
        createdAt: 'created_at',
        updatedAt: 'updated_at'
      }
    },
    account: {
      modelName: 'accounts',
      fields: {
        accountId: 'account_id',
        providerId: 'provider_id',
        userId: 'user_id',
        accessToken: 'access_token',
        refreshToken: 'refresh_token',
        idToken: 'id_token',
        accessTokenExpiresAt: 'access_token_expires_at',
        refreshTokenExpiresAt: 'refresh_token_expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at'
      }
    },
    verification: {
      modelName: 'verifications',
      fields: {
        expiresAt: 'expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at'
      }
    }
  })
}

// Session cookies are signed with this value, so a wrong or missing one is not a degraded
// mode — it is either a site nobody can sign into, or one where anyone who has read this
// repository can mint a cookie for any account. Better Auth will not catch the second case
// for us: its own default-secret check is gated on `NODE_ENV === 'production'`, which a
// Worker never receives, so `secret: undefined` there is accepted silently. The localhost
// exemption is what keeps `pnpm dev` working without a secret; it keys off the request
// origin, and a production deployment answers on its own domain, so it cannot be reached
// there. A missing secret in production therefore fails loudly at the first request rather
// than falling back to something public.
const developmentSecret = 'dev-tokenboard-local-secret'

export function resolveAuthSecret(configured: string | undefined, origin: string | undefined) {
  if (configured) return configured
  if (origin?.startsWith('http://localhost') || origin?.startsWith('http://127.0.0.1')) {
    return developmentSecret
  }
  throw new Error(
    'BETTER_AUTH_SECRET is not configured. Set it with `wrangler secret put BETTER_AUTH_SECRET` before deploying; refusing to sign sessions with a fallback value.'
  )
}
