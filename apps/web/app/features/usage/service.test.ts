import { describe, expect, test } from 'vitest'
import { parseUsageDetailsFilters, usageDetailsToCsv } from './service'

describe('parseUsageDetailsFilters', () => {
  test('defaults to the last 30 days and all sources', () => {
    const filters = parseUsageDetailsFilters({}, new Date('2026-04-29T12:00:00.000Z'))

    expect(filters).toEqual({
      source: 'all',
      startDate: '2026-03-31',
      endDate: '2026-04-29',
      deviceId: 'all',
      modelQuery: ''
    })
  })

  // The default window has to be the user's own day. `daily_usage.usage_date` is stamped by the
  // collector in local time, so a UTC window shows the previous day for the whole evening in the
  // Americas and mismatches the README card, which already reads its date in the profile zone.
  test('defaults the window to the local day, not the UTC one', () => {
    // 18:00 UTC is already the next day in Shanghai and still the same day in Los Angeles.
    const now = new Date('2026-04-29T18:00:00.000Z')

    expect(parseUsageDetailsFilters({}, now, 'Asia/Shanghai')).toMatchObject({
      startDate: '2026-04-01',
      endDate: '2026-04-30'
    })
    expect(parseUsageDetailsFilters({}, now, 'America/Los_Angeles')).toMatchObject({
      startDate: '2026-03-31',
      endDate: '2026-04-29'
    })
  })

  test('ignores the timezone when the caller supplies both dates', () => {
    const filters = parseUsageDetailsFilters(
      { startDate: '2026-01-01', endDate: '2026-01-31' },
      new Date('2026-04-29T18:00:00.000Z'),
      'Asia/Shanghai'
    )

    expect(filters).toMatchObject({ startDate: '2026-01-01', endDate: '2026-01-31' })
  })

  test('keeps valid date range, source, device, and model filters', () => {
    const filters = parseUsageDetailsFilters(
      {
        source: 'claude-code',
        startDate: '2026-04-01',
        endDate: '2026-04-15',
        device: 'dev_123',
        model: ' sonnet '
      },
      new Date('2026-04-29T12:00:00.000Z')
    )

    expect(filters).toEqual({
      source: 'claude-code',
      startDate: '2026-04-01',
      endDate: '2026-04-15',
      deviceId: 'dev_123',
      modelQuery: 'sonnet'
    })
  })

  test('normalizes all-device filter variants', () => {
    const filters = parseUsageDetailsFilters(
      {
        device: ' ALL '
      },
      new Date('2026-04-29T12:00:00.000Z')
    )

    expect(filters.deviceId).toBe('all')
  })

  test('keeps Antigravity CLI source filters', () => {
    const filters = parseUsageDetailsFilters(
      {
        source: 'antigravity-cli'
      },
      new Date('2026-04-29T12:00:00.000Z')
    )

    expect(filters.source).toBe('antigravity-cli')
  })

  test('normalizes reversed date ranges', () => {
    const filters = parseUsageDetailsFilters(
      {
        source: 'codex',
        startDate: '2026-04-20',
        endDate: '2026-04-01'
      },
      new Date('2026-04-29T12:00:00.000Z')
    )

    expect(filters).toEqual({
      source: 'codex',
      startDate: '2026-04-01',
      endDate: '2026-04-20',
      deviceId: 'all',
      modelQuery: ''
    })
  })
})

describe('usageDetailsToCsv', () => {
  test('exports model rows with escaped CSV fields', () => {
    const csv = usageDetailsToCsv({
      summary: {
        totalTokens: 10,
        totalTokensWithoutCacheRead: 6,
        cacheReadRate: 0.4,
        costUsd: 0.25,
        sessionCount: 1,
        activeDays: 1
      },
      dailyRows: [],
      modelRows: [
        {
          usageDate: '2026-04-29',
          source: 'claude-code',
          model: 'claude, "sonnet"',
          inputTokens: 1,
          outputTokens: 2,
          cacheCreationTokens: 3,
          cacheReadTokens: 4,
          cacheReadRate: 0.4,
          totalTokens: 10,
          totalTokensWithoutCacheRead: 6,
          costUsd: 0.25,
          sessionCount: 1
        }
      ]
    })

    expect(csv).toBe(
      [
        'date,source,model,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,cache_read_rate,total_tokens_without_cache_read,total_tokens,cost_usd,cost_available,session_count',
        '2026-04-29,claude-code,"claude, ""sonnet""",1,2,3,4,0.4,6,10,0.25,true,1'
      ].join('\n')
    )
  })

  // A spreadsheet treats a cell starting with `=`, `+`, `-` or `@` as a formula and evaluates
  // it on open, so a model name is a code-injection vector the moment the file is opened. The
  // value here is the user's own model name, which the collector takes from local session
  // files — attacker-influenced if any tool writes a crafted model string. Quoting does not
  // help: the quoting in the row above is CSV-level escaping, and Excel strips it before it
  // decides whether the cell is a formula. Prefixing a single quote is what makes the cell
  // literal.
  test('neutralises spreadsheet formulas in exported fields', () => {
    const csv = usageDetailsToCsv({
      summary: {
        totalTokens: 10,
        totalTokensWithoutCacheRead: 6,
        cacheReadRate: 0.4,
        costUsd: 0.25,
        sessionCount: 1,
        activeDays: 1
      },
      dailyRows: [],
      modelRows: ['=1+1', '+A1', '-2+3', '@SUM(1)', "=cmd|'/C calc'!A0"].map((model) => ({
        usageDate: '2026-04-29',
        source: 'claude-code',
        model,
        inputTokens: 1,
        outputTokens: 2,
        cacheCreationTokens: 3,
        cacheReadTokens: 4,
        cacheReadRate: 0.4,
        totalTokens: 10,
        totalTokensWithoutCacheRead: 6,
        costUsd: 0.25,
        sessionCount: 1
      }))
    })

    for (const line of csv.split('\n').slice(1)) {
      const modelCell = line.split(',')[2]
      expect(modelCell.startsWith("'")).toBe(true)
    }
  })

  test('exports unavailable Antigravity cost as blank with an availability flag', () => {
    const csv = usageDetailsToCsv({
      summary: {
        totalTokens: 10,
        totalTokensWithoutCacheRead: 6,
        cacheReadRate: 0.4,
        costUsd: 0,
        sessionCount: 1,
        activeDays: 1
      },
      dailyRows: [],
      modelRows: [
        {
          usageDate: '2026-04-29',
          source: 'antigravity-ide',
          model: 'gemini-3.5-flash',
          inputTokens: 1,
          outputTokens: 2,
          cacheCreationTokens: 3,
          cacheReadTokens: 4,
          cacheReadRate: 0.4,
          totalTokens: 10,
          totalTokensWithoutCacheRead: 6,
          costUsd: 0,
          sessionCount: 1
        }
      ]
    })

    expect(csv).toBe(
      [
        'date,source,model,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,cache_read_rate,total_tokens_without_cache_read,total_tokens,cost_usd,cost_available,session_count',
        '2026-04-29,antigravity-ide,gemini-3.5-flash,1,2,3,4,0.4,6,10,,false,1'
      ].join('\n')
    )
  })
})
