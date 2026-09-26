import { describe, expect, test } from 'vitest'
import { ApiError } from '../lib/errors'
import handler from './_error'

describe('error route', () => {
  test('redirects unauthenticated page requests to sign-in', async () => {
    const response = await handler(
      new ApiError('UNAUTHORIZED', 'Authentication required', 401),
      createContext('/dashboard/details')
    )

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/auth/sign-in')
  })

  test('returns JSON for unauthenticated API requests', async () => {
    const response = await handler(
      new ApiError('UNAUTHORIZED', 'Authentication required', 401),
      createContext('/api/v1/me', 'application/json')
    )

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authentication required'
      }
    })
  })

  test('preserves API error headers in the global JSON handler', async () => {
    const response = await handler(
      new ApiError('RATE_LIMITED', 'Too many requests', 429, { 'Retry-After': '30' }),
      createContext('/api/v1/me', 'application/json')
    )

    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBe('30')
  })

  test('preserves Hono HTTPException responses', async () => {
    const original = new Response('not found', { status: 404 })
    const response = await handler(
      Object.assign(new Error('not found'), { getResponse: () => original }),
      createContext('/missing')
    )

    expect(response).toBe(original)
  })
})

function createContext(path: string, accept = 'text/html') {
  return {
    req: {
      path,
      header: (name: string) => (name.toLowerCase() === 'accept' ? accept : null)
    },
    json: (body: unknown, status: number, headers?: Record<string, string>) => Response.json(body, { status, headers }),
    redirect: (location: string) =>
      new Response(null, {
        status: 302,
        headers: { location }
      }),
    status() {},
    header() {},
    render: (body: string) => new Response(body)
  } as never
}
