import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createAuth } from './auth'
import { ensureProfile, getOptionalUser, verifyUploadToken } from './middleware'

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

  test.each([
    'better-auth-session_token=abc',
    '__Secure-better-auth-session_token=abc'
  ])('preserves Better Auth hyphenated session cookie lookup for %s', async (cookieHeader) => {
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
            return {
              bind(value: string) {
                expect(value).toBe('hash:tok')
                return {
                  async first() {
                    return { userId: 'paired-user', deviceId: 'dev_123' }
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
      deviceId: 'dev_123'
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
  test('creates new profiles as public leaderboard participants by default', async () => {
    const bindings: unknown[][] = []
    const db = {
      prepare(sql: string) {
        expect(sql).toContain('INSERT INTO profiles')
        expect(sql).toContain("VALUES (?, ?, ?, 'UTC', 1, 1, ?, ?)")
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
      expect.any(String),
      expect.any(String)
    ])
  })
})
