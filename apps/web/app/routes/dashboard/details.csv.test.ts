import { beforeEach, describe, expect, test, vi } from 'vitest'
import { requireUser } from '../../features/auth/middleware'
import { getProfileTimezoneSettings } from '../../features/settings/service'
import { getUsageDetails } from '../../features/usage/queries'
import { GET } from './details.csv'

vi.mock('../../features/auth/middleware', () => ({
  requireUser: vi.fn()
}))

vi.mock('../../features/usage/queries', () => ({
  getUsageDetails: vi.fn()
}))

vi.mock('../../features/settings/service', () => ({
  getProfileTimezoneSettings: vi.fn()
}))

const mockedRequireUser = vi.mocked(requireUser)
const mockedGetUsageDetails = vi.mocked(getUsageDetails)
const mockedTimezone = vi.mocked(getProfileTimezoneSettings)

// The response is per-user usage detail, and `.csv` is on Cloudflare's default
// cache-by-extension list, so a response carrying no Cache-Control could be stored and
// served to a different user whose default filters produce the same URL.
describe('usage details CSV route', () => {
  beforeEach(() => {
    mockedRequireUser.mockReset()
    mockedGetUsageDetails.mockReset()
    mockedTimezone.mockReset()
  })

  test('marks the download private and uncacheable', async () => {
    const request = new Request('https://tokenboard.example/dashboard/details.csv?source=all')
    const context = {
      env: { DB: {} },
      req: { raw: request, url: request.url, query: () => undefined },
      body: (body: string, status = 200, headers: Record<string, string> = {}) =>
        new Response(body, { status, headers })
    }
    mockedRequireUser.mockResolvedValue({ id: 'user_1', email: 'user@example.com' } as never)
    mockedGetUsageDetails.mockResolvedValue({ modelRows: [], dailyRows: [], totals: {} } as never)
    // The route reads the user's timezone to default the export window to their local day.
    mockedTimezone.mockResolvedValue({ timezone: 'Asia/Shanghai' } as never)

    const response = (await GET[0](context as never, async () => undefined)) as Response

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('content-disposition')).toContain('attachment')
  })
})
