import { describe, expect, test } from 'vitest'
import type { Context } from 'hono'
import { jsonError } from './http'
import { ApiError } from './errors'
import { ZodError } from 'zod'

function fakeContext() {
  const captured: { status?: number; body?: unknown; headers?: Record<string, string> } = {}
  const c = {
    json(body: unknown, status = 200, headers?: Record<string, string>) {
      captured.body = body
      captured.status = status
      captured.headers = headers
      return new Response(JSON.stringify(body), { status })
    }
  } as unknown as Context
  return { c, captured }
}

describe('jsonError', () => {
  test('maps an ApiError to its own status and code', () => {
    const { c, captured } = fakeContext()
    jsonError(c, new ApiError('NOT_FOUND', 'Profile not found', 404))
    expect(captured.status).toBe(404)
    expect(captured.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Profile not found' } })
  })

  test('maps a ZodError to a 400', () => {
    const { c, captured } = fakeContext()
    jsonError(c, new ZodError([]))
    expect(captured.status).toBe(400)
    expect(captured.body).toEqual({ error: { code: 'BAD_REQUEST', message: 'Invalid request' } })
  })

  // A body that is not JSON is the caller's mistake, not a server fault. It used
  // to fall through to the 500 branch, which also made the collector treat a
  // permanently malformed request as a transient failure worth retrying.
  test.each([
    ['SyntaxError from body parsing', new SyntaxError('Unexpected token b in JSON at position 0')],
    ['SyntaxError with no message', new SyntaxError()]
  ])('maps %s to a 400 rather than a 500', (_label, error) => {
    const { c, captured } = fakeContext()
    jsonError(c, error)
    expect(captured.status).toBe(400)
    expect(captured.body).toEqual({ error: { code: 'BAD_REQUEST', message: 'Invalid request' } })
  })

  test('still reports an unexpected error as a 500', () => {
    const { c, captured } = fakeContext()
    jsonError(c, new Error('database is on fire'))
    expect(captured.status).toBe(500)
    expect(captured.body).toEqual({ error: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' } })
  })

  // Error responses must not sit in any cache, matching `publicApiErrorResponse` and
  // `modelPricingErrorResponse`: a cached 401 keeps showing a stale failure, and without a
  // directive a browser may cache a 404 heuristically. This helper is the shared exit for
  // every API error branch, so the header is set here rather than at each call site.
  test.each([
    ['an ApiError', new ApiError('NOT_FOUND', 'Profile not found', 404)],
    ['a ZodError', new ZodError([])],
    ['a SyntaxError', new SyntaxError('Unexpected token b in JSON at position 0')],
    ['an unexpected error', new Error('database is on fire')]
  ])('marks %s response as no-store', (_label, error) => {
    const { c, captured } = fakeContext()
    jsonError(c, error)
    expect(captured.headers?.['Cache-Control']).toBe('no-store')
  })

  test('keeps the error-specific headers next to no-store', () => {
    const { c, captured } = fakeContext()
    jsonError(c, new ApiError('RATE_LIMITED', 'Too many requests', 429, { 'Retry-After': '30' }))
    expect(captured.headers).toEqual({ 'Retry-After': '30', 'Cache-Control': 'no-store' })
  })

  // RFC 9110: a 401 should carry a challenge so a generic client knows the scheme. The app's
  // 401s are the collector's only signal about its upload token, which is always a bearer token.
  test('marks a 401 with the Bearer challenge', () => {
    const { c, captured } = fakeContext()
    jsonError(c, new ApiError('UNAUTHORIZED', 'Missing upload token', 401))
    expect(captured.headers).toEqual({ 'WWW-Authenticate': 'Bearer', 'Cache-Control': 'no-store' })
  })
})
