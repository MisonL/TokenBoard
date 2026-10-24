import { renderToString } from 'hono/jsx/dom/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { getOptionalUser } from '../features/auth/middleware'
import handler from './index'

vi.mock('../features/auth/middleware', () => ({
  getOptionalUser: vi.fn()
}))

const mockedGetOptionalUser = vi.mocked(getOptionalUser)

describe('home route', () => {
  beforeEach(() => {
    mockedGetOptionalUser.mockReset()
  })

  test('redirects authenticated users to the dashboard', async () => {
    mockedGetOptionalUser.mockResolvedValue({ id: 'user_1', email: 'user@example.com' } as never)

    const response = (await handler[0](homeContext() as never, async () => undefined)) as Response

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/dashboard')
  })

  // The page reads the session to decide between the marketing copy and a redirect to the
  // dashboard, so a shared browser cache must not replay either branch to the next visitor.
  test('does not let the page be cached', async () => {
    mockedGetOptionalUser.mockResolvedValue(null)

    const response = (await handler[0](homeContext() as never, async () => undefined)) as Response

    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  test('keeps hero copy wrapped inside narrow mobile viewports', async () => {
    mockedGetOptionalUser.mockResolvedValue(null)

    const response = (await handler[0](homeContext() as never, async () => undefined)) as Response
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('grid-cols-[minmax(0,1fr)]')
    expect(html).toContain('lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]')
    expect(html).toContain('relative z-10 min-w-0')
    expect(html).toContain('relative z-10 min-w-0 max-w-full overflow-hidden')
    expect(html).toContain('flex flex-wrap justify-between gap-2')
    expect(html).toContain('[overflow-wrap:anywhere] sm:max-w-4xl')
    expect(html).toContain('[overflow-wrap:anywhere] sm:max-w-2xl')
  })
})

function homeContext() {
  const headers = new Headers()
  return {
    header: (name: string, value: string) => {
      headers.set(name, value)
    },
    render: vi.fn(async (body: unknown) => new Response(await renderToString(body as never), { headers })),
    redirect: vi.fn((location: string, status = 302) => new Response(null, { status, headers: { location } }))
  }
}
