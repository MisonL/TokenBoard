import { createRoute } from 'honox/factory'
import { createModelPricingResponse } from '../../../features/model-pricing/http'

// Keep the versioned path as a stable compatibility alias for collectors.
// The public route owns the Worker Cache API; collectors must read the current
// catalogue from D1 instead of sharing that public cache entry.
export const GET = createRoute(async (c) => {
  return createModelPricingResponse({
    db: c.env.DB,
    searchParams: new URL(c.req.url).searchParams,
    requestHeaders: c.req.raw.headers
  })
})
