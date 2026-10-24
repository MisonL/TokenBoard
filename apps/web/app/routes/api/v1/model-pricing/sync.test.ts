import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  modelPricingSyncEnabled,
  parsePricingSyncToken,
  pricingSyncTokenConfigured,
  readModelPricingSyncState,
  runModelPricingSync,
  verifyPricingSyncToken
} from '../../../../features/model-pricing/service'
import { POST } from './sync'
import { assertRateLimitAvailable, enforceRateLimit } from '../../../../lib/rate-limit'
import { ApiError } from '../../../../lib/errors'

vi.mock('../../../../features/model-pricing/service', () => ({
  modelPricingSyncEnabled: vi.fn(),
  parsePricingSyncToken: vi.fn(),
  pricingSyncTokenConfigured: vi.fn(),
  readModelPricingSyncState: vi.fn(),
  runModelPricingSync: vi.fn(),
  verifyPricingSyncToken: vi.fn()
}))

const mockedEnabled = vi.mocked(modelPricingSyncEnabled)
const mockedParse = vi.mocked(parsePricingSyncToken)
const mockedConfigured = vi.mocked(pricingSyncTokenConfigured)
const mockedRun = vi.mocked(runModelPricingSync)
const mockedVerify = vi.mocked(verifyPricingSyncToken)
const mockedState = vi.mocked(readModelPricingSyncState)
const mockedRateLimitAvailable = vi.mocked(assertRateLimitAvailable)
const mockedRateLimit = vi.mocked(enforceRateLimit)

vi.mock('../../../../lib/rate-limit', () => ({
  clientIpRateLimitSubject: vi.fn(() => ({ kind: 'ip', value: 'test-ip' })),
  assertRateLimitAvailable: vi.fn(),
  enforceRateLimit: vi.fn(),
  writeRateLimitPolicies: {
    modelPricingSyncInvalidIp: { id: 'model-pricing-sync-invalid-ip', maxRequests: 30, windowSeconds: 900 },
    modelPricingSyncToken: { id: 'model-pricing-sync-token', maxRequests: 5, windowSeconds: 900 }
  }
}))

