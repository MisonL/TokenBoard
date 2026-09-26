import { beforeEach, describe, expect, test, vi } from 'vitest'
import { getOptionalUser } from '../../features/auth/middleware'
import { getProfileTimezoneSettings } from '../../features/settings/service'
import { getLeaderboard } from '../../features/leaderboards/service'
import { GET } from './fragment'

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

// The fragment replaces the panel the full page rendered, so the two must rank the same day.
// They did not: the page read the signed-in user's stored profile zone while this route always
// read the browser cookie, so a user who had set their zone by hand saw one day's board on load
// and a different day's the moment they clicked a tab. Same user, same instant, two boards.
describe('leaderboard fragment route', () => {
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

  test('resolves the signed-in user profile zone rather than the cookie zone', async () => {
    mockedGetOptionalUser.mockResolvedValue({ id: 'user_1', email: 'user@example.com' } as never)
    mockedTimezone.mockResolvedValue({ timezone: 'Asia/Shanghai' } as never)

    await GET[0](context('tokenboard-timezone=America%2FLos_Angeles') as never, async () => undefined)

    // The cookie says Los Angeles; the stored profile says Shanghai. The dashboard and public
    // card both report in the stored zone, so the board has to as well.
    expect(mockedGetLeaderboard.mock.calls[0][4]).toBe('Asia/Shanghai')
  })

  test('falls back to the cookie zone for an anonymous viewer', async () => {
    mockedGetOptionalUser.mockResolvedValue(null)

    await GET[0](context('tokenboard-timezone=America%2FLos_Angeles') as never, async () => undefined)

    expect(mockedGetLeaderboard.mock.calls[0][4]).toBe('America/Los_Angeles')
  })
})

function context(cookie: string) {
  const request = new Request('https://tokenboard.example/leaderboards/fragment?period=daily')
  return {
    env: { DB: {} },
    req: {
      raw: request,
      url: request.url,
      query: (name: string) => new URL(request.url).searchParams.get(name),
      header: (name: string) => (name === 'cookie' ? cookie : undefined)
    },
    html: (body: unknown, status = 200) => new Response(String(body), { status }),
    json: (body: unknown, status = 200) => Response.json(body, { status })
  }
}
