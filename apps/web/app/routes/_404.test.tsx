import { describe, expect, test } from 'vitest'
import handler from './_404'

describe('not found route', () => {
  test('returns JSON for API routes', async () => {
    const response = await handler(createContext('/api/v1/missing'))

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/json')
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
    expect(await response.text()).toBe('404 Not Found')
  })
})

function createContext(path: string) {
  return {
    req: { path },
    json: (body: unknown, status: number) => Response.json(body, { status }),
    status() {},
    render: (body: string) => new Response(body, { status: 404 })
  } as never
}
