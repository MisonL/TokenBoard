import { describe, expect, test } from 'vitest'
import { getLeaderboard } from './service'

describe('getLeaderboard', () => {
  test('uses the current month range for monthly leaderboards', async () => {
    const bindings: unknown[][] = []
    const sqlStatements: string[] = []
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async all() {
                return { results: [] }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await getLeaderboard(db, { period: 'monthly', metric: 'cost' }, new Date('2026-04-29T10:00:00.000Z'))

    expect(bindings[0]).toEqual(['2026-04-01', '2026-05-01', '2026-04-01', '2026-05-01', 50])
    expect(sqlStatements[0]).toContain('ORDER BY costUsd DESC, totalTokens DESC')
  })

  // The board spans users, so there is no single owner timezone to attribute by; the boundary
  // follows the viewer's zone. `daily_usage.usage_date` is stamped by each collector in its own
  // local zone, so a UTC boundary put the evening in the Americas on the following day's board
  // and left a UTC+ offset's first hours of the month out of "this month" entirely.
  test('attributes the day and month to the viewer timezone, not UTC', async () => {
    const bindings: unknown[][] = []
    const db = {
      prepare() {
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async all() {
                return { results: [] }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    // 18:00 UTC on the last day of April: already May 1st in Shanghai, still April 30th in LA.
    const now = new Date('2026-04-30T18:00:00.000Z')

    await getLeaderboard(db, { period: 'daily', metric: 'tokens' }, now, {}, 'Asia/Shanghai')
    expect(bindings[0].slice(0, 2)).toEqual(['2026-05-01', '2026-05-02'])

    await getLeaderboard(db, { period: 'monthly', metric: 'tokens' }, now, {}, 'Asia/Shanghai')
    expect(bindings[1].slice(0, 2)).toEqual(['2026-05-01', '2026-06-01'])

    await getLeaderboard(db, { period: 'monthly', metric: 'tokens' }, now, {}, 'America/Los_Angeles')
    expect(bindings[2].slice(0, 2)).toEqual(['2026-04-01', '2026-05-01'])
  })

  test('accepts the no-cache-read token leaderboard metric', async () => {
    const sqlStatements: string[] = []
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind() {
            return {
              async all() {
                return { results: [] }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await getLeaderboard(
      db,
      { period: 'daily', metric: 'tokens-without-cache-read' },
      new Date('2026-04-29T10:00:00.000Z')
    )

    expect(sqlStatements[0]).toContain('ORDER BY totalTokensWithoutCacheRead DESC, totalTokens DESC, costUsd DESC')
  })
})

// The board is the one surface that spans users, so it is also the one surface where a viewer
// cannot tell what they are looking at. `usage_date` is stamped by each collector in its own
// local zone, so two users' rows labelled `2026-05-01` cover absolute windows 16 hours apart.
// The ranking still has to pick a boundary, and it picks the viewer's; what was missing is
// saying so. These tests pin the label to the same value the window is computed from, so the
// caption cannot drift away from the query the way a separately-computed one would.
describe('getLeaderboard range label', () => {
  test('labels a daily board with its date and the viewer offset', async () => {
    const view = await getLeaderboard(
      emptyDb(),
      { period: 'daily', metric: 'tokens' },
      new Date('2026-04-30T18:00:00.000Z'),
      {},
      'Asia/Shanghai'
    )

    expect(view.rangeLabel).toBe('2026-05-01')
    expect(view.timezone).toBe('Asia/Shanghai')
    expect(view.timezoneLabel).toBe('UTC+8')
  })

  test('labels a monthly board with its month', async () => {
    const view = await getLeaderboard(
      emptyDb(),
      { period: 'monthly', metric: 'tokens' },
      new Date('2026-04-30T18:00:00.000Z'),
      {},
      'America/Los_Angeles'
    )

    expect(view.rangeLabel).toBe('2026-04')
    expect(view.timezoneLabel).toBe('UTC-7')
  })

  // The same instant is a different day either side of the date line, and the label has to
  // follow the window rather than the instant: a caption that said the 30th while the query
  // asked for the 1st is the failure this whole surface had.
  test('labels the day the window actually covers, not the UTC one', async () => {
    const now = new Date('2026-04-30T18:00:00.000Z')
    const shanghai = await getLeaderboard(emptyDb(), { period: 'daily' }, now, {}, 'Asia/Shanghai')
    const losAngeles = await getLeaderboard(emptyDb(), { period: 'daily' }, now, {}, 'America/Los_Angeles')

    expect(shanghai.rangeLabel).toBe('2026-05-01')
    expect(losAngeles.rangeLabel).toBe('2026-04-30')
  })
})

function emptyDb() {
  return {
    prepare() {
      return {
        bind() {
          return {
            async all() {
              return { results: [] }
            }
          }
        }
      }
    }
  } as unknown as D1Database
}
