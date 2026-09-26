import { renderToString } from 'hono/jsx/dom/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { requireUser } from '../../features/auth/middleware'
import { listLatestDeviceAuditLogs, listUserDevices } from '../../features/device/service'
import { GET } from './devices'

vi.mock('../../features/auth/middleware', () => ({
  requireUser: vi.fn()
}))

vi.mock('../../features/device/service', () => ({
  listDeviceAuditLogs: vi.fn(),
  listLatestDeviceAuditLogs: vi.fn(),
  listUserDevices: vi.fn(),
  parseDeviceNameForm: vi.fn(),
  renameDevice: vi.fn(),
  revokeDevice: vi.fn(),
  revokeInstallation: vi.fn(),
  revokeUploadToken: vi.fn(),
  rotateUploadToken: vi.fn()
}))

const mockedRequireUser = vi.mocked(requireUser)
const mockedListUserDevices = vi.mocked(listUserDevices)
const mockedListLatestDeviceAuditLogs = vi.mocked(listLatestDeviceAuditLogs)

describe('devices GET route', () => {
  beforeEach(() => {
    mockedRequireUser.mockReset()
    mockedListUserDevices.mockReset()
    mockedListLatestDeviceAuditLogs.mockReset()
  })

  // The page lists the signed-in user's devices and credentials. Without a directive a browser
  // may cache it heuristically and serve it to the next person at the same machine. `requireUser`
  // now sets this for every session-gated response, so this asserts the route still ends up with
  // it rather than depending on which layer supplied it.
  test('does not let the devices page be cached', async () => {
    mockedRequireUser.mockResolvedValue({ id: 'user_1', email: 'user@example.com' } as never)
    mockedListUserDevices.mockResolvedValue([])
    mockedListLatestDeviceAuditLogs.mockResolvedValue(new Map())

    // `createRoute` returns a middleware chain; the handler is its first entry, which is how
    // the sibling POST test reaches its own.
    const response = (await GET[0](getContext() as never, async () => undefined)) as Response

    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })
})

function getContext() {
  const headers = new Headers()
  return {
    env: { DB: {} },
    req: { url: 'https://tokenboard.example/settings/devices', query: () => undefined },
    header: (name: string, value: string) => {
      headers.set(name, value)
    },
    json: (body: unknown, status = 200) => Response.json(body, { status, headers }),
    redirect: (location: string, status = 302) => new Response(null, { status, headers: { location } }),
    render: async (body: unknown) => new Response(await renderToString(body as never), { headers })
  }
}
