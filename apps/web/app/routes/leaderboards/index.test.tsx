import { beforeEach, describe, expect, test, vi } from 'vitest'
import { getOptionalUser } from '../../features/auth/middleware'
import { getProfileTimezoneSettings } from '../../features/settings/service'
import { getLeaderboard } from '../../features/leaderboards/service'
import route from './index'

vi.mock('../../features/auth/middleware', () => ({
  getOptionalUser: vi.fn()
}))

vi.mock('../../features/settings/service', () => ({
  getProfileTimezoneSettings: vi.fn()
}))

vi.mock('../../features/leaderboards/service', () => ({
  getLeaderboard: vi.fn()
}))

const mockedGetOptionalUser = vi.mocked(getOptionalUser)
const mockedTimezone = vi.mocked(getProfileTimezoneSettings)
const mockedGetLeaderboard = vi.mocked(getLeaderboard)

describe('leaderboard page route', () => {
  beforeEach(() => {
    mockedGetOptionalUser.mockReset()
    mockedTimezone.mockReset()
    mockedGetLeaderboard.mockReset()
    mockedGetLeaderboard.mockResolvedValue({
      entries: [],
      period: 'daily',
      metric: 'tokens',
      rangeLabel: '2026-05-01',
      timezone: 'Asia/Shanghai',
      timezoneLabel: 'UTC+8'
    } as never)
  })

  // The page and the fragment that replaces its panel are two routes answering the same
  // question, and they must answer it the same way. This asserts the page half of that
  // contract; the fragment's own test asserts the other half against the same helper.
  test('resolves the signed-in user profile zone rather than the cookie zone', async () => {
    mockedGetOptionalUser.mockResolvedValue({ id: 'user_1', email: 'user@example.com' } as never)
    mockedTimezone.mockResolvedValue({ timezone: 'Asia/Shanghai' } as never)

    await route[0](context('tokenboard-timezone=America%2FLos_Angeles') as never, async () => undefined)

    expect(mockedGetLeaderboard.mock.calls[0][4]).toBe('Asia/Shanghai')
  })

  // A signed-in visitor can legitimately have no profile row: only `requireUser` creates one,
  // and this page is public. The lookup throws NOT_FOUND for that row, which used to surface as
  // a 404 on a page an anonymous visitor can read.
  test('renders for a signed-in visitor who has no profile row yet', async () => {
    mockedGetOptionalUser.mockResolvedValue({ id: 'user_1', email: 'user@example.com' } as never)
    mockedTimezone.mockRejectedValue(
      new (await import('../../lib/errors')).ApiError('NOT_FOUND', 'Profile not found', 404)
    )

    const response = (await route[0](
      context('tokenboard-timezone=Asia%2FTokyo') as never,
      async () => undefined
    )) as Response

    expect(response.status).toBe(200)
    expect(mockedGetLeaderboard.mock.calls[0][4]).toBe('Asia/Tokyo')
  })
})

function context(cookie: string) {
  const request = new Request('https://tokenboard.example/leaderboards?period=daily')
  return {
    env: { DB: {} },
    req: {
      raw: request,
      url: request.url,
      query: (name: string) => new URL(request.url).searchParams.get(name),
      header: (name: string) => (name === 'cookie' ? cookie : undefined)
    },
    render: async (body: unknown) => new Response(String(body), { status: 200 })
  }
}
