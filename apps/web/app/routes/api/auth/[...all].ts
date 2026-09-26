import { createRoute } from 'honox/factory'
import { createAuth } from '../../../features/auth/auth'
import { normalizeAuthErrorResponse } from '../../../features/auth/error-response'

// Wrapped so a failed sign-in answers in the same `{ error: { code, message } }` shape
// every other route uses, instead of Better Auth's `{ message, code }`.
export const GET = createRoute(async (c) =>
  normalizeAuthErrorResponse(await createAuth(c.env, c.req.raw).handler(c.req.raw))
)
export const POST = createRoute(async (c) =>
  normalizeAuthErrorResponse(await createAuth(c.env, c.req.raw).handler(c.req.raw))
)
