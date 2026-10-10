import { describe, expect, test, vi } from 'vitest'
import { uploadSnapshots } from './upload'
import { unchangedSnapshot } from './upload-test-helpers'

const config = {
  endpoint: 'https://tokenboard.example.com/api/v1/ingest',
  uploadToken: 'test-upload-token',
  timezone: 'Asia/Shanghai'
}

describe('uploadSnapshots resilience', () => {
  test('calls injected fetchers with the global context', async () => {
    const calls: string[] = []
    const thisSensitiveFetch = vi.fn(function (this: unknown, url: string) {
      if (this !== globalThis) {
        throw new TypeError('Illegal invocation: function called with incorrect `this` reference.')
      }
      calls.push(url)
      return Promise.resolve(successResponse(url))
    })

    const result = await uploadSnapshots(config, [unchangedSnapshot], thisSensitiveFetch)

    expect(result).toEqual({ upserted: 1, skipped: 0 })
    expect(calls).toEqual([`${config.endpoint}/check`, config.endpoint])
  })

  test('does not fall back when hash check fails with a non-retryable error', async () => {
    const fetcher = async () =>
      ({
        ok: false,
        status: 400,
        async json() {
          return {}
        }
      }) as Response

    await expect(uploadSnapshots(config, [unchangedSnapshot], fetcher)).rejects.toThrow(
      'Snapshot check failed with status 400'
    )
  })

  test('retries transient fetch failures during hash check and upload', async () => {
    vi.stubEnv('TOKENBOARD_FETCH_RETRY_DELAY_MS', '0')
    const requests: string[] = []
    const failures = new Set([`${config.endpoint}/check`, config.endpoint])
    const fetcher = async (url: string) => {
      requests.push(url)
      if (failures.delete(url)) throw new TypeError('fetch failed')
      return successResponse(url)
    }

    try {
      const result = await uploadSnapshots(config, [unchangedSnapshot], fetcher)

      expect(result).toEqual({ upserted: 1, skipped: 0 })
      expect(requests).toEqual([
        `${config.endpoint}/check`,
        `${config.endpoint}/check`,
        config.endpoint,
        config.endpoint
      ])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  test('retries retryable server responses during hash check and upload', async () => {
    vi.stubEnv('TOKENBOARD_FETCH_RETRY_DELAY_MS', '0')
    const requests: string[] = []
    const attempts = new Map<string, number>()
    const fetcher = async (url: string) => {
      requests.push(url)
      const count = attempts.get(url) ?? 0
      attempts.set(url, count + 1)
      if (count === 0) {
        return retryableResponse(url.endsWith('/check') ? 503 : 429)
      }
      return successResponse(url)
    }

    try {
      const result = await uploadSnapshots(config, [unchangedSnapshot], fetcher)

      expect(result).toEqual({ upserted: 1, skipped: 0 })
      expect(requests).toEqual([
        `${config.endpoint}/check`,
        `${config.endpoint}/check`,
        config.endpoint,
        config.endpoint
      ])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  test('retries and fails visibly when a snapshot check request exceeds its deadline', async () => {
    vi.stubEnv('TOKENBOARD_FETCH_RETRY_DELAY_MS', '0')
    vi.stubEnv('TOKENBOARD_FETCH_TIMEOUT_MS', '1')
    const signals: AbortSignal[] = []
    const fetcher = vi.fn((_url: string, init: RequestInit) => {
      const signal = init.signal
      if (!signal) throw new Error('Expected a request deadline signal')
      signals.push(signal)
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })

    try {
      await expect(uploadSnapshots(config, [unchangedSnapshot], fetcher)).rejects.toThrow(
        'TokenBoard request timed out after 1ms'
      )
      expect(fetcher).toHaveBeenCalledTimes(3)
      expect(signals.every((signal) => signal.aborted)).toBe(true)
    } finally {
      vi.unstubAllEnvs()
    }
  }, 500)

  test('retries and fails visibly when upload response parsing exceeds its deadline', async () => {
    vi.stubEnv('TOKENBOARD_FETCH_RETRY_DELAY_MS', '0')
    vi.stubEnv('TOKENBOARD_FETCH_TIMEOUT_MS', '1')
    const requests: string[] = []
    const fetcher = async (url: string) => {
      requests.push(url)
      if (url.endsWith('/check')) return successResponse(url)
      const response = new Response()
      response.json = () => new Promise<never>(() => undefined)
      return response
    }

    try {
      await expect(uploadSnapshots(config, [unchangedSnapshot], fetcher)).rejects.toThrow(
        'TokenBoard request timed out after 1ms'
      )
      expect(requests).toEqual([`${config.endpoint}/check`, config.endpoint, config.endpoint, config.endpoint])
    } finally {
      vi.unstubAllEnvs()
    }
  }, 500)

  test('uses the default deadline when the configured timeout is not a complete positive integer', async () => {
    vi.stubEnv('TOKENBOARD_FETCH_TIMEOUT_MS', '30s')
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout')

    try {
      await uploadSnapshots(config, [], async (url: string) => successResponse(url))

      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 30_000)
    } finally {
      timeoutSpy.mockRestore()
      vi.unstubAllEnvs()
    }
  })

  test('does not retry non-retryable upload responses', async () => {
    const requests: string[] = []
    const fetcher = async (url: string) => {
      requests.push(url)
      return url.endsWith('/check') ? successResponse(url) : unauthorizedResponse()
    }

    await expect(uploadSnapshots(config, [unchangedSnapshot], fetcher)).rejects.toThrow('Upload failed with status 401')
    expect(requests).toEqual([`${config.endpoint}/check`, config.endpoint])
  })

  test('fails visibly when the hash check response shape is invalid', async () => {
    const fetcher = async () => jsonResponse({ existing: [{ source: 'codex' }] })

    await expect(uploadSnapshots(config, [unchangedSnapshot], fetcher)).rejects.toThrow(
      'Snapshot check returned invalid response'
    )
  })

  test('fails visibly when the hash check response contains an invalid hash', async () => {
    const fetcher = async () =>
      jsonResponse({
        existing: [
          {
            source: unchangedSnapshot.source,
            usageDate: unchangedSnapshot.usageDate,
            model: unchangedSnapshot.model,
            snapshotHash: 'not-a-sha256-hash'
          }
        ]
      })

    await expect(uploadSnapshots(config, [unchangedSnapshot], fetcher)).rejects.toThrow(
      'Snapshot check returned invalid response'
    )
  })

  test('fails visibly when the upload response shape is invalid', async () => {
    const fetcher = async (url: string) =>
      url.endsWith('/check') ? jsonResponse({ existing: [] }) : jsonResponse({ ok: true })

    await expect(uploadSnapshots(config, [unchangedSnapshot], fetcher)).rejects.toThrow(
      'Upload returned invalid response'
    )
  })

  test('fails visibly when the upload response count is invalid', async () => {
    const fetcher = async (url: string) =>
      url.endsWith('/check') ? jsonResponse({ existing: [] }) : jsonResponse({ upserted: -1 })

    await expect(uploadSnapshots(config, [unchangedSnapshot], fetcher)).rejects.toThrow(
      'Upload returned invalid response'
    )
  })

  // The retry loop reads Retry-After in both of its formats and clamps to five seconds; the
  // header is written by the TokenBoard server itself, so a malformed or hostile value must
  // not turn into an unbounded sleep. These pin the clamp, the HTTP-date branch, and the
  // exponential default backoff curve. Retry waits are fired synchronously so the tests
  // observe the scheduled delay without sleeping it.
  test('honours Retry-After seconds and clamps it to five seconds', async () => {
    vi.stubEnv('TOKENBOARD_FETCH_RETRY_DELAY_MS', '')
    const timeoutSpy = spyOnShortTimers()
    const attempts = new Map<string, number>()
    const fetcher = async (url: string) => {
      const count = attempts.get(url) ?? 0
      attempts.set(url, count + 1)
      if (count === 0) return retryAfterResponse(url.endsWith('/check') ? 429 : 503, '30')
      return successResponse(url)
    }

    try {
      await uploadSnapshots(config, [unchangedSnapshot], fetcher)

      expect(retryDelays(timeoutSpy)).toEqual([5_000, 5_000])
    } finally {
      timeoutSpy.mockRestore()
      vi.unstubAllEnvs()
    }
  })

  test('honours an HTTP-date Retry-After in the past without waiting', async () => {
    vi.stubEnv('TOKENBOARD_FETCH_RETRY_DELAY_MS', '')
    const timeoutSpy = spyOnShortTimers()
    const attempts = new Map<string, number>()
    const fetcher = async (url: string) => {
      const count = attempts.get(url) ?? 0
      attempts.set(url, count + 1)
      if (count === 0) {
        return retryAfterResponse(url.endsWith('/check') ? 429 : 503, new Date(Date.now() - 60_000).toUTCString())
      }
      return successResponse(url)
    }

    try {
      await uploadSnapshots(config, [unchangedSnapshot], fetcher)

      expect(retryDelays(timeoutSpy)).toEqual([])
    } finally {
      timeoutSpy.mockRestore()
      vi.unstubAllEnvs()
    }
  })

  test('backs off exponentially by default when Retry-After is absent', async () => {
    vi.stubEnv('TOKENBOARD_FETCH_RETRY_DELAY_MS', '')
    const timeoutSpy = spyOnShortTimers()
    const attempts = new Map<string, number>()
    const fetcher = async (url: string) => {
      const count = attempts.get(url) ?? 0
      attempts.set(url, count + 1)
      if (url.endsWith('/check') && count < 2) return retryableResponseWithoutRetryAfter(503)
      return successResponse(url)
    }

    try {
      await uploadSnapshots(config, [unchangedSnapshot], fetcher)

      expect(retryDelays(timeoutSpy)).toEqual([250, 500])
    } finally {
      timeoutSpy.mockRestore()
      vi.unstubAllEnvs()
    }
  })

  test.each([408, 429, 500, 502, 503, 504])('retries retryable status %s once before succeeding', async (status) => {
    vi.stubEnv('TOKENBOARD_FETCH_RETRY_DELAY_MS', '0')
    const requests: string[] = []
    const fetcher = async (url: string) => {
      requests.push(url)
      if (requests.length === 1) return retryAfterResponse(status, '0')
      return successResponse(url)
    }

    try {
      const result = await uploadSnapshots(config, [unchangedSnapshot], fetcher)

      expect(result).toEqual({ upserted: 1, skipped: 0 })
      expect(requests).toEqual([`${config.endpoint}/check`, `${config.endpoint}/check`, config.endpoint])
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

function successResponse(url: string) {
  return jsonResponse(url.endsWith('/check') ? { existing: [] } : { upserted: 1 })
}

function retryableResponse(status: number) {
  return {
    ok: false,
    status,
    headers: new Headers({ 'retry-after': '0' }),
    async json() {
      return {}
    }
  } as Response
}

function retryableResponseWithoutRetryAfter(status: number) {
  return {
    ok: false,
    status,
    headers: new Headers(),
    async json() {
      return {}
    }
  } as Response
}

function retryAfterResponse(status: number, retryAfter: string) {
  return {
    ok: false,
    status,
    headers: new Headers({ 'retry-after': retryAfter }),
    async json() {
      return {}
    }
  } as Response
}

// The request-deadline timer also goes through setTimeout (30s); only the short backoff
// waits are retry scheduling.
function retryDelays(timeoutSpy: { mock: { calls: unknown[][] } }) {
  return timeoutSpy.mock.calls
    .map((call) => call[1])
    .filter((delay): delay is number => typeof delay === 'number' && delay > 0 && delay <= 5_000)
}

// Records every scheduled delay but fires short waits synchronously, so a retry test observes
// what the backoff would sleep without spending the time. The request-deadline timer (30s)
// is left un-fired so in-flight fetches are not aborted.
function spyOnShortTimers() {
  return vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    handler: (...args: unknown[]) => void,
    delay?: number
  ) => {
    if (typeof delay === 'number' && delay > 0 && delay <= 5_000 && typeof handler === 'function') {
      handler()
    }
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as typeof globalThis.setTimeout)
}

function unauthorizedResponse() {
  return {
    ok: false,
    status: 401,
    async json() {
      return { error: 'unauthorized' }
    }
  } as Response
}

function jsonResponse(value: unknown) {
  return {
    ok: true,
    async json() {
      return value
    }
  } as Response
}
