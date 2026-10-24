import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createAuth } from './auth'
import { ensureProfile, getOptionalUser, requireUser, verifyUploadToken } from './middleware'

vi.mock('./auth', () => ({
  createAuth: vi.fn()
}))

const mockedCreateAuth = vi.mocked(createAuth)

describe('getOptionalUser', () => {
  beforeEach(() => {
    mockedCreateAuth.mockReset()
  })

  test('does not initialize auth when no session cookie is present', async () => {
    const user = await getOptionalUser({
      env: {
        DB: {
          prepare() {
            throw new Error('DB should not be queried')
          }
        }
      },
      req: {
        header(name: string) {
          expect(name).toBe('cookie')
          return 'theme=dark'
        },
        raw: new Request('http://127.0.0.1/leaderboards')
      }
    } as never)

    expect(user).toBeNull()
    expect(mockedCreateAuth).not.toHaveBeenCalled()
  })

  test.each(['better-auth-session_token=abc', '__Secure-better-auth-session_token=abc'])(
    'preserves Better Auth hyphenated session cookie lookup for %s',
    async (cookieHeader) => {
      const getSession = vi.fn(async () => ({
        user: {
          id: 'user_123',
          email: 'user@example.com',
          name: 'Token User',
          image: null
        }
      }))
      mockedCreateAuth.mockReturnValue({
        api: { getSession }
      } as never)

      const raw = new Request('http://127.0.0.1/dashboard', {
        headers: { cookie: cookieHeader }
      })
      const user = await getOptionalUser({
        env: {},
        req: {
          header(name: string) {
            expect(name).toBe('cookie')
            return raw.headers.get('cookie')
          },
          raw
        }
      } as never)

      expect(user).toEqual({
        id: 'user_123',
        email: 'user@example.com',
        name: 'Token User',
        image: null
      })
      expect(getSession).toHaveBeenCalledWith({ headers: raw.headers })
    }
  )
})

describe('requireUser', () => {
  beforeEach(() => {
    mockedCreateAuth.mockReset()
  })

  test('creates a missing profile with the browser timezone cookie', async () => {
    const bindings: unknown[][] = []
    mockedCreateAuth.mockReturnValue({
      api: {
        getSession: vi.fn(async () => ({
          user: {
            id: 'user_12345678',
            email: 'user@example.com',
            name: 'Token User',
            image: null
          }
        }))
      }
    } as never)

    const raw = new Request('https://tokenboard.example/dashboard', {
      headers: {
        cookie: 'better-auth-session_token=abc; tokenboard-timezone=Asia%2FShanghai'
      }
    })

    await requireUser({
      env: {
        DB: {
          prepare() {
            return {
              bind(...values: unknown[]) {
                bindings.push(values)
                return {
                  async run() {
                    return { success: true }
                  }
                }
              }
            }
          }
        }
      },
      req: {
        header(name: string) {
          expect(name).toBe('cookie')
          return raw.headers.get('cookie')
        },
        raw
      },
      header() {}
    } as never)

    expect(bindings[0][3]).toBe('Asia/Shanghai')
  })
})

describe('verifyUploadToken', () => {
  test('returns token owner from upload_tokens when bearer token is stored in D1', async () => {
    const user = await verifyUploadToken(
      {
        DB: {
          prepare(sql: string) {
            expect(sql).toContain('FROM upload_tokens')
            expect(sql).toContain('device_id as deviceId')
            expect(sql).toContain('installation_id as installationId')
            // The only thing that makes revocation effective: without this
            // predicate a revoked token keeps full write access forever.
            expect(sql).toContain('revoked_at IS NULL')
            return {
              bind(value: string) {
                expect(value).toBe('hash:tok')
                return {
                  async first() {
                    return {
                      userId: 'paired-user',
                      deviceId: 'dev_123',
                      installationId: 'inst_123'
                    }
                  }
                }
              }
            }
          }
        } as unknown as D1Database
      },
      'Bearer tok',
      async (value) => `hash:${value}`
    )

    expect(user).toEqual({
      id: 'paired-user',
      uploadTokenHash: 'hash:tok',
      deviceId: 'dev_123',
      installationId: 'inst_123'
    })
  })

  test('rejects a bearer token that is not stored', async () => {
    await expect(
      verifyUploadToken(
        {
          DB: {
            prepare() {
              return {
                bind() {
                  return {
                    async first() {
                      return null
                    }
                  }
                }
              }
            }
          } as unknown as D1Database
        },
        'Bearer bad-token',
        async (value) => `hash:${value}`
      )
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      status: 401
    })
  })

  test('rejects missing or malformed bearer tokens', async () => {
    const env = {
      DB: {
        prepare() {
          throw new Error('DB should not be queried')
        }
      } as unknown as D1Database
    }

    await expect(verifyUploadToken(env, null)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    await expect(verifyUploadToken(env, 'Token abc')).rejects.toMatchObject({
      code: 'UNAUTHORIZED'
    })
  })
})

