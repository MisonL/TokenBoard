import { renderToString } from 'hono/jsx/dom/server'
import { describe, expect, test } from 'vitest'
import { DailyReportHistoryCard } from './report-history-card'

describe('DailyReportHistoryCard', () => {
  test('keeps Antigravity cost-unavailable labels in top model details', async () => {
    const html = await renderToString(
      <DailyReportHistoryCard
        dailyReportShareEnabled
        retentionDays={30}
        reportHistory={[{
          id: 'drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          displayName: 'Example',
          reportDate: '2026-04-29',
          scheduleSlot: '2026-04-29T18:00',
          timezone: 'Asia/Shanghai',
          dashboardUrl: 'https://tokenboard.example.com/dashboard',
          totalTokens: 300,
          totalTokensWithoutCacheRead: 260,
          cacheReadRate: 0.13,
          costUsd: 0,
          sessionCount: 1,
          reportUrl: '/reports/daily/drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          shareRevokedAt: null,
          sourceSplit: [{
            source: 'antigravity-cli',
            totalTokens: 300,
            totalTokensWithoutCacheRead: 260,
            cacheReadRate: 0.13
          }],
          topModels: [{
            model: 'Gemini 3.5 Flash (Medium)',
            totalTokens: 300,
            totalTokensWithoutCacheRead: 260,
            cacheReadRate: 0.13,
            costUsd: 0
          }],
          generatedAt: '2026-04-29T10:00:00.000Z',
          updatedAt: '2026-04-29T10:00:00.000Z'
        }]}
      />
    )

    expect(html).toContain('$0.00 (Antigravity CLI 费用不可用)')
  })
})
