import { createRoute } from 'honox/factory'
import {
  createPublicUsageResponse,
  parsePublicUsageSegment,
  publicApiErrorResponse
} from '../../../features/public-card/http'

export const GET = createRoute(async (c) => {
  try {
    const params = c.req.param() as Record<string, string | undefined>
    const route = parsePublicUsageSegment(params.slug ?? '')
    return await createPublicUsageResponse({
      db: c.env.DB,
      route,
      configuredOrigin: c.env.BETTER_AUTH_URL,
      requestOrigin: new URL(c.req.url).origin
    })
  } catch (error) {
    return publicApiErrorResponse(error)
  }
})
