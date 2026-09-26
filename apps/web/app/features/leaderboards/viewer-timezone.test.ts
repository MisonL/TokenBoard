import { describe, expect, test, vi } from 'vitest'
import { resolveViewerTimezone } from './viewer-timezone'

describe('resolveViewerTimezone', () => {
  // The full page and the fragment it swaps in are two routes answering the same question. They
  // resolved it differently — the page read the signed-in user's profile zone, the fragment
  // always read the browser cookie — so a user who had set their zone by hand got one day's
  // board on load and a different day's the moment they clicked a tab. Same instant, same user,
  // two boards.
  test('resolves the signed-in user profile zone, not the cookie', async () => {
    const db = profileDb('Asia/Shanghai')

    const timezone = await resolveViewerTimezone({
      db,
      userId: 'user_1',
      cookieHeader: 'tokenboard-timezone=America%2FLos_Angeles'
    })

    expect(timezone).toBe('Asia/Shanghai')
  })

  test('falls back to the cookie zone for an anonymous viewer', async () => {
    const timezone = await resolveViewerTimezone({
      db: profileDb(null),
      userId: null,
      cookieHeader: 'tokenboard-timezone=America%2FLos_Angeles'
    })

    expect(timezone).toBe('America/Los_Angeles')
  })

  test('falls back to UTC when there is neither a profile nor a cookie', async () => {
    const timezone = await resolveViewerTimezone({ db: profileDb(null), userId: null, cookieHeader: null })

    expect(timezone).toBe('UTC')
  })

  // A signed-in user with no profile row yet is a real state: `getOptionalUser` does not create
  // one, and only `requireUser` does. `getProfileTimezoneSettings` throws NOT_FOUND for that
  // row, which surfaced as a 404 on a public page for a logged-in visitor.
  test('does not throw for a signed-in user with no profile row', async () => {
    const timezone = await resolveViewerTimezone({
      db: missingProfileDb(),
      userId: 'user_1',
      cookieHeader: 'tokenboard-timezone=Asia%2FTokyo'
    })

    expect(timezone).toBe('Asia/Tokyo')
  })
})

function profileDb(timezone: string | null) {
  return {
    prepare: () => ({
      bind: () => ({
        first: async () => (timezone === null ? null : { userId: 'user_1', timezone, timezoneSource: 'user' })
      })
    })
  } as unknown as D1Database
}

function missingProfileDb() {
  return {
    prepare: () => ({
      bind: () => ({
        first: async () => null
      })
    })
  } as unknown as D1Database
}

describe('resolveViewerTimezone error handling', () => {
  // Only the "no profile yet" case is a legitimate absence. A database failure is not an
  // absence, and swallowing it would rank the board in a zone nobody chose while the real
  // problem stayed invisible.
  test('propagates a database failure instead of falling back to the cookie', async () => {
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => {
            throw new Error('D1_ERROR: network unavailable')
          }
        })
      })
    } as unknown as D1Database

    await expect(
      resolveViewerTimezone({ db, userId: 'user_1', cookieHeader: 'tokenboard-timezone=Asia%2FTokyo' })
    ).rejects.toThrow('network unavailable')
  })
})
