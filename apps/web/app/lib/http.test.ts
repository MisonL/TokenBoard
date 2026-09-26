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
})
