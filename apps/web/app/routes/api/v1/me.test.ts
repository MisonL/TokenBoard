import { beforeEach, describe, expect, test, vi } from 'vitest'
import { requireUser } from '../../../features/auth/middleware'
import { ApiError } from '../../../lib/errors'
import { GET } from './me'

vi.mock('../../../features/auth/middleware', () => ({
  requireUser: vi.fn()
}))

const mockedRequireUser = vi.mocked(requireUser)

// This is the only GET in the API that returns account data — id, email, name, image — and
// it was the one authenticated route that set no cache policy at all, so a browser was free
// to heuristically cache a 200 with no validator. Every sibling route already sets this.
describe('me route', () => {
  beforeEach(() => {
    mockedRequireUser.mockReset()
  })

  test('prevents caching account data responses', async () => {
    const request = new Request('https://tokenboard.example/api/v1/me')
    const context = {
      env: { DB: {} },
      req: { raw: request, url: request.url },
      header: vi.fn(),
      json: vi.fn((body: unknown, status = 200) => Response.json(body, { status }))
    }
    mockedRequireUser.mockResolvedValue({ id: 'user_1', email: 'user@example.com' } as never)

    const response = (await GET[0](context as never, async () => undefined)) as Response

    expect(response.status).toBe(200)
    expect(context.header).toHaveBeenCalledWith('Cache-Control', 'no-store')
    expect(await response.json()).toEqual({ user: { id: 'user_1', email: 'user@example.com' } })
  })

  test('also covers the unauthenticated path, so a stale 401 cannot be replayed', async () => {
    const request = new Request('https://tokenboard.example/api/v1/me')
    const context = {
      env: { DB: {} },
      req: { raw: request, url: request.url },
      header: vi.fn(),
      json: vi.fn((body: unknown, status = 200) => Response.json(body, { status }))
    }
    mockedRequireUser.mockRejectedValue(new ApiError('UNAUTHORIZED', 'Sign in required', 401))

    const response = (await GET[0](context as never, async () => undefined)) as Response

    expect(response.status).toBe(401)
    expect(context.header).toHaveBeenCalledWith('Cache-Control', 'no-store')
  })
})
