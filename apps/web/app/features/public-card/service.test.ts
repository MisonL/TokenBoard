import { describe, expect, test } from 'vitest'
import {
  getPublicRouteSlug,
  getPublicUsageCard,
  getPublicUsageJson,
  normalizePublicSlug
} from './service'

describe('public card service', () => {
  test('normalizes slugs captured from extension routes', () => {
    expect(normalizePublicSlug('eve-tokenboard.json', 'json')).toBe('eve-tokenboard')
    expect(normalizePublicSlug('eve-tokenboard.svg', 'svg')).toBe('eve-tokenboard')
    expect(normalizePublicSlug('eve-tokenboard', 'json')).toBe('eve-tokenboard')
  })

  test('reads slugs from Hono extension route params', () => {
    expect(getPublicRouteSlug({ slug: 'eve-tokenboard.json' }, 'json')).toBe('eve-tokenboard')
    expect(getPublicRouteSlug({ 'slug.json': 'eve-tokenboard' }, 'json')).toBe('eve-tokenboard')
    expect(getPublicRouteSlug({ 'slug.svg': 'eve-tokenboard' }, 'svg')).toBe('eve-tokenboard')
  })

  test('returns public usage without leaking internal ids', async () => {
    const bindings: unknown[][] = []
    const sqlStatements: string[] = []
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async first() {
                if (sql.includes('FROM profiles')) {
                  return {
                    userId: 'internal-user-id',
                    slug: 'eve',
                    displayName: 'Eve',
                    timezone: 'Asia/Hong_Kong',
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
              },
              async all() {
                if (sql.includes('GROUP BY source')) {
                  return { results: [{ source: 'codex', totalTokens: 300, totalTokensWithoutCacheRead: 240 }] }
                }

                return { results: [{ model: 'gpt-5.4', totalTokens: 500, totalTokensWithoutCacheRead: 410, costUsd: 1.5 }] }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const result = await getPublicUsageJson(db, 'eve', new Date('2026-04-29T10:00:00.000Z'))

    expect(result).toEqual({
      slug: 'eve',
      displayName: 'Eve',
      timezone: 'Asia/Hong_Kong',
      today: { tokens: 100, tokensWithoutCacheRead: 70, cacheReadRate: 0.3, costUsd: 0.2 },
      total: { tokens: 1200, tokensWithoutCacheRead: 900, cacheReadRate: 0.25, costUsd: 3.75 },
      month: { tokens: 500, tokensWithoutCacheRead: 380, cacheReadRate: 0.24, costUsd: 1.5 },
      sourceSplit: [{ source: 'codex', totalTokens: 300, totalTokensWithoutCacheRead: 240, cacheReadRate: 0.2 }],
      topModels: [{ model: 'gpt-5.4', totalTokens: 500, totalTokensWithoutCacheRead: 410, cacheReadRate: 0.18, costUsd: 1.5 }]
    })
    expect(JSON.stringify(result)).not.toContain('internal-user-id')
    expect(bindings[0]).toEqual(['eve'])
    expect(bindings[1]).toEqual([
      'internal-user-id',
      '2026-04-29',
      '2026-04-01',
      'internal-user-id',
      'internal-user-id'
    ])
    for (const sql of sqlStatements.slice(1)) {
      expect(sql).toContain('effective_daily_usage_summary')
      expect(sql).toContain('fallback_daily_usage_summary')
    }
    expect(sqlStatements[1]).toContain('user_usage_totals')
    expect(sqlStatements[1]).toContain('month_usage AS')
    expect(sqlStatements[1]).toContain('effective_daily_usage_summary.usage_date >= params.month_start')
    expect(sqlStatements[1]).not.toContain('CASE WHEN daily_usage_summary.usage_date')
  })

  test('renders a GitHub card with total and monthly token statistics', async () => {
    const db = {
      prepare(sql: string) {
        return {
          bind() {
            return {
              async first() {
                if (sql.includes('FROM profiles')) {
                  return {
                    userId: 'user_1',
                    slug: 'eve',
                    displayName: 'Eve & Co',
                    timezone: 'UTC',
                    publicCardConfig: JSON.stringify({
                      language: 'en',
                      theme: 'light',
                      title: 'Custom Usage',
                      subtitle: 'Open stats',
                      showPublicUrl: false,
                      glow: {
                        enabled: false,
                        intensity: 0.2,
                        position: 'center'
                      },
                      metrics: ['todayTokens', 'totalCost']
                    }),
                    isPublic: 1
                  }
                }

                return {
                  totalTokens: 1234567,
                  totalTokensWithoutCacheRead: 345678,
                  totalCostUsd: 42.5,
                  todayTokens: 100,
                  todayTokensWithoutCacheRead: 70,
                  todayCostUsd: 0.2,
                  monthTokens: 89012,
                  monthTokensWithoutCacheRead: 45678,
                  monthCostUsd: 6.78
                }
              },
              async all() {
                return { results: [] }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const svg = await getPublicUsageCard(
      db,
      'eve',
      new Date('2026-04-29T10:00:00.000Z'),
      'https://tokenboard.example.com'
    )

    expect(svg).toContain('Custom Usage')
    expect(svg).toContain('Open stats')
    expect(svg).not.toContain('https://tokenboard.example.com')
    expect(svg).toContain('Today Tokens')
    expect(svg).toContain('100')
    expect(svg).toContain('Total Cost')
    expect(svg).toContain('$42.50')
    expect(svg).not.toContain('Monthly Tokens')
    expect(svg).toContain('card-logo-panel')
    expect(svg).toContain('card-logo-lime')
    expect(svg).toContain('M130 118H282V164H229V382H181V164H130V118Z')
    expect(svg).toContain('M120 390H392')
  })

  test('rejects a private profile', async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return {
                  userId: 'user_1',
                  slug: 'eve',
                  displayName: 'Eve',
                  timezone: 'UTC',
                  publicCardConfig: null,
                  isPublic: 0
                }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await expect(getPublicUsageJson(db, 'eve')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404
    })
  })

  test('uses the public profile timezone for today and monthly public totals', async () => {
    const bindings: unknown[][] = []
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async first() {
                if (sql.includes('FROM profiles')) {
                  return {
                    userId: 'user_1',
                    slug: 'eve',
                    displayName: 'Eve',
                    timezone: 'Asia/Shanghai',
                    publicCardConfig: null,
                    isPublic: 1
                  }
                }

                return {
                  totalTokens: 0,
                  totalTokensWithoutCacheRead: 0,
                  totalCostUsd: 0,
                  todayTokens: 0,
                  todayTokensWithoutCacheRead: 0,
                  todayCostUsd: 0,
                  monthTokens: 0,
                  monthTokensWithoutCacheRead: 0,
                  monthCostUsd: 0
                }
              },
              async all() {
                return { results: [] }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await getPublicUsageJson(db, 'eve', new Date('2026-04-30T16:30:00.000Z'))

    expect(bindings[1]).toEqual(['user_1', '2026-05-01', '2026-05-01', 'user_1', 'user_1'])
    expect(bindings[2]).toEqual(['user_1', '2026-05-01', 'user_1', '2026-05-01'])
    expect(bindings[3]).toEqual(['user_1', '2026-05-01', 'user_1', '2026-05-01'])
  })
})
