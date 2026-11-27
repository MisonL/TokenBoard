import { describe, expect, test } from 'vitest'
import { readUploadBlocked, readUploadDelivered, readUploadWithheld, uploadSnapshots } from './upload'
import { unchangedSnapshot } from './upload-test-helpers'

const config = {
  endpoint: 'https://tokenboard.example.com/api/v1/ingest',
  uploadToken: 'test-upload-token',
  timezone: 'Asia/Shanghai'
}

function snapshot(model: string, totalTokens = 100) {
  return { ...unchangedSnapshot, model, totalTokens }
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body)
    },
    async json() {
      return body
    }
  } as unknown as Response
}

// The check endpoint answers 404 (unsupported), so every row is posted; the
// ingest endpoint names any row whose model is "bad" in a 400.
function isolationFetcher(state: { ingestCalls: number; badCode?: string }) {
  return async (url: string, init?: RequestInit) => {
    if (url.endsWith('/check')) return jsonResponse({}, 404)
    state.ingestCalls += 1
    const body = JSON.parse(String(init?.body ?? '{}')) as { snapshots: Array<{ model: string }> }
    for (const [index, posted] of body.snapshots.entries()) {
      if (posted.model === 'bad') {
        return jsonResponse(
          {
            error: {
              code: 'BAD_REQUEST',
              message: 'Invalid request',
              details: [
                { index, path: `snapshots.${index}.usageDate`, code: state.badCode ?? 'usage-date-too-far-future' }
              ]
            }
          },
          400
        )
      }
    }
    return jsonResponse({ upserted: body.snapshots.length })
  }
}

