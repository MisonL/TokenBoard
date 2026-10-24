import { describe, expect, test } from 'vitest'
import { listLeaderboard } from './queries'

// Rows are typed loosely on purpose: the stub returns whatever the test hands it, including the
// NULLs a LEFT JOIN miss produces, which a typed row would reject before the mapping sees them.
function createDb(
  results: Array<Record<string, unknown>> = [
    {
      slug: 'eve-tokenboard',
      displayName: 'Eve',
      totalTokens: 1000,
      totalTokensWithoutCacheRead: 750,
      costUsd: 2.5,
      costAvailable: 1,
      isCurrentViewer: 0,
      primaryModel: 'claude-opus-4',
      sourceTokens: '[{"source":"claude-code","totalTokens":1000}]'
    }
  ]
) {
  const sqlStatements: string[] = []
  const bindings: unknown[][] = []
  const db = {
    prepare(sql: string) {
      sqlStatements.push(sql)
      return {
        bind(...values: unknown[]) {
          bindings.push(values)
          return {
            async all() {
              return {
                results
              }
            }
          }
        }
      }
    }
  } as unknown as D1Database

  return { db, sqlStatements, bindings }
}

describe('listLeaderboard', () => {
  test('lists monthly token leaderboard using a date range', async () => {
    const { db, sqlStatements, bindings } = createDb()

    const entries = await listLeaderboard(db, {
      period: 'monthly',
      metric: 'tokens',
      startDate: '2026-04-01',
      endDateExclusive: '2026-05-01',
      limit: 20
    })

    expect(entries).toEqual([
      {
        rank: 1,
        slug: 'eve-tokenboard',
        displayName: 'Eve',
        totalTokens: 1000,
        totalTokensWithoutCacheRead: 750,
        cacheReadRate: 0.25,
        costUsd: 2.5,
        costAvailable: true,
        primaryModel: 'claude-opus-4',
        sourceBreakdown: [{ source: 'claude-code', share: 1 }],
        isCurrentViewer: false
      }
    ])
    expect(sqlStatements[0]).toContain('effective_daily_usage_summary')
    expect(sqlStatements[0]).toContain('fallback_daily_usage_summary')
    expect(sqlStatements[0]).toContain('daily_usage.usage_date >= ? AND daily_usage.usage_date < ?')
    expect(sqlStatements[0]).toContain('daily_usage_summary.usage_date >= ? AND daily_usage_summary.usage_date < ?')
    expect(sqlStatements[0]).toContain('deduped_daily_usage')
    expect(sqlStatements[0]).toContain('ORDER BY totalTokens DESC, costUsd DESC')
    expect(bindings[0]).toEqual(['2026-04-01', '2026-05-01', '2026-04-01', '2026-05-01', null, 20])
  })

  // The viewer flag is the one field on an entry that depends on who is asking. It is resolved
  // inside the statement — the id is bound, compared, and never selected — so the id cannot end
  // up in a response by way of a row, and an anonymous viewer binds NULL, which matches nobody.
  test('binds the viewer id for the highlight and never selects it', async () => {
    const { db, sqlStatements, bindings } = createDb()

    const entries = await listLeaderboard(db, {
      period: 'daily',
      metric: 'tokens',
      startDate: '2026-04-01',
      endDateExclusive: '2026-04-02',
      viewerUserId: 'user_1'
    })

    expect(sqlStatements[0]).toContain('CASE WHEN profiles.user_id = ? THEN 1 ELSE 0 END as isCurrentViewer')
    expect(sqlStatements[0]).not.toContain('profiles.user_id as')
    expect(bindings[0]).toEqual(['2026-04-01', '2026-04-02', '2026-04-01', '2026-04-02', 'user_1', 50])
    expect(entries[0]?.isCurrentViewer).toBe(false)

    await listLeaderboard(db, {
      period: 'daily',
      metric: 'tokens',
      startDate: '2026-04-01',
      endDateExclusive: '2026-04-02'
    })
    expect(bindings[1]?.[4]).toBeNull()
  })

  test('lists monthly cost leaderboard ordered by cost first', async () => {
    const { db, sqlStatements } = createDb()

    await listLeaderboard(db, {
      period: 'monthly',
      metric: 'cost',
      startDate: '2026-04-01',
      endDateExclusive: '2026-05-01',
      limit: 20
    })

    expect(sqlStatements[0]).toContain('ORDER BY costUsd DESC, totalTokens DESC')
    expect(sqlStatements[0]).toContain(
      "source IN ('antigravity-cli', 'antigravity', 'antigravity-ide', 'grok-build', 'deepseek-harness')"
    )
    expect(sqlStatements[0]).toContain('MIN(CASE')
    expect(sqlStatements[0]).toContain(
      "SUM(CASE WHEN effective_daily_usage_summary.source IN ('antigravity-cli', 'antigravity', 'antigravity-ide', 'grok-build', 'deepseek-harness') THEN 0 ELSE effective_daily_usage_summary.cost_usd END)"
    )
  })

  // The model and source detail is joined in once per user rather than selected through
  // correlated subqueries: the ORDER BY sorts every candidate row, so a correlated subquery
  // would re-aggregate the window once per candidate instead of once per request.
  test('joins the model and source detail aggregates instead of correlating them', async () => {
    const { db, sqlStatements } = createDb()

    await listLeaderboard(db, {
      period: 'monthly',
      metric: 'tokens',
      startDate: '2026-04-01',
      endDateExclusive: '2026-05-01'
    })

    expect(sqlStatements[0]).toContain('user_primary_model AS (')
    expect(sqlStatements[0]).toContain('user_source_tokens AS (')
    expect(sqlStatements[0]).toContain('LEFT JOIN user_primary_model ON user_primary_model.user_id = profiles.user_id')
    expect(sqlStatements[0]).toContain('LEFT JOIN user_source_tokens ON user_source_tokens.user_id = profiles.user_id')
    expect(sqlStatements[0]).toContain('ROW_NUMBER() OVER')
    expect(sqlStatements[0]).toContain('json_group_array')
  })

  test('marks mixed billable and Antigravity usage cost unavailable', async () => {
    const { db } = createDb([
      {
        slug: 'mixed-user',
        displayName: 'Mixed User',
        totalTokens: 1300,
        totalTokensWithoutCacheRead: 1100,
        costUsd: 2.5,
        costAvailable: 0,
        isCurrentViewer: 1,
        // A LEFT JOIN miss yields NULL, which is the case the mapping has to turn into `null`
        // rather than a string.
        primaryModel: null,
        sourceTokens: '[{"source":"antigravity-cli","totalTokens":300},{"source":"codex","totalTokens":1000}]'
      }
    ])

    const entries = await listLeaderboard(db, {
      period: 'monthly',
      metric: 'cost',
      startDate: '2026-04-01',
      endDateExclusive: '2026-05-01',
      limit: 20
    })

    expect(entries[0]?.costUsd).toBe(2.5)
    expect(entries[0]?.costAvailable).toBe(false)
    expect(entries[0]?.primaryModel).toBeNull()
    expect(entries[0]?.isCurrentViewer).toBe(true)
    expect(entries[0]?.sourceBreakdown).toEqual([
      { source: 'codex', share: 1000 / 1300 },
      { source: 'antigravity-cli', share: 300 / 1300 }
    ])
  })

  test('lists leaderboard ordered by tokens without cache reads', async () => {
    const { db, sqlStatements } = createDb()

    await listLeaderboard(db, {
      period: 'monthly',
      metric: 'tokens-without-cache-read',
      startDate: '2026-04-01',
      endDateExclusive: '2026-05-01',
      limit: 20
    })

    expect(sqlStatements[0]).toContain('totalTokensWithoutCacheRead')
    expect(sqlStatements[0]).toContain('effective_daily_usage_summary.total_tokens_without_cache_read')
    expect(sqlStatements[0]).toContain('ORDER BY totalTokensWithoutCacheRead DESC, totalTokens DESC, costUsd DESC')
  })

  // This is the only query in the app that reads another user's usage, so its privacy
  // predicate is the whole boundary: drop either clause and a private profile's totals
  // become visible to everyone. The SQL text is the only thing enforcing that, so it is
  // pinned here — a refactor that removes the predicate must fail a test, not ship silently.
  test.each(['tokens', 'cost', 'tokens-without-cache-read'] as const)(
    'only ranks public, leaderboard-participating profiles (%s)',
    async (metric) => {
      const { db, sqlStatements } = createDb()

      await listLeaderboard(db, {
        period: 'daily',
        metric,
        startDate: '2026-04-01',
        endDateExclusive: '2026-04-02',
        limit: 20
      })

      expect(sqlStatements[0]).toContain('profiles.is_public = 1')
      expect(sqlStatements[0]).toContain('profiles.participates_in_leaderboards = 1')
    }
  )
})
