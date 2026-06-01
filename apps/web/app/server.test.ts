import { describe, expect, test, vi } from 'vitest'
import worker from './server'

describe('worker server', () => {
  test('serves public SVG cards through the worker entrypoint', async () => {
    const response = await worker.fetch(
      workerRequest('https://tokenboard.example/api/public/eve.svg'),
      createEnv({ publicProfile: true }),
      createExecutionContext()
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/svg+xml; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('public, max-age=300')
    expect(await response.text()).toContain('<svg')
  })

  test('serves percent-encoded public SVG extensions through the worker entrypoint', async () => {
    const env = createEnv({ publicProfile: true })
    const response = await worker.fetch(
      workerRequest('https://tokenboard.example/api/public/eve%2Esvg'),
      env,
      createExecutionContext()
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/svg+xml; charset=utf-8')
    expect(await response.text()).toContain('<svg')
    expect(env.boundValues[0]).toEqual(['eve'])
  })

  test('serves percent-encoded public JSON extensions through the worker entrypoint', async () => {
    const env = createEnv({ publicProfile: true })
    const response = await worker.fetch(
      workerRequest('https://tokenboard.example/api/public/eve%2Ejson'),
      env,
      createExecutionContext()
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    await expect(response.json()).resolves.toMatchObject({
      slug: 'eve',
      displayName: 'Eve'
    })
    expect(env.boundValues[0]).toEqual(['eve'])
  })

  test('does not serve public content for unsupported public API methods', async () => {
    const env = createEnv({ publicProfile: true })
    const response = await worker.fetch(
      workerRequest('https://tokenboard.example/api/public/eve.json', { method: 'POST' }),
      env,
      createExecutionContext()
    )

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/json')
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Route not found'
      }
    })
    expect(env.DB.prepare).not.toHaveBeenCalled()
    expect(env.ASSETS.fetch).not.toHaveBeenCalled()
  })

  test('returns JSON 404 for missing public profiles', async () => {
    const response = await worker.fetch(
      workerRequest('https://tokenboard.example/api/public/missing-user.json'),
      createEnv(),
      createExecutionContext()
    )

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/json')
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Public profile not found'
      }
    })
  })

  test('rejects unsupported public API extensions with JSON', async () => {
    const response = await worker.fetch(
      workerRequest('https://tokenboard.example/api/public/missing-user.txt'),
      createEnv(),
      createExecutionContext()
    )

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/json')
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Public route not found'
      }
    })
  })

  test('rejects malformed public API path encoding with JSON', async () => {
    const env = createEnv()
    const response = await worker.fetch(
      workerRequest('https://tokenboard.example/api/public/%E0%A4%A.json'),
      env,
      createExecutionContext()
    )

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/json')
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Public route not found'
      }
    })
    expect(env.DB.prepare).not.toHaveBeenCalled()
  })

  test('falls back to the assets binding for static 404 responses', async () => {
    const env = createEnv()
    const response = await worker.fetch(
      workerRequest('https://tokenboard.example/static/style.css'),
      env,
      createExecutionContext()
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('asset response')
    expect(env.ASSETS.fetch).toHaveBeenCalledOnce()
  })

  test('falls back to assets for extension static files outside static directory', async () => {
    const env = createEnv()
    const response = await worker.fetch(
      workerRequest('https://tokenboard.example/manifest.json'),
      env,
      createExecutionContext()
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('asset response')
    expect(env.ASSETS.fetch).toHaveBeenCalledOnce()
  })

  test('does not use assets fallback for API 404 responses', async () => {
    const env = createEnv()
    const response = await worker.fetch(
      workerRequest('https://tokenboard.example/api/v1/missing.json'),
      env,
      createExecutionContext()
    )

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/json')
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Route not found'
      }
    })
    expect(env.ASSETS.fetch).not.toHaveBeenCalled()
  })
})

function createEnv(options: { publicProfile?: boolean } = {}) {
  const boundValues: unknown[][] = []
  return {
    DB: createDb(options, boundValues),
    ASSETS: {
      fetch: vi.fn(async () => new Response('asset response', { status: 200 }))
    },
    BETTER_AUTH_URL: 'https://tokenboard.example',
    boundValues
  }
}

function createDb(options: { publicProfile?: boolean } = {}, boundValues: unknown[][] = []) {
  return {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn((...values: unknown[]) => {
        boundValues.push(values)
        return {
          first: vi.fn(async () => {
            if (sql.includes('FROM profiles')) {
              if (!options.publicProfile) return null
              return {
                userId: 'user_1',
                slug: 'eve',
                displayName: 'Eve',
                timezone: 'UTC',
                publicCardConfig: null,
                isPublic: 1
              }
            }

            return {
              totalTokens: 1200,
              totalTokensWithoutCacheRead: 900,
              totalCostUsd: 3.75,
              todayTokens: 100,
              todayTokensWithoutCacheRead: 70,
              todayCostUsd: 0.2,
              monthTokens: 500,
              monthTokensWithoutCacheRead: 380,
              monthCostUsd: 1.5
            }
          }),
          all: vi.fn(async () => ({ results: [] }))
        }
      })
    }))
  } as unknown as D1Database
}

function createExecutionContext() {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props: {}
  } as ExecutionContext
}

function workerRequest(url: string, init?: RequestInit) {
  return new Request(url, init) as Parameters<typeof worker.fetch>[0]
}
