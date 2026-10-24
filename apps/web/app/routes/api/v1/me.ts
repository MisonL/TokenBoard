import { createRoute } from 'honox/factory'
import { requireUser } from '../../../features/auth/middleware'
import { jsonError } from '../../../lib/http'

export const GET = createRoute(async (c) => {
  // The only GET in the API that returns account data — id, email, name, image — so it must
  // not sit in any cache. Every other authenticated JSON route here already sets this; this
  // one was missed. Set before the branch rather than on the success path only: a cached
  // 401 would keep showing a signed-in caller a stale error.
  c.header('Cache-Control', 'no-store')
  try {
    const user = await requireUser(c)
    return c.json({ user })
  } catch (error) {
    return jsonError(c, error)
  }
})
