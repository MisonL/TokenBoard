import { describe, expect, test } from 'vitest'
import {
  MODEL_PRICING_CLIENT_CACHE_CONTROL,
  MODEL_PRICING_WORKER_CACHE_CONTROL,
  createModelPricingResponse
} from './http'

// A success carries the catalogue's own cache policy, but a failure is not a cacheable
// representation of the catalogue at all. Caching the 503 that a transient upstream problem
// produces would turn a momentary fault into a sustained one for as long as the entry lives,
// and the same applies to a 400 for a malformed query. The validation path is reachable
// without a database, so the invalid-limit case pins the behaviour.
describe('model pricing error responses', () => {
  const db = {} as D1Database

  test('does not let an error response inherit the catalogue cache policy', async () => {
    const response = await createModelPricingResponse({
      db,
      searchParams: new URLSearchParams({ limit: '0' })
    })

    expect(response.status).toBe(400)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('cache-control')).not.toBe(MODEL_PRICING_CLIENT_CACHE_CONTROL)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'BAD_REQUEST' } })
  })

  test('rejects a non-numeric limit the same way', async () => {
    const response = await createModelPricingResponse({
      db,
      searchParams: new URLSearchParams({ limit: 'abc' })
    })

    expect(response.status).toBe(400)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })
})

// The zone the app is deployed on rewrites a short positive `max-age` to the four-hour
// Browser Cache TTL, so the previous `max-age=60` reached clients as `max-age=14400`.
// `max-age=0, must-revalidate` is passed through untouched — the same policy the public
// cards already ship with — and the generation-bound ETag turns the revalidation into a 304.
describe('model pricing cache policy', () => {
  test('tells clients to revalidate rather than accept a rewritten lifetime', () => {
    expect(MODEL_PRICING_CLIENT_CACHE_CONTROL).toBe('public, max-age=0, must-revalidate')
    // A positive max-age is exactly what the zone overrides, so it must not come back.
    expect(MODEL_PRICING_CLIENT_CACHE_CONTROL).not.toMatch(/max-age=(?!0\b)\d+/)
  })

  test('keeps the Worker cache entry separate from what the client is told', () => {
    // One constant for both would mean either an edge entry that expires immediately or a
    // client told a lifetime this code never chose.
    expect(MODEL_PRICING_WORKER_CACHE_CONTROL).not.toBe(MODEL_PRICING_CLIENT_CACHE_CONTROL)
    expect(MODEL_PRICING_WORKER_CACHE_CONTROL).toContain('max-age=300')
  })
})
