import { describe, expect, test } from 'vitest'
import { snapshotBatchSize, uploadSnapshots } from './upload'
import { unchangedSnapshot } from './upload-test-helpers'

// The server rejects an array larger than 500 outright, and its array-level detail
// carries no row index — every client parser would find zero nameable rejects and the
// batch would fail forever. The width must stay under the cap.
describe('snapshotBatchSize', () => {
  test('stays under the server ingest cap', () => {
    const serverMaxIngestSnapshotBatchSize = 500
    expect(snapshotBatchSize).toBeLessThanOrEqual(serverMaxIngestSnapshotBatchSize)
  })
})

describe('uploadSnapshots batches', () => {
  test('splits large uploads into C3-sized batches of 200', async () => {
    const snapshots = largeSnapshotSet()
    const requests: Array<{ url: string; body: unknown }> = []
    const result = await uploadSnapshots(
      {
        endpoint: 'https://tokenboard.example.com/api/v1/ingest',
        uploadToken: 'test-upload-token',
        timezone: 'Asia/Shanghai'
      },
      snapshots,
      createBatchFetch(requests)
    )

    expect(result).toEqual({ upserted: 501, skipped: 0 })
    // 501 snapshots → 200 + 200 + 101, each batch preceded by its /check: 6 requests.
    // (The keep-alive empty ingest only fires when nothing needed uploading, which the
    // always-stale stub below prevents.)
    expect(requests).toHaveLength(6)
    for (let index = 0; index < requests.length; index += 2) {
      const offset = (index / 2) * 200
      const batch = snapshots.slice(offset, offset + 200)
      expect(requests[index]).toEqual(checkRequest(batch))
      expect(requests[index + 1]).toEqual(uploadRequest(batch))
    }
  })
})

function largeSnapshotSet() {
  return Array.from({ length: 501 }, (_, index) => ({
    ...unchangedSnapshot,
    model: `gpt-5-${index}`,
    totalTokens: unchangedSnapshot.totalTokens + index
  }))
}

function createBatchFetch(requests: Array<{ url: string; body: unknown }>) {
  return async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : null
    requests.push({ url, body })
    return {
      ok: true,
      async json() {
        return {
          existing: [],
          upserted: body?.snapshots?.length ?? 0
        }
      }
    } as Response
  }
}

function checkRequest(snapshots: (typeof unchangedSnapshot)[]) {
  return {
    url: 'https://tokenboard.example.com/api/v1/ingest/check',
    body: {
      keys: snapshots.map((snapshot) => ({
        source: snapshot.source,
        usageDate: snapshot.usageDate,
        model: snapshot.model
      }))
    }
  }
}

function uploadRequest(snapshots: (typeof unchangedSnapshot)[]) {
  return {
    url: 'https://tokenboard.example.com/api/v1/ingest',
    body: { snapshots }
  }
}

// The upload carries the bearer token, and a redirect would replay the request — header
// and all — at a Location the server chose. `redirect: 'manual'` is what stops fetch from
// following it; without it the header crosses to whatever host the 3xx names.
describe('uploadSnapshots redirect handling', () => {
  test('asks fetch not to follow redirects', async () => {
    const seen: Array<RequestInit['redirect']> = []
    const fetch = async (_url: string, init: RequestInit) => {
      seen.push(init.redirect)
      return {
        ok: true,
        async json() {
          return { existing: [], upserted: 0 }
        }
      } as Response
    }

    await uploadSnapshots(
      { endpoint: 'https://tokenboard.example.com/api/v1/ingest', uploadToken: 't', timezone: 'UTC' },
      [],
      fetch
    )

    expect(seen).toEqual(['manual'])
  })

  test('reports a redirect instead of accepting its body', async () => {
    const fetch = async () =>
      ({ ok: false, status: 307, headers: new Headers({ location: 'https://evil.example/' }) }) as Response

    await expect(
      uploadSnapshots(
        { endpoint: 'https://tokenboard.example.com/api/v1/ingest', uploadToken: 't', timezone: 'UTC' },
        [],
        fetch
      )
    ).rejects.toThrow(/status 307/)
  })
})
