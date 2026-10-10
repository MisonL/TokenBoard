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

  test('renders the failure a rename redirect carried back', async () => {
    mockedRequireUser.mockResolvedValue({ id: 'user_1', email: 'user@example.com' } as never)
    mockedListUserDevices.mockResolvedValue([])
    mockedListLatestDeviceAuditLogs.mockResolvedValue(new Map())

    const response = (await GET[0](
      getContext({ error: 'device-name-invalid' }) as never,
      async () => undefined
    )) as Response

    expect(await response.text()).toContain('设备名称需为 1-80 个字符。')
  })

  // `revoked` is a user-controlled query parameter. An owned lookup must keep `?revoked=constructor`
  // from resolving an inherited member — which renders an empty success flash — and keep an
  // arbitrary value from being shown as a real revoke confirmation.
  test.each(['constructor', 'toString', '__proto__', 'bogus'])(
    'does not render a revoke flash for the unknown revoked code %s',
    async (revoked) => {
      mockedRequireUser.mockResolvedValue({ id: 'user_1', email: 'user@example.com' } as never)
      mockedListUserDevices.mockResolvedValue([])
      mockedListLatestDeviceAuditLogs.mockResolvedValue(new Map())

      const response = (await GET[0](getContext({ revoked }) as never, async () => undefined)) as Response
      const body = await response.text()

      // The real codes still render their own message; anything else must fall back to the
      // generic one rather than echoing an inherited member or confirming an unknown action.
      expect(body).toContain('设备上传凭证已停用。')
      expect(body).not.toContain('安装实例已停用。')
    }
  )

  test('renders the specific message for a known revoked code', async () => {
    mockedRequireUser.mockResolvedValue({ id: 'user_1', email: 'user@example.com' } as never)
    mockedListUserDevices.mockResolvedValue([])
    mockedListLatestDeviceAuditLogs.mockResolvedValue(new Map())

    const response = (await GET[0](getContext({ revoked: 'installation' }) as never, async () => undefined)) as Response

    expect(await response.text()).toContain('安装实例已停用。')
  })
})

function getContext(query: Record<string, string> = {}) {
  const headers = new Headers()
  return {
    env: { DB: {} },
    req: { url: 'https://tokenboard.example/settings/devices', query: (name: string) => query[name] },
    header: (name: string, value: string) => {
      headers.set(name, value)
    },
    json: (body: unknown, status = 200) => Response.json(body, { status, headers }),
    redirect: (location: string, status = 302) => new Response(null, { status, headers: { location } }),
    render: async (body: unknown) => new Response(await renderToString(body as never), { headers })
  }
}
