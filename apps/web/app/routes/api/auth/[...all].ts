import { createRoute } from 'honox/factory'
import { createAuth } from '../../../features/auth/auth'
import { normalizeAuthErrorResponse } from '../../../features/auth/error-response'
import { jsonError } from '../../../lib/http'

// Wrapped so a failed sign-in answers in the same `{ error: { code, message } }` shape
// every other route uses, instead of Better Auth's `{ message, code }`. The try/catch is
// required, not defensive: `createAuth` throws a plain `Error` when `BETTER_AUTH_SECRET` is
// missing, and without it that would reach the generic error page as an HTML 500 body —
// breaking the API error contract for a JSON client.
export const GET = createRoute(async (c) => {
  try {
    return normalizeAuthErrorResponse(await createAuth(c.env, c.req.raw).handler(c.req.raw))
  } catch (error) {
    return jsonError(c, error)
  }
})
export const POST = createRoute(async (c) => {
  try {
    return normalizeAuthErrorResponse(await createAuth(c.env, c.req.raw).handler(c.req.raw))
  } catch (error) {
    return jsonError(c, error)
  }
})
