import { renderToString } from 'hono/jsx/dom/server'
import { describe, expect, test } from 'vitest'
import { LeaderboardPanel } from './leaderboard-panel'

describe('LeaderboardPanel', () => {
  test('renders leaderboard entries with a mobile list and a desktop table', async () => {
    const html = await renderToString(
      <LeaderboardPanel
        period="daily"
        metric="tokens"
        rangeLabel="2026-04-29"
        timezone="UTC"
        timezoneLabel="UTC+0"
        entries={[
          {
            rank: 1,
            slug: 'example-user',
            displayName: 'Example User',
            totalTokens: 123456,
            totalTokensWithoutCacheRead: 100000,
            cacheReadRate: 23456 / 123456,
            costUsd: 42.31,
            costAvailable: true
          }
        ]}
      />
    )

    expect(html).toContain('data-leaderboard-mobile-list="true"')
    expect(html).toContain('data-leaderboard-desktop-table="true"')
    expect(html).toContain('app-surface-raised rounded-xl')
    expect(html).toContain('Example User')
    expect(html).toContain('123,456')
    expect(html).toContain('100,000')
    expect(html).toContain('grid rounded-full')
    expect(html).toContain('grid-cols-3')
    expect(html).toContain('tokens-without-cache-read')
    expect(html).toContain('不含缓存读')
    expect(html).toContain('缓存率')
    expect(html).toContain('19%')
  })

  test('renders an empty state that is not constrained by the desktop table', async () => {
    const html = await renderToString(
      <LeaderboardPanel
        entries={[]}
        period="daily"
        metric="tokens"
        rangeLabel="2026-04-29"
        timezone="UTC"
        timezoneLabel="UTC+0"
      />
    )

    expect(html).toContain('data-leaderboard-empty="true"')
    expect(html).toContain('app-surface-subtle rounded-xl')
    expect(html).not.toContain('colspan="4"')
  })

  test('names every cost-unavailable source on leaderboards', async () => {
    const html = await renderToString(
      <LeaderboardPanel
        entries={[
          {
            rank: 1,
            slug: 'agy-user',
            displayName: 'Agy User',
            totalTokens: 100,
            totalTokensWithoutCacheRead: 100,
            cacheReadRate: 0,
            costUsd: 0,
            costAvailable: false
          }
        ]}
        period="daily"
        metric="cost"
        rangeLabel="2026-04-29"
        timezone="UTC"
        timezoneLabel="UTC+0"
      />
    )

    expect(html).toContain('Antigravity、Grok Build、DeepSeek Harness 费用不可用，费用列和费用排名不包含这些来源成本。')
    expect(html).toContain('费用不可用')
    expect(html).not.toContain('$0.00')
  })
})

// The panel used to render a title and a table with no indication of which day it covered, so
// a viewer had no way to tell whether the numbers were today's. The caption now carries the
// window the query ranked and the offset it was measured in.
describe('LeaderboardPanel range caption', () => {
  test('states the day a daily board covers and the viewer offset', async () => {
    const html = await renderToString(
      <LeaderboardPanel
        entries={[]}
        period="daily"
        metric="tokens"
        rangeLabel="2026-05-01"
        timezone="Asia/Shanghai"
        timezoneLabel="UTC+8"
      />
    )

    expect(html).toContain('data-leaderboard-range="true"')
    expect(html).toContain('2026-05-01')
    expect(html).toContain('UTC+8')
    expect(html).toContain('Asia/Shanghai')
  })

  test('states the month a monthly board covers', async () => {
    const html = await renderToString(
      <LeaderboardPanel
        entries={[]}
        period="monthly"
        metric="cost"
        rangeLabel="2026-05"
        timezone="America/Los_Angeles"
        timezoneLabel="UTC-7"
      />
    )

    expect(html).toContain('2026-05')
    expect(html).toContain('UTC-7')
  })

  // Two users' rows labelled with the same date were collected in different zones, so a viewer
  // comparing themselves against someone abroad is comparing different windows. Saying only the
  // viewer's own offset would imply the two are the same day, which is the misreading this
  // surface invited.
  test('explains that each collector stamps its own local day', async () => {
    const html = await renderToString(
      <LeaderboardPanel
        entries={[]}
        period="daily"
        metric="tokens"
        rangeLabel="2026-05-01"
        timezone="Asia/Shanghai"
        timezoneLabel="UTC+8"
      />
    )

    expect(html).toContain('各自本地时区')
  })
})
