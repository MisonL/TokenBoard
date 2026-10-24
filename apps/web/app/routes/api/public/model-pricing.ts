import { createRoute } from 'honox/factory'
import { createCachedModelPricingResponse } from '../../../features/model-pricing/http'

export const GET = createRoute(async (c) => {
  const url = new URL(c.req.url)
  const executionContext = readExecutionContext(c)
  return createCachedModelPricingResponse({
    db: c.env.DB,
    url,
    requestHeaders: c.req.raw.headers,
    waitUntil: executionContext?.waitUntil.bind(executionContext)
  })
})

function readExecutionContext(value: unknown) {
  try {
    const executionContext = (value as { executionCtx?: unknown }).executionCtx
    if (!executionContext || typeof executionContext !== 'object') return undefined
    if (!('waitUntil' in executionContext) || typeof executionContext.waitUntil !== 'function') return undefined
    return executionContext as ExecutionContext
  } catch {
    return undefined
  }
}
