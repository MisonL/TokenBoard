import { beforeEach, describe, expect, test, vi } from 'vitest'
import { ZodError } from 'zod'
import { requireUser } from '../../features/auth/middleware'
import { getProfileSettings, parseProfilePageForm, updateProfilePageSettings } from '../../features/settings/service'
import { ApiError } from '../../lib/errors'
import { FormError } from '../../lib/form-error'
import { POST } from './profile'

vi.mock('../../features/auth/middleware', () => ({
  requireUser: vi.fn()
}))

vi.mock('../../features/settings/service', () => ({
  getProfileSettings: vi.fn(),
  parseProfilePageForm: vi.fn(),
  updateProfilePageSettings: vi.fn()
}))

const mockedRequireUser = vi.mocked(requireUser)
const mockedParseProfilePageForm = vi.mocked(parseProfilePageForm)
const mockedUpdateProfilePageSettings = vi.mocked(updateProfilePageSettings)
const mockedGetProfileSettings = vi.mocked(getProfileSettings)

// A rejected settings save used to answer the form POST with a JSON body, which the browser
// renders as the page and which discards everything the user typed. It has to come back as a
// redirect the page can explain instead.
describe('profile POST route', () => {
  beforeEach(() => {
    mockedRequireUser.mockReset()
    mockedParseProfilePageForm.mockReset()
    mockedUpdateProfilePageSettings.mockReset()
    mockedGetProfileSettings.mockReset()
    mockedRequireUser.mockResolvedValue({ id: 'user_1', email: 'user@example.com' } as never)
  })

  test('redirects with a rendered message when the submitted values fail validation', async () => {
    mockedParseProfilePageForm.mockImplementation(() => {
      throw new ZodError([])
    })

    const response = (await POST[0](postContext() as never, async () => undefined)) as Response

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/settings/profile?error=invalid-profile')
  })

  test('redirects with the service error code', async () => {
    mockedParseProfilePageForm.mockReturnValue({} as never)
    mockedUpdateProfilePageSettings.mockRejectedValue(new FormError('slug-taken', 'Slug is already taken'))

    const response = (await POST[0](postContext() as never, async () => undefined)) as Response

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/settings/profile?error=slug-taken')
  })

  test('keeps the JSON error path for unexpected failures', async () => {
    mockedParseProfilePageForm.mockReturnValue({} as never)
    mockedUpdateProfilePageSettings.mockRejectedValue(new Error('database is on fire'))

    const response = (await POST[0](postContext() as never, async () => undefined)) as Response

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ error: { code: 'INTERNAL_SERVER_ERROR' } })
  })

  // A missing profile row is a 404 from the service, not a validation failure: it must keep its
  // status on the JSON path rather than being flattened into a redirect banner.
  test('keeps a not-found FormError on the JSON path', async () => {
    mockedParseProfilePageForm.mockReturnValue({} as never)
    mockedUpdateProfilePageSettings.mockRejectedValue(
      new FormError('profile-not-found', 'Profile not found', 'NOT_FOUND', 404)
    )

    const response = (await POST[0](postContext() as never, async () => undefined)) as Response

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })
  })

  test('keeps the JSON 401 path when the session is missing', async () => {
    mockedRequireUser.mockRejectedValue(new ApiError('UNAUTHORIZED', 'Sign in required', 401))

    const response = (await POST[0](postContext() as never, async () => undefined)) as Response

    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe('Bearer')
    expect(await response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } })
  })

  test('redirects to the saved state on success', async () => {
    mockedParseProfilePageForm.mockReturnValue({} as never)
    mockedUpdateProfilePageSettings.mockResolvedValue(undefined as never)

    const response = (await POST[0](postContext() as never, async () => undefined)) as Response

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/settings/profile?saved=1')
  })
})

function postContext() {
  const headers = new Headers()
  return {
    env: { DB: {} },
    req: {
      url: 'https://tokenboard.example/settings/profile',
      parseBody: vi.fn(async () => ({}))
    },
    header: vi.fn((name: string, value: string) => {
      headers.set(name, value)
    }),
    json: vi.fn((body: unknown, status = 200, responseHeaders?: HeadersInit) =>
      Response.json(body, { status, headers: responseHeaders ?? headers })
    ),
    redirect: vi.fn((location: string, status = 302) => new Response(null, { status, headers: { location } }))
  }
}