describe('ensureProfile', () => {
  test('creates new profiles as private by default', async () => {
    const bindings: unknown[][] = []
    const db = {
      prepare(sql: string) {
        expect(sql).toContain('INSERT INTO profiles')
        expect(sql).toContain('VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)')
        expect(sql).toContain("WHERE profiles.timezone_source = 'default'")
        expect(sql).toContain("excluded.timezone_source = 'browser'")
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async run() {
                return { success: true }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await ensureProfile(db, {
      id: 'USER123456789',
      email: 'eve@example.com',
      name: 'Eve',
      image: null
    })

    expect(bindings[0]).toEqual([
      'USER123456789',
      'eve-user1234',
      'Eve',
      'UTC',
      'default',
      expect.any(String),
      expect.any(String)
    ])
  })

  test('uses a valid browser timezone when creating a profile', async () => {
    const bindings: unknown[][] = []
    const db = {
      prepare() {
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async run() {
                return { success: true }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await ensureProfile(
      db,
      {
        id: 'USER123456789',
        email: 'eve@example.com',
        name: 'Eve',
        image: null
      },
      'Asia/Shanghai'
    )

    expect(bindings[0]).toEqual([
      'USER123456789',
      'eve-user1234',
      'Eve',
      'Asia/Shanghai',
      'browser',
      expect.any(String),
      expect.any(String)
    ])
  })

  // GitHub accounts without a display name reach the session with an empty `name`. Falling
  // back to the full address wrote the user's email into `display_name`, which the public
  // profile JSON and SVG card serve verbatim the moment the profile is made public — a leak
  // the user never chose. The email's local part is the same fallback the slug already uses.
  test('falls back to the email local part, never the full address, for the display name', async () => {
    const bindings: unknown[][] = []
    const db = {
      prepare() {
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async run() {
                return { success: true }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await ensureProfile(db, {
      id: 'USER123456789',
      email: 'eve@example.com',
      name: '',
      image: null
    })

    expect(bindings[0]).toEqual([
      'USER123456789',
      'eve-user1234',
      'eve',
      'UTC',
      'default',
      expect.any(String),
      expect.any(String)
    ])
    expect(JSON.stringify(bindings[0])).not.toContain('eve@example.com')
  })
})

describe('requireUser response caching', () => {
  beforeEach(() => {
    mockedCreateAuth.mockReset()
    mockedCreateAuth.mockReturnValue({
      api: {
        getSession: vi.fn(async () => ({
          user: { id: 'user_12345678', email: 'user@example.com', name: 'Token User', image: null }
        }))
      }
    } as never)
  })

  // Every page behind a session renders the signed-in user's email in the nav, and the browser
  // may keep a heuristically-cached copy or restore one from the back/forward cache. On a shared
  // machine that shows the previous user's account after they sign out. Five authenticated pages
  // — the dashboard, usage details, device details, notifications and profile — were relying on
  // a per-route header that each of them had forgotten, while the routes that remembered said so
  // in a comment claiming the rest of the app did too. Setting it at the auth boundary is what
  // makes that claim true: a new page behind `requireUser` cannot ship without it.
  test('marks a session-gated response uncacheable', async () => {
    const headers = new Map<string, string>()
    const context = {
      env: {
        DB: {
          prepare() {
            return {
              bind() {
                return {
                  async run() {
                    return { success: true }
                  }
                }
              }
            }
          }
        }
      },
      req: {
        header: (name: string) => (name === 'cookie' ? 'better-auth-session_token=abc' : undefined),
        raw: new Request('https://tokenboard.example/dashboard')
      },
      header: (name: string, value: string) => headers.set(name, value)
    }

    await requireUser(context as never)

    expect(headers.get('Cache-Control')).toBe('no-store')
  })
})