describe('upload row outcomes', () => {
  // A server that answers with `outcomes` (C2): same/protected rows count as delivered,
  // stale/unknown rows stay pending like blocked ones.
  function outcomeFetcher(outcomes: Array<{ index: number; status: string }>, state: { ingestCalls: number }) {
    return async (url: string, init?: RequestInit) => {
      if (url.endsWith('/check')) return jsonResponse({}, 404)
      state.ingestCalls += 1
      const body = JSON.parse(String(init?.body ?? '{}')) as { snapshots: unknown[] }
      return jsonResponse({ upserted: body.snapshots.length - outcomes.length, outcomes })
    }
  }

  test('same and protected outcomes stay delivered', async () => {
    const state = { ingestCalls: 0 }
    const rows = [snapshot('a'), snapshot('b'), snapshot('c')]
    const fetcher = await outcomeFetcher(
      [
        { index: 0, status: 'same' },
        { index: 1, status: 'protected' }
      ],
      state
    )

    const result = await uploadSnapshots(config, rows, fetcher)

    expect(readUploadWithheld(result)).toEqual([])
    expect(readUploadDelivered(result)?.map((row) => row.model)).toEqual(['a', 'b', 'c'])
  })

  test('stale and unknown outcomes withhold their rows and stay pending', async () => {
    const state = { ingestCalls: 0 }
    const rows = [snapshot('a'), snapshot('b'), snapshot('c')]
    const fetcher = await outcomeFetcher(
      [
        { index: 0, status: 'stale' },
        { index: 2, status: 'unknown' }
      ],
      state
    )

    const result = await uploadSnapshots(config, rows, fetcher)

    expect(readUploadWithheld(result)).toEqual([
      { snapshot: rows[0], status: 'stale' },
      { snapshot: rows[2], status: 'unknown' }
    ])
    expect(readUploadDelivered(result)?.map((row) => row.model)).toEqual(['b'])
  })

  // A future server status must fail closed: acknowledging a row the server did not
  // write would discard the measurement for good.
  test('an unrecognized outcome status withholds the row', async () => {
    const state = { ingestCalls: 0 }
    const rows = [snapshot('a'), snapshot('b')]
    const fetcher = await outcomeFetcher([{ index: 1, status: 'quarantined' }], state)

    const result = await uploadSnapshots(config, rows, fetcher)

    expect(readUploadWithheld(result)).toEqual([{ snapshot: rows[1], status: 'quarantined' }])
    expect(readUploadDelivered(result)?.map((row) => row.model)).toEqual(['a'])
  })

  // Isolation rounds re-send a narrowed array; outcome indexes address the array of
  // *that round*, so the withheld rows must be found in `send`, not the original batch.
  test('outcome indexes address the narrowed resend', async () => {
    const state = { ingestCalls: 0 }
    const fetcher = async (url: string, init?: RequestInit) => {
      if (url.endsWith('/check')) return jsonResponse({}, 404)
      state.ingestCalls += 1
      const body = JSON.parse(String(init?.body ?? '{}')) as { snapshots: Array<{ model: string }> }
      if (state.ingestCalls === 1) {
        return jsonResponse(
          {
            error: {
              code: 'BAD_REQUEST',
              message: 'Invalid request',
              details: [{ index: 0, path: 'snapshots.0.model', code: 'invalid-value' }]
            }
          },
          400
        )
      }
      // Second round posted [b, c]; the server left b unwritten.
      return jsonResponse({ upserted: 1, outcomes: [{ index: 0, status: 'stale' }] })
    }
    const rows = [snapshot('bad'), snapshot('b'), snapshot('c')]

    const result = await uploadSnapshots(config, rows, fetcher)

    expect(readUploadBlocked(result)?.map((entry) => entry.snapshot.model)).toEqual(['bad'])
    expect(readUploadWithheld(result)).toEqual([{ snapshot: rows[1], status: 'stale' }])
    expect(readUploadDelivered(result)?.map((row) => row.model)).toEqual(['c'])
  })

  // The classifier's index must exist in the posted array; a server that names a row
  // outside it broke the contract, and guessing would acknowledge or withhold the wrong row.
  test('an outcome index outside the batch breaks the contract', async () => {
    const state = { ingestCalls: 0 }
    const fetcher = await outcomeFetcher([{ index: 5, status: 'stale' }], state)

    await expect(uploadSnapshots(config, [snapshot('a')], fetcher)).rejects.toThrow('Upload returned invalid response')
  })

  test('a malformed outcome breaks the contract', async () => {
    const state = { ingestCalls: 0 }
    for (const outcome of [
      { index: 'x', status: 'stale' },
      { index: 0, status: '' },
      { index: 0, status: 7 },
      'stale'
    ]) {
      const fetcher = await outcomeFetcher([outcome as never], state)
      await expect(uploadSnapshots(config, [snapshot('a')], fetcher)).rejects.toThrow(
        'Upload returned invalid response'
      )
    }
  })

  // Old servers answer with only `upserted`; everything posted is delivered, as before.
  test('a response without outcomes behaves as before C2', async () => {
    const state = { ingestCalls: 0 }
    const rows = [snapshot('a'), snapshot('b')]
    const fetcher = async (url: string, init?: RequestInit) => {
      if (url.endsWith('/check')) return jsonResponse({}, 404)
      state.ingestCalls += 1
      const body = JSON.parse(String(init?.body ?? '{}')) as { snapshots: unknown[] }
      return jsonResponse({ upserted: body.snapshots.length })
    }

    const result = await uploadSnapshots(config, rows, fetcher)

    expect(readUploadWithheld(result)).toEqual([])
    expect(readUploadDelivered(result)?.map((row) => row.model)).toEqual(['a', 'b'])
  })
})

