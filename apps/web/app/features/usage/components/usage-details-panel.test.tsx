import { renderToString } from 'hono/jsx/dom/server'
import { describe, expect, test } from 'vitest'
import { UsageDetailsPanel } from './usage-details-panel'

describe('UsageDetailsPanel', () => {
  test('keeps the filter form out of the 1024px header layout', async () => {
    const html = await renderToString(
      <UsageDetailsPanel
        devices={[
          {
            id: 'device_1',
            name: 'MacBook Pro With A Long Local Collector Name',
            platform: 'darwin',
            lastSyncedAt: '2026-05-25T01:00:00.000Z',
            createdAt: '2026-05-01T01:00:00.000Z',
            activeTokenCount: 1
          }
        ]}
        filters={{
          source: 'all',
          startDate: '2026-04-26',
          endDate: '2026-05-25',
          deviceId: 'all',
          modelQuery: 'gpt'
        }}
        details={{
          summary: {
            totalTokens: 123456,
            costUsd: 42.31,
            sessionCount: 12,
            activeDays: 3
          },
          dailyRows: [
            {
              usageDate: '2026-05-25',
              totalTokens: 123456,
              costUsd: 42.31,
              sessionCount: 12,
              sourceSplit: [{ source: 'codex', totalTokens: 123456 }],
              modelRows: []
            }
          ],
          modelRows: []
        }}
      />
    )

    expect(html).toContain('xl:flex-row')
    expect(html).toContain('xl:min-w-[900px]')
    expect(html).not.toContain('lg:min-w-[900px]')
    expect(html).not.toContain('&rsaquo;')
    expect(html).not.toContain('>›<')
  })
})
