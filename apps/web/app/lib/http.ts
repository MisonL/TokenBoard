import type { Context } from 'hono'
import { ZodError } from 'zod'
import { ApiError } from './errors'

// Every branch answers `no-store`, matching `publicApiErrorResponse` and
// `modelPricingErrorResponse`: a cached 401 keeps showing a stale failure, and without a
// directive a browser may cache a 404 heuristically. Set here rather than at each call site
// so no error branch can be added without it.
const noStore = { 'Cache-Control': 'no-store' }

// RFC 9110 §11.6.1: a 401 SHOULD carry a `WWW-Authenticate` challenge. The app's own 401s are
// the collector's only signal that its upload token is missing or wrong, and without the
// challenge a generic client cannot tell which scheme to use.
const unauthorizedHeaders = { ...noStore, 'WWW-Authenticate': 'Bearer' }

export function jsonError(c: Context, error: unknown) {
  if (error instanceof ApiError) {
    return c.json({ error: { code: error.code, message: error.message } }, error.status, {
      ...(error.status === 401 ? unauthorizedHeaders : noStore),
      ...error.headers
    })
  }

  if (error instanceof ZodError) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid request' } }, 400, noStore)
  }

  // A request body that is not JSON cannot be fixed by trying again, so it is the
  // caller's error. Left on the 500 path it also looks transient to the collector,
  // which then retries a permanently malformed upload instead of reporting it.
  if (error instanceof SyntaxError) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid request' } }, 400, noStore)
  }

  return c.json({ error: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' } }, 500, noStore)
}