describe('upload isolation', () => {
  test('isolates the rows a 400 names and delivers the rest', async () => {
    const state = { ingestCalls: 0 }
    const good = snapshot('good')
    const bad = snapshot('bad')
    const also = snapshot('also-good')

    const result = await uploadSnapshots(config, [good, bad, also], isolationFetcher(state))

    expect(state.ingestCalls).toBe(2)
    expect(readUploadBlocked(result)).toEqual([{ snapshot: bad, code: 'usage-date-too-far-future' }])
    // A blocked row never reached the server: acknowledging it would retire it.
    expect(readUploadDelivered(result)?.map((row) => row.model)).toEqual(['good', 'also-good'])
  })

  test('drains a batch whose every row is named, without throwing', async () => {
    // A server that names rows is behaving correctly; isolating must not stop at a
    // round budget below the batch width, because the throw would abort the run's
    // remaining batches — other sources' rows — and feed the 24h pause.
    let ingestCalls = 0
    const fetcher = async (url: string, init?: RequestInit) => {
      if (url.endsWith('/check')) return jsonResponse({}, 404)
      ingestCalls += 1
      const body = JSON.parse(String(init?.body ?? '{}')) as { snapshots: unknown[] }
      if (body.snapshots.length === 0) return jsonResponse({ upserted: 0 })
      return jsonResponse(
        {
          error: {
            code: 'BAD_REQUEST',
            message: 'Invalid request',
            details: [{ index: 0, path: 'snapshots.0.model', code: 'invalid-value' }]
          }
        },
        400
      )
    }

    const rows = [snapshot('a'), snapshot('b'), snapshot('c')]
    const result = await uploadSnapshots(config, rows, fetcher)

    expect(ingestCalls).toBe(3)
    expect((result as { upserted: number }).upserted).toBe(0)
    expect(readUploadDelivered(result)).toEqual([])
    expect(readUploadBlocked(result)).toHaveLength(3)
  })

  test('stops isolating at the width-derived round budget instead of looping', async () => {
    // Beyond ceil(batchWidth/32) rounds a server that still names rows is
    // misbehaving, and the batch fails like it always did.
    let ingestCalls = 0
    const fetcher = async (url: string, init?: RequestInit) => {
      if (url.endsWith('/check')) return jsonResponse({}, 404)
      ingestCalls += 1
      const body = JSON.parse(String(init?.body ?? '{}')) as { snapshots: unknown[] }
      if (body.snapshots.length === 0) return jsonResponse({ upserted: 0 })
      return jsonResponse(
        {
          error: {
            code: 'BAD_REQUEST',
            message: 'Invalid request',
            details: [{ index: 0, path: 'snapshots.0.model', code: 'invalid-value' }]
          }
        },
        400
      )
    }

    const rows = Array.from({ length: 10 }, (_, index) => snapshot(`m-${index}`))
    await expect(uploadSnapshots(config, rows, fetcher)).rejects.toThrow('Upload failed with status 400')
    expect(ingestCalls).toBe(Math.ceil(200 / 32) + 1)
  })

  test('fails the whole batch on a 400 without details', async () => {
    let ingestCalls = 0
    const fetcher = async (url: string) => {
      if (url.endsWith('/check')) return jsonResponse({}, 404)
      ingestCalls += 1
      return jsonResponse({ error: { code: 'BAD_REQUEST', message: 'Invalid request' } }, 400)
    }

    await expect(uploadSnapshots(config, [snapshot('a')], fetcher)).rejects.toThrow('Upload failed with status 400')
    expect(ingestCalls).toBe(1)
  })

  test('drops a rejected check key and retries with the rest', async () => {
    const keysSeen: number[] = []
    let checkCalls = 0
    let upserted = 0
    const fetcher = async (url: string, init?: RequestInit) => {
      if (url.endsWith('/check')) {
        checkCalls += 1
        const body = JSON.parse(String(init?.body ?? '{}')) as { keys: unknown[] }
        keysSeen.push(body.keys.length)
        if (checkCalls === 1) {
          return jsonResponse(
            { error: { details: [{ index: 0, path: 'keys.0.usageDate', code: 'invalid-date' }] } },
            400
          )
        }
        return jsonResponse({ existing: [] })
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as { snapshots: unknown[] }
      upserted += body.snapshots.length
      return jsonResponse({ upserted: body.snapshots.length })
    }

    const result = await uploadSnapshots(config, [snapshot('a'), snapshot('b')], fetcher)

    expect(checkCalls).toBe(2)
    expect(keysSeen).toEqual([2, 1])
    expect(upserted).toBe(2)
    expect((result as { upserted: number }).upserted).toBe(2)
  })
})
