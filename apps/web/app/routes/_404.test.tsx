import { renderToString } from 'hono/jsx/dom/server'
import { describe, expect, test } from 'vitest'
import handler from './_404'

describe('not found route', () => {
  test('returns JSON for API routes', async () => {
    const response = await handler(createContext('/api/v1/missing'))

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/json')
    // A 404 is not a representation of a resource, and without a directive Cloudflare's
    // default cache-by-extension rules can hold on to it — pinning "not found" for a
    // path that may exist later. Every other error surface in the app sets this.
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Route not found'
      }
    })
  })

  test('renders HTML for page routes', async () => {
    const response = await handler(createContext('/missing'))

    expect(response.status).toBe(404)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const html = await response.text()
    expect(html).toContain('404 Not Found')
    // This page renders no `AppNav`, so without its own anchor the shell's skip link would be a
    // dead target here. The anchor has to be in the body the handler returns.
    expect(html).toContain('id="app-content"')
    expect(html).toContain('tabindex="-1"')
  })
})

// Mirrors Hono's context closely enough for this handler: `c.header()` accumulates onto
// the response the handler returns, which is what the cache directive rides on.
function createContext(path: string) {
  const headers: Record<string, string> = {}
  const withHeaders = (response: Response) => {
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value)
    return response
  }
  return {
    req: { path },
    header: (name: string, value: string) => {
      headers[name] = value
    },
    json: (body: unknown, status: number) => withHeaders(Response.json(body, { status })),
    status() {},
    render: (body: unknown) => withHeaders(new Response(renderToString(body as never), { status: 404 }))
  } as never
}
