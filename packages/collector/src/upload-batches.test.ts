import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { maxIsolationRounds, maxServerNamedRejects, snapshotBatchSize, uploadSnapshots } from './upload'
import { unchangedSnapshot } from './upload-test-helpers'

// The server rejects an array larger than 500 outright, and its array-level detail
// carries no row index — every client parser would find zero nameable rejects and the
// batch would fail forever. The width must stay under the cap.
describe('snapshotBatchSize', () => {
  test('stays under the server ingest cap', () => {
    const serverMaxIngestSnapshotBatchSize = 500
    expect(snapshotBatchSize).toBeLessThanOrEqual(serverMaxIngestSnapshotBatchSize)
  })

  // Pin the isolation capacity formula with literals: the budget must drain one full
  // batch of server-named rows (the width-30 property C3 must not lose). Reading the
  // constants back would only prove the source is self-consistent, not that the
  // derivation still holds if either constant drifts.
  test('isolation rounds cover a full batch of named rejects', () => {
    expect(maxServerNamedRejects).toBe(32)
    expect(maxIsolationRounds).toBe(Math.ceil(200 / 32))
    expect(maxIsolationRounds * maxServerNamedRejects).toBeGreaterThanOrEqual(snapshotBatchSize)
  })

  // maxServerNamedRejects mirrors the server's maxIngestErrorDetails (the same mirror
  // pattern as usage-sources.test.mjs): if the server lowers its per-response cap, the
  // client's round budget silently stops covering a full batch. The deploy order also
  // matters — the server-side per-row cap (ingest error-details, commit 1dee835) must
  // not lag behind clients that assume it.
  test('server-named-rejects constant matches the ingest cap', () => {
    const serverSource = readFileSync(
      new URL('../../../apps/web/app/features/ingest/error-details.ts', import.meta.url),
      'utf8'
    )
    const declared = /export const maxIngestErrorDetails = (\d+)/.exec(serverSource)
    expect(declared).not.toBeNull()
    expect(Number(declared![1])).toBe(maxServerNamedRejects)
  })

  // C2 outcomes mirror: the client treats exactly the statuses the server declares as
  // already-present (`same`, `protected`) and withholds the rest. If the server renames
  // or repurposes one of these, an unchanged row could be withheld forever (safe) or a
  // not-written row acknowledged (data loss) — so the set is pinned against the server
  // source, like the cap above. The Go client mirrors this test in
  // clients/go/internal/upload/outcomes_test.go.
  test('delivered outcome statuses mirror the server classifier', () => {
    const serverSource = readFileSync(
      new URL('../../../apps/web/app/features/ingest/repository/outcomes.ts', import.meta.url),
      'utf8'
    )
    const declared = /export type IngestRowStatus = (.+)/.exec(serverSource)
    expect(declared).not.toBeNull()
    const statuses = [...declared![1]!.matchAll(/'([a-z]+)'/g)].map((match) => match[1])
    expect(statuses.sort()).toEqual(['protected', 'same', 'stale', 'unknown'])
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
