import { z, ZodError } from 'zod'
import { ApiError } from '../../lib/errors'
import { sha256Hex } from '../../lib/crypto'
import { getModelPricing } from './service'
import { modelPricingLimitSchema, modelPricingProviderSchema } from './validation'

// The versioned route's policy. It is the collector's path, it is not under `/api/public`,
// and the zone's Cache Rule does not match it — measured on the deployed zone, this value
// reaches clients unchanged. A short lifetime is right here: the collector keeps its own
// 24-hour cache and only revalidates with the ETag.
export const MODEL_PRICING_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=300'

// The public route's policy, which does have to survive that Cache Rule. It treats a short
// positive `max-age` as "not set" and substitutes the four-hour Browser Cache TTL, so the
// `max-age=60` above reached clients as `max-age=14400` — 240x what this code chose. Two
// values are passed through untouched, and both are measured on the zone: `no-store`, and
// `max-age=0, must-revalidate` — the latter being what the public cards already ship. A zero
// lifetime with `must-revalidate` is therefore both honest and durable: nothing may serve a
// stale copy, and the generation-bound ETag makes each revalidation a 304.
//
// The Worker's own entry is separate, so an edge hit does not have to reach D1. That split
// mirrors `server.ts`, which stores cards under `PUBLIC_API_WORKER_CACHE_CONTROL` and
// answers under `PUBLIC_API_CLIENT_CACHE_CONTROL`.
export const MODEL_PRICING_WORKER_CACHE_CONTROL = 'public, max-age=300'
export const MODEL_PRICING_CLIENT_CACHE_CONTROL = 'public, max-age=0, must-revalidate'
const modelPricingCacheQueryKeys = ['provider', 'includeInactive', 'limit', 'cursor'] as const

const modelPricingQuerySchema = z.object({
  provider: z.preprocess(normalizeOptionalQueryValue, modelPricingProviderSchema.optional()),
  includeInactive: z
    .preprocess(normalizeOptionalQueryValue, z.enum(['0', '1']).optional())
    .transform((value) => value === '1'),
  limit: z.preprocess(normalizeOptionalQueryValue, modelPricingLimitSchema.optional()),
  cursor: z.preprocess(normalizeOptionalQueryValue, z.string().min(1).optional())
})

export async function createModelPricingResponse(input: {
  db: D1Database
  searchParams: URLSearchParams
  requestHeaders?: Headers
}) {
  try {
    const query = modelPricingQuerySchema.parse({
      provider: input.searchParams.get('provider'),
      includeInactive: input.searchParams.get('includeInactive'),
      limit: input.searchParams.get('limit'),
      cursor: input.searchParams.get('cursor')
    })
    const result = await getModelPricing({
      db: input.db,
      provider: query.provider,
      includeInactive: query.includeInactive,
      limit: query.limit,
      cursor: query.cursor
    })
    const body = { models: result.models, nextCursor: result.nextCursor }
    const etag = `"${await sha256Hex(
      JSON.stringify({
        generation: result.state?.activeGeneration ?? null,
        body
      })
    )}"`
    const headers = new Headers({ 'Cache-Control': MODEL_PRICING_CACHE_CONTROL, ETag: etag })
    return applyModelPricingConditionalResponse(Response.json(body, { headers }), input.requestHeaders)
  } catch (error) {
    return modelPricingErrorResponse(error)
  }
}

export async function createCachedModelPricingResponse(input: {
  db: D1Database
  url: URL
  requestHeaders?: Headers
  waitUntil?: (promise: Promise<unknown>) => void
}) {
  const cache = modelPricingCache()
  const cacheKey = modelPricingCacheKey(input.url)
  const cached = cache ? await cache.match(cacheKey) : undefined
  if (cached) {
    // A cached entry is a 200 by construction (only 200s are stored below), so the client
    // policy applies.
    return applyModelPricingConditionalResponse(clientCacheResponse(cached), input.requestHeaders)
  }

  const response = await createModelPricingResponse({
    db: input.db,
    searchParams: input.url.searchParams,
    requestHeaders: input.requestHeaders
  })
  if (cache && response.status === 200) {
    // Stored under the Worker policy, handed back under the client one, so an edge hit
    // never tells a client the longer lifetime.
    const cacheWrite = cache.put(cacheKey, workerCacheResponse(response.clone()))
    if (input.waitUntil) {
      input.waitUntil(cacheWrite)
    } else {
      await cacheWrite
    }
  }
  // A catalogue response gets the client policy; an error keeps the `no-store` that
  // `modelPricingErrorResponse` set, since overriding it would re-cache the very 400/503
  // that rule exists to keep out. The check is on the status rather than `response.ok`
  // because `ok` is false for 304 — and a 304 has to carry the same cache directives as the
  // 200 it stands in for, or a revalidating client would be handed the `max-age=60` this
  // route exists to avoid, which the zone then rewrites to four hours.
  return response.status === 200 || response.status === 304 ? clientCacheResponse(response) : response
}

function workerCacheResponse(response: Response) {
  return withCacheControl(response, MODEL_PRICING_WORKER_CACHE_CONTROL)
}

function clientCacheResponse(response: Response) {
  return withCacheControl(response, MODEL_PRICING_CLIENT_CACHE_CONTROL)
}

function withCacheControl(response: Response, cacheControl: string) {
  const headers = new Headers(response.headers)
  headers.set('Cache-Control', cacheControl)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  })
}

export function modelPricingCacheKey(url: URL) {
  const cacheUrl = new URL('/api/public/model-pricing', url.origin)
  for (const key of modelPricingCacheQueryKeys) {
    const value = url.searchParams.get(key)?.trim()
    if (value) cacheUrl.searchParams.set(key, value)
  }
  return new Request(cacheUrl.toString())
}

export function modelPricingCache() {
  const workerCaches = typeof caches === 'undefined' ? null : (caches as unknown as { default?: Cache })
  return workerCaches?.default ?? null
}

export function applyModelPricingConditionalResponse(response: Response, requestHeaders?: Headers) {
  const etag = response.headers.get('etag')
  if (response.status === 200 && etag && matchesEtag(requestHeaders?.get('if-none-match'), etag)) {
    return new Response(null, {
      status: 304,
      headers: response.headers
    })
  }
  return response
}

function matchesEtag(value: string | null | undefined, etag: string) {
  const expected = normalizeEtag(etag)
  return (
    value?.split(',').some((candidate) => {
      const trimmed = candidate.trim()
      return trimmed === '*' || normalizeEtag(trimmed) === expected
    }) ?? false
  )
}

function normalizeEtag(value: string) {
  const trimmed = value.trim()
  return trimmed.startsWith('W/') ? trimmed.slice(2).trim() : trimmed
}

// Errors are answered `no-store` while successes carry the catalogue's own cache policy. A
// failure is not a cacheable representation of the catalogue: caching the 503 that a
// transient upstream problem produces would turn a momentary fault into a sustained one for
// as long as the entry lives.
function modelPricingErrorResponse(error: unknown) {
  const noStore = { 'Cache-Control': 'no-store' }
  if (error instanceof ApiError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status, headers: { ...error.headers, ...noStore } }
    )
  }

  if (error instanceof ZodError) {
    return Response.json(
      { error: { code: 'BAD_REQUEST', message: 'Invalid request' } },
      { status: 400, headers: noStore }
    )
  }

  return Response.json(
    { error: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' } },
    { status: 500, headers: noStore }
  )
}

function normalizeOptionalQueryValue(value: unknown) {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'string') return value
  const normalized = value.trim()
  return normalized || undefined
}
