import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ApiError } from '../../../lib/errors'
import { getModelPricing } from '../../../features/model-pricing/service'
import { GET } from './model-pricing'

vi.mock('../../../features/model-pricing/service', () => ({
  getModelPricing: vi.fn(),
  maxModelPricingPageSize: 1_000
}))

const mockedGetModelPricing = vi.mocked(getModelPricing)
const originalCaches = globalThis.caches

describe('public model pricing route', () => {
  beforeEach(() => {
    mockedGetModelPricing.mockReset()
  })

  afterEach(() => {
    globalThis.caches = originalCaches
  })

  test('accepts the public catalogue path and forwards parsed filters', async () => {
    mockedGetModelPricing.mockResolvedValue({
      state: {
        status: 'failed',
        sourceUrl: 'https://models.dev/api.json',
        lastError: 'private failure detail'
      },
      models: [],
      nextCursor: null
    } as never)
    const url =
      'https://tokenboard.example/api/public/model-pricing?provider=%20deepseek%20&includeInactive=1&limit=25&cursor=opaque'
    const request = new Request(url)
    const context = {
      env: { DB: {} },
      req: {
        url,
        raw: request,
        query: (name: string) => new URL(url).searchParams.get(name)
      },
      header: vi.fn(),
      json: vi.fn((body: unknown, status = 200) => Response.json(body, { status }))
    }

    const response = (await GET[0](context as never, async () => undefined)) as Response

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ models: [], nextCursor: null })
    expect(mockedGetModelPricing).toHaveBeenCalledWith({
      db: context.env.DB,
      provider: 'deepseek',
      includeInactive: true,
      limit: 25,
      cursor: 'opaque'
    })
    // Revalidate rather than a positive lifetime: the zone rewrites a short positive
    // `max-age` to its four-hour Browser Cache TTL, which this code never chose.
    expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
    expect(response.headers.get('etag')).toMatch(/^"[0-9a-f]{64}"$/)
  })

  test('treats whitespace-only optional filters as absent', async () => {
    mockedGetModelPricing.mockResolvedValue({ state: null, models: [], nextCursor: null })
    const url = 'https://tokenboard.example/api/public/model-pricing?provider=%20%20'
    const request = new Request(url)
    const context = {
      env: { DB: {} },
      req: { url, raw: request, query: (name: string) => new URL(url).searchParams.get(name) },
      header: vi.fn(),
      json: vi.fn((body: unknown, status = 200) => Response.json(body, { status }))
    }

    const response = (await GET[0](context as never, async () => undefined)) as Response

    expect(response.status).toBe(200)
    expect(mockedGetModelPricing).toHaveBeenCalledWith({
      db: context.env.DB,
      provider: undefined,
      includeInactive: false,
      limit: undefined,
      cursor: undefined
    })
  })

  test('accepts explicit includeInactive false', async () => {
    mockedGetModelPricing.mockResolvedValue({ state: null, models: [], nextCursor: null })
    const url = 'https://tokenboard.example/api/public/model-pricing?includeInactive=0'
    const request = new Request(url)
    const context = createContext(url, request)

    const response = (await GET[0](context as never, async () => undefined)) as Response

    expect(response.status).toBe(200)
    expect(mockedGetModelPricing).toHaveBeenCalledWith({
      db: context.env.DB,
      provider: undefined,
      includeInactive: false,
      limit: undefined,
      cursor: undefined
    })
  })

  test('rejects provider filters outside the source id contract', async () => {
    for (const provider of ['OpenAI', 'provider/with-slash', `x${'a'.repeat(64)}`]) {
      const url = `https://tokenboard.example/api/public/model-pricing?provider=${encodeURIComponent(provider)}`
      const request = new Request(url)
      const context = {
        env: { DB: {} },
        req: { url, raw: request, query: (name: string) => new URL(url).searchParams.get(name) },
        header: vi.fn(),
        json: vi.fn((body: unknown, status = 200) => Response.json(body, { status }))
      }

      const response = (await GET[0](context as never, async () => undefined)) as Response
      expect(response.status).toBe(400)
    }
    expect(mockedGetModelPricing).not.toHaveBeenCalled()
  })

  test('returns 304 for a matching generation ETag', async () => {
    mockedGetModelPricing.mockResolvedValue({
      state: {
        status: 'success',
        sourceUrl: 'https://models.dev/api.json',
        lastStartedAt: '2026-08-07T00:00:00.000Z',
        lastSuccessAt: '2026-08-07T00:00:00.000Z',
        lastFailureAt: null,
        lastSourceUpdatedAt: '2026-08-07',
        modelCount: 0,
        activeGeneration: 'generation-one',
        lastError: null,
        updatedAt: '2026-08-07T00:00:00.000Z'
      },
      models: [],
      nextCursor: null
    } as never)
    const url = 'https://tokenboard.example/api/public/model-pricing?limit=25'
    const firstRequest = new Request(url)
    const firstContext = createContext(url, firstRequest)
    const firstResponse = (await GET[0](firstContext as never, async () => undefined)) as Response
    const etag = firstResponse.headers.get('etag')
    expect(etag).toBeTruthy()

    const secondRequest = new Request(url, { headers: { 'if-none-match': etag ?? '' } })
    const secondContext = createContext(url, secondRequest)
    const secondResponse = (await GET[0](secondContext as never, async () => undefined)) as Response

    expect(secondResponse.status).toBe(304)
    expect(secondResponse.headers.get('etag')).toBe(etag)

    const weakRequest = new Request(url, { headers: { 'if-none-match': `W/${etag ?? ''}` } })
    const weakContext = createContext(url, weakRequest)
    const weakResponse = (await GET[0](weakContext as never, async () => undefined)) as Response

    expect(weakResponse.status).toBe(304)
    expect(weakResponse.headers.get('etag')).toBe(etag)
  })

  test('keeps the ETag stable when only sync metadata timestamps change', async () => {
    const state = {
      status: 'success' as const,
      sourceUrl: 'https://models.dev/api.json',
      lastStartedAt: '2026-08-07T00:00:00.000Z',
      lastSuccessAt: '2026-08-07T00:00:00.000Z',
      lastFailureAt: null,
      lastSourceUpdatedAt: '2026-08-07',
      modelCount: 0,
      activeGeneration: 'generation-one',
      lastError: null,
      updatedAt: '2026-08-07T00:00:00.000Z'
    }
    mockedGetModelPricing.mockResolvedValueOnce({ state, models: [], nextCursor: null }).mockResolvedValueOnce({
      state: { ...state, updatedAt: '2026-08-07T00:05:00.000Z' },
      models: [],
      nextCursor: null
    })
    const url = 'https://tokenboard.example/api/public/model-pricing?limit=25'
    const first = (await GET[0](createContext(url, new Request(url)) as never, async () => undefined)) as Response
    const etag = first.headers.get('etag')
    const second = (await GET[0](
      createContext(url, new Request(url, { headers: { 'if-none-match': etag ?? '' } })) as never,
      async () => undefined
    )) as Response

    expect(second.status).toBe(304)
    expect(second.headers.get('etag')).toBe(etag)
  })

  test('returns 503 when a stable catalogue cannot be read', async () => {
    mockedGetModelPricing.mockRejectedValue(
      new ApiError('SERVICE_UNAVAILABLE', 'Model pricing catalogue is temporarily unavailable; retry the request', 503)
    )
    const url = 'https://tokenboard.example/api/public/model-pricing'
    const request = new Request(url)
    const response = (await GET[0](createContext(url, request) as never, async () => undefined)) as Response

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Model pricing catalogue is temporarily unavailable; retry the request'
      }
    })
  })

  test('does not fail when the runtime has no execution context', async () => {
    mockedGetModelPricing.mockResolvedValue({ state: null, models: [], nextCursor: null })
    const cachePut = vi.fn(async () => undefined)
    globalThis.caches = {
      default: {
        match: vi.fn(async () => undefined),
        put: cachePut
      }
    } as unknown as CacheStorage
    const url = 'https://tokenboard.example/api/public/model-pricing'
    const request = new Request(url)
    const context = {
      env: { DB: {} },
      req: { url, raw: request, query: (name: string) => new URL(url).searchParams.get(name) },
      get executionCtx(): ExecutionContext {
        throw new Error('This context has no ExecutionContext')
      },
      header: vi.fn(),
      json: vi.fn((body: unknown, status = 200) => Response.json(body, { status }))
    }

    const response = (await GET[0](context as never, async () => undefined)) as Response

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ models: [], nextCursor: null })
    expect(cachePut).toHaveBeenCalledOnce()
  })

  // What the Worker stores and what a client is told are deliberately different lifetimes.
  // The zone rewrites a short positive `max-age` to the four-hour Browser Cache TTL, so the
  // response that reaches a client has to say `max-age=0, must-revalidate`; the stored copy
  // keeps the longer life so an edge hit does not reach D1. One constant for both would mean
  // either a useless cache entry or a client told a lifetime this code never chose.
  test('stores under the worker lifetime and answers under the client lifetime', async () => {
    mockedGetModelPricing.mockResolvedValue({ state: null, models: [], nextCursor: null })
    let stored: Response | undefined
    globalThis.caches = {
      default: {
        match: vi.fn(async () => undefined),
        put: vi.fn(async (_key: Request, response: Response) => {
          stored = response
        })
      }
    } as unknown as CacheStorage
    const url = 'https://tokenboard.example/api/public/model-pricing'
    const response = (await GET[0](createContext(url, new Request(url)) as never, async () => undefined)) as Response

    expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
    expect(stored?.headers.get('cache-control')).toBe('public, max-age=300')
  })

  test('applies the client lifetime to an edge-cache hit too', async () => {
    const cached = Response.json(
      { models: [], nextCursor: null },
      { headers: { 'cache-control': 'public, max-age=300' } }
    )
    globalThis.caches = {
      default: {
        match: vi.fn(async () => cached),
        put: vi.fn(async () => undefined)
      }
    } as unknown as CacheStorage
    const url = 'https://tokenboard.example/api/public/model-pricing'
    const response = (await GET[0](createContext(url, new Request(url)) as never, async () => undefined)) as Response

    // Serving the stored header verbatim is exactly how a client ends up being told a
    // lifetime the zone then rewrites.
    expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
  })

  // An error must not be given the client cache policy. `modelPricingErrorResponse` sets
  // `no-store` precisely so a transient 503 is not cached into a sustained one, and applying
  // the success policy unconditionally here silently overwrote it.
  test('leaves error responses uncacheable rather than applying the client policy', async () => {
    mockedGetModelPricing.mockRejectedValue(
      new ApiError('SERVICE_UNAVAILABLE', 'Model pricing catalogue is temporarily unavailable', 503)
    )
    globalThis.caches = {
      default: {
        match: vi.fn(async () => undefined),
        put: vi.fn(async () => undefined)
      }
    } as unknown as CacheStorage
    const url = 'https://tokenboard.example/api/public/model-pricing'
    const response = (await GET[0](createContext(url, new Request(url)) as never, async () => undefined)) as Response

    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  // A 304 must carry the same cache directives as the 200 it replaces. Testing `response.ok`
  // would miss it, because `ok` is false for 304 — the revalidating client would then be
  // handed this route's `max-age=60`, which the zone rewrites to four hours.
  test('gives a revalidation the client policy, not the collector lifetime', async () => {
    mockedGetModelPricing.mockResolvedValue({ state: null, models: [], nextCursor: null })
    globalThis.caches = {
      default: {
        match: vi.fn(async () => undefined),
        put: vi.fn(async () => undefined)
      }
    } as unknown as CacheStorage
    const url = 'https://tokenboard.example/api/public/model-pricing'
    const first = (await GET[0](createContext(url, new Request(url)) as never, async () => undefined)) as Response
    const etag = first.headers.get('etag')
    expect(etag).toBeTruthy()

    const revalidated = (await GET[0](
      createContext(url, new Request(url, { headers: { 'if-none-match': etag! } })) as never,
      async () => undefined
    )) as Response

    expect(revalidated.status).toBe(304)
    expect(revalidated.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
  })

  test('preserves API error headers', async () => {
    mockedGetModelPricing.mockRejectedValue(
      new ApiError('RATE_LIMITED', 'Too many requests', 429, { 'Retry-After': '30' })
    )
    const url = 'https://tokenboard.example/api/public/model-pricing'
    const response = (await GET[0](createContext(url, new Request(url)) as never, async () => undefined)) as Response

    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBe('30')
  })
})

function createContext(url: string, request: Request) {
  return {
    env: { DB: {} },
    req: {
      url,
      raw: request,
      query: (name: string) => new URL(url).searchParams.get(name)
    },
    header: vi.fn(),
    json: vi.fn((body: unknown, status = 200) => Response.json(body, { status }))
  }
}
