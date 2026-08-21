import { renderToString } from 'hono/jsx/dom/server'
import { describe, expect, test } from 'vitest'
import { usageSources } from '@tokenboard/usage-core'
import { UsageDetailsFiltersForm } from './usage-details-filters'
import { formatSource } from '../source-format'

describe('UsageDetailsFiltersForm', () => {
  test('renders feedback-ready filter and export buttons', async () => {
    const html = await renderToString(
      <UsageDetailsFiltersForm
        filters={{
          source: 'all',
          startDate: '2026-05-01',
          endDate: '2026-05-31',
          deviceId: 'all',
          modelQuery: 'sonnet'
        }}
        devices={[
          {
            id: 'device_1',
            name: 'MacBook Pro',
            platform: 'darwin',
            lastSyncedAt: '2026-05-29T01:27:47.279Z',
            createdAt: '2026-04-29T10:03:36.232Z',
            activeTokenCount: 1,
            installations: [],
            uploadTokens: []
          }
        ]}
      />
    )

    expect(html).toContain('method="get"')
    expect(html).toContain('data-submit-feedback="true"')
    expect(html).toContain('data-submitting-label="正在应用..."')
    expect(html).toContain('data-link-button="true"')
    expect(html).toContain('href="/dashboard/details.csv?')
    expect(html).toContain('Antigravity CLI (agy)')
    expect(html).toContain('MacBook Pro')
  })
  test('offers every usage source in the source filter', async () => {
    const html = await renderToString(
      <UsageDetailsFiltersForm
        filters={{
          source: 'all',
          startDate: '2026-05-01',
          endDate: '2026-05-31',
          deviceId: 'all',
          modelQuery: ''
        }}
        devices={[]}
      />
    )

    // The query layer validates the source with usageSourceSchema, so a source
    // it accepts must be reachable from this control.
    for (const source of usageSources) {
      expect(html).toContain(`value="${source}"`)
      expect(html).toContain(formatSource(source))
    }
    expect(html).toContain('value="all"')
  })
})