describe('model pricing sync route', () => {
  beforeEach(() => {
    mockedEnabled.mockReset()
    mockedParse.mockReset()
    mockedConfigured.mockReset()
    mockedRun.mockReset()
    mockedVerify.mockReset()
    mockedState.mockReset()
    mockedRateLimitAvailable.mockReset()
    mockedRateLimit.mockReset()
  })

  test('requires the configured secret and forces a sync', async () => {
    mockedConfigured.mockReturnValue(true)
    mockedVerify.mockResolvedValue(true)
    mockedParse.mockReturnValue('secret')
    mockedEnabled.mockReturnValue(true)
    mockedRun.mockResolvedValue({ status: 'success', modelCount: 3, sourceUpdatedAt: '2026-08-07', zeroFlips: [] })
    mockedState.mockResolvedValue({
      status: 'success',
      sourceUrl: 'https://models.dev/api.json',
      lastStartedAt: '2026-08-07T00:00:00.000Z',
      lastSuccessAt: '2026-08-07T00:00:00.000Z',
      lastFailureAt: null,
      lastSourceUpdatedAt: '2026-08-07',
      modelCount: 3,
      activeGeneration: 'generation',
      lastError: null,
      updatedAt: '2026-08-07T00:00:00.000Z'
    })
    const request = new Request('https://tokenboard.example/api/v1/model-pricing/sync', {
      method: 'POST',
      headers: { authorization: 'Bearer secret' }
    })
    const context = {
      env: { DB: {}, TOKENBOARD_MODEL_PRICING_SYNC_TOKEN: 'secret' },
      req: { raw: request, header: (name: string) => request.headers.get(name) },
      header: vi.fn(),
      json: vi.fn((body: unknown, status = 200) => Response.json(body, { status }))
    }

    const response = (await POST[0](context as never, async () => undefined)) as Response

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: 'success',
      scheduledSyncEnabled: true,
      syncState: { modelCount: 3 }
    })
    expect(mockedRun).toHaveBeenCalledWith({ env: context.env, force: true })
    expect(mockedRateLimitAvailable).toHaveBeenCalledOnce()
    expect(mockedRateLimitAvailable.mock.calls[0]?.[1]?.subject).toEqual({ kind: 'ip', value: 'test-ip' })
    expect(mockedRateLimit).toHaveBeenCalledOnce()
    expect(mockedRateLimit.mock.calls[0]?.[1]?.subject).toEqual({ kind: 'sync-token', value: 'secret' })
    expect(context.header).toHaveBeenCalledWith('Cache-Control', 'no-store')
  })

  test('rejects an invalid secret before reading source data', async () => {
    mockedConfigured.mockReturnValue(true)
    mockedVerify.mockResolvedValue(false)
    const request = new Request('https://tokenboard.example/api/v1/model-pricing/sync', {
      method: 'POST',
      headers: { authorization: 'Bearer wrong' }
    })
    const context = {
      env: { DB: {}, TOKENBOARD_MODEL_PRICING_SYNC_TOKEN: 'secret' },
      req: { raw: request, header: (name: string) => request.headers.get(name) },
      json: vi.fn((body: unknown, status = 200, headers?: Record<string, string>) =>
        Response.json(body, { status, headers })
      )
    }

    const response = (await POST[0](context as never, async () => undefined)) as Response

    expect(response.status).toBe(401)
    expect(mockedRateLimitAvailable).toHaveBeenCalledOnce()
    expect(mockedRateLimitAvailable.mock.calls[0]?.[1]?.subject).toEqual({ kind: 'ip', value: 'test-ip' })
    expect(mockedRateLimit).toHaveBeenCalledOnce()
    expect(mockedRateLimit.mock.calls[0]?.[1]?.subject).toEqual({ kind: 'ip', value: 'test-ip' })
    expect(mockedRun).not.toHaveBeenCalled()
  })

  test('does not disclose the secret environment variable when sync is unconfigured', async () => {
    mockedConfigured.mockReturnValue(false)
    const request = new Request('https://tokenboard.example/api/v1/model-pricing/sync', {
      method: 'POST'
    })
    const context = {
      env: { DB: {} },
      req: { raw: request, header: (name: string) => request.headers.get(name) },
      json: vi.fn((body: unknown, status = 200) => Response.json(body, { status }))
    }

    const response = (await POST[0](context as never, async () => undefined)) as Response
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body).toEqual({
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'Model pricing sync is not configured' }
    })
    expect(JSON.stringify(body)).not.toContain('TOKENBOARD_MODEL_PRICING_SYNC_TOKEN')
    expect(mockedVerify).not.toHaveBeenCalled()
    expect(mockedRateLimitAvailable).not.toHaveBeenCalled()
    expect(mockedRateLimit).not.toHaveBeenCalled()
    expect(mockedRun).not.toHaveBeenCalled()
  })

  test('returns 429 for invalid credentials when the invalid-IP limit rejects', async () => {
    mockedConfigured.mockReturnValue(true)
    mockedVerify.mockResolvedValue(false)
    mockedRateLimitAvailable.mockRejectedValueOnce(new ApiError('RATE_LIMITED', 'Too many requests', 429))
    const request = new Request('https://tokenboard.example/api/v1/model-pricing/sync', {
      method: 'POST',
      headers: { authorization: 'Bearer secret' }
    })
    const context = {
      env: { DB: {}, TOKENBOARD_MODEL_PRICING_SYNC_TOKEN: 'secret' },
      req: { raw: request, header: (name: string) => request.headers.get(name) },
      json: vi.fn((body: unknown, status = 200) => Response.json(body, { status }))
    }

    const response = (await POST[0](context as never, async () => undefined)) as Response

    expect(response.status).toBe(429)
    expect(await response.json()).toEqual({
      error: { code: 'RATE_LIMITED', message: 'Too many requests' }
    })
    expect(mockedRateLimitAvailable).toHaveBeenCalledOnce()
    expect(mockedVerify).not.toHaveBeenCalled()
    expect(mockedRateLimit).not.toHaveBeenCalled()
    expect(mockedRun).not.toHaveBeenCalled()
  })

  test('checks the invalid-IP shield before verifying the token', async () => {
    mockedConfigured.mockReturnValue(true)
    mockedVerify.mockResolvedValue(false)
    const request = new Request('https://tokenboard.example/api/v1/model-pricing/sync', {
      method: 'POST',
      headers: { authorization: 'Bearer wrong' }
    })
    const context = {
      env: { DB: {}, TOKENBOARD_MODEL_PRICING_SYNC_TOKEN: 'secret' },
      req: { raw: request, header: (name: string) => request.headers.get(name) },
      json: vi.fn((body: unknown, status = 200) => Response.json(body, { status }))
    }

    const response = (await POST[0](context as never, async () => undefined)) as Response

    expect(response.status).toBe(401)
    expect(mockedRateLimitAvailable).toHaveBeenCalledOnce()
    expect(mockedVerify).toHaveBeenCalledWith(context.env, 'Bearer wrong')
    expect(mockedRateLimit).toHaveBeenCalledOnce()
    expect(mockedRun).not.toHaveBeenCalled()
  })

  test('returns 429 after authenticating when the shared sync-token limit rejects', async () => {
    mockedConfigured.mockReturnValue(true)
    mockedVerify.mockResolvedValue(true)
    mockedParse.mockReturnValue('secret')
    mockedRateLimitAvailable.mockResolvedValue()
    mockedRateLimit.mockRejectedValueOnce(
      new ApiError('RATE_LIMITED', 'Too many requests', 429, { 'Retry-After': '600' })
    )
    const request = new Request('https://tokenboard.example/api/v1/model-pricing/sync', {
      method: 'POST',
      headers: { authorization: 'Bearer secret' }
    })
    const context = {
      env: { DB: {}, TOKENBOARD_MODEL_PRICING_SYNC_TOKEN: 'secret' },
      req: { raw: request, header: (name: string) => request.headers.get(name) },
      json: vi.fn((body: unknown, status = 200, headers?: Record<string, string>) =>
        Response.json(body, { status, headers })
      )
    }

    const response = (await POST[0](context as never, async () => undefined)) as Response

    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBe('600')
    expect(mockedRateLimit).toHaveBeenCalledOnce()
    expect(mockedRateLimit.mock.calls[0]?.[1]?.subject).toEqual({ kind: 'sync-token', value: 'secret' })
    expect(mockedRun).not.toHaveBeenCalled()
  })

  test('returns Retry-After with rate-limit errors', async () => {
    mockedConfigured.mockReturnValue(true)
    mockedVerify.mockResolvedValue(false)
    mockedRateLimitAvailable.mockResolvedValue()
    mockedRateLimit.mockRejectedValueOnce(
      new ApiError('RATE_LIMITED', 'Too many requests', 429, { 'Retry-After': '90' })
    )
    const request = new Request('https://tokenboard.example/api/v1/model-pricing/sync', { method: 'POST' })
    const context = {
      env: { DB: {}, TOKENBOARD_MODEL_PRICING_SYNC_TOKEN: 'secret' },
      req: { raw: request, header: (name: string) => request.headers.get(name) },
      json: vi.fn((body: unknown, status = 200, headers?: Record<string, string>) =>
        Response.json(body, { status, headers })
      )
    }

    const response = (await POST[0](context as never, async () => undefined)) as Response

    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBe('90')
    expect(mockedRateLimitAvailable).toHaveBeenCalledOnce()
  })

  test('uses the parsed sync token for the authenticated rate-limit key regardless of authorization whitespace', async () => {
    mockedConfigured.mockReturnValue(true)
    mockedVerify.mockResolvedValue(true)
    mockedParse.mockReturnValue('secret')
    mockedRateLimitAvailable.mockResolvedValue()
    mockedEnabled.mockReturnValue(true)
    mockedRun.mockResolvedValue({ status: 'success', modelCount: 0, sourceUpdatedAt: null, zeroFlips: [] })
    mockedState.mockResolvedValue(null)
    const request = new Request('https://tokenboard.example/api/v1/model-pricing/sync', {
      method: 'POST',
      headers: { authorization: 'Bearer   secret' }
    })
    const context = {
      env: { DB: {}, TOKENBOARD_MODEL_PRICING_SYNC_TOKEN: 'secret' },
      req: { raw: request, header: (name: string) => request.headers.get(name) },
      header: vi.fn(),
      json: vi.fn((body: unknown, status = 200) => Response.json(body, { status }))
    }

    await POST[0](context as never, async () => undefined)

    expect(mockedRateLimit.mock.calls[0]?.[1]?.subject).toEqual({ kind: 'sync-token', value: 'secret' })
  })
})
