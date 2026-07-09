import { renderToString } from 'hono/jsx/dom/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { getOptionalUser } from '../../features/auth/middleware'
import { GET } from './sign-in'

vi.mock('../../features/auth/middleware', () => ({
  getOptionalUser: vi.fn()
}))

const mockedGetOptionalUser = vi.mocked(getOptionalUser)

describe('sign-in route', () => {
  beforeEach(() => {
    mockedGetOptionalUser.mockReset()
  })

  test('redirects authenticated users to the dashboard', async () => {
    mockedGetOptionalUser.mockResolvedValue({ id: 'user_1', email: 'user@example.com' } as never)

    const response = await GET[0](signInContext() as never, async () => undefined) as Response

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/dashboard')
  })

  test('marks the login card as the nav login focus target', async () => {
    mockedGetOptionalUser.mockResolvedValue(null)

    const response = await GET[0](signInContext() as never, async () => undefined) as Response
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('data-login-focus="true"')
    expect(html).toContain('data-login-card="true"')
    expect(html).toContain('data-login-primary="true"')
    expect(html).toContain('app-login-card')
  })

  test('keeps the GitHub auth failure message visible', async () => {
    mockedGetOptionalUser.mockResolvedValue(null)

    const response = await GET[0](signInContext({ error: 'github' }) as never, async () => undefined) as Response
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('GitHub 登录失败。请检查 OAuth 配置后重试。')
  })
})

function signInContext(query: Record<string, string | undefined> = {}) {
  return {
    req: {
      query(name: string) {
        return query[name]
      }
    },
    render: vi.fn(async (body: unknown) => (
      new Response(await renderToString(body as never))
    )),
    redirect: vi.fn((location: string, status = 302) => (
      new Response(null, { status, headers: { location } })
    ))
  }
}
