import type { UsageSource } from '@tokenboard/usage-core'
import {
  effectiveDailyUsageSummaryWith,
  normalizeDeviceFilter,
  optionalDedupedDailyUsageWith,
  tokensWithoutCacheReadSql,
  usageTableForDeviceFilter
} from './deduped-daily-usage'
import { cacheReadRateFromTotals } from '../../lib/usage-metrics'

export type UsageSummaryInput = {
  userId: string
  today: string
  monthStart: string
  summaryStrict?: boolean
}

export type UsageSummary = {
  todayTokens: number
  todayTokensWithoutCacheRead: number
  todayCacheReadRate: number
  todayCostUsd: number
  monthTokens: number
  monthTokensWithoutCacheRead: number
  monthCacheReadRate: number
  monthCostUsd: number
  lastSyncedAt: string | null
  deviceCount: number
  sourceSplit: Array<{
    source: UsageSource
    totalTokens: number
    totalTokensWithoutCacheRead: number
    cacheReadRate: number
  }>
}

export type DailyUsageTrendInput = {
  userId: string
  startDate: string
  endDate: string
  summaryStrict?: boolean
}

export type DailyUsageTrendItem = {
  usageDate: string
  totalTokens: number
  totalTokensWithoutCacheRead: number
  cacheReadRate: number
  costUsd: number
}

export type UsageDetailsInput = {
  userId: string
  startDate: string
  endDate: string
  source: UsageSource | 'all'
  deviceId?: string
  modelQuery?: string
}

export type UsageDetailsDailyRow = {
  usageDate: string
  totalTokens: number
  totalTokensWithoutCacheRead: number
  cacheReadRate: number
  costUsd: number
  sessionCount: number
  sourceSplit: Array<{
    source: UsageSource
    totalTokens: number
    totalTokensWithoutCacheRead: number
    cacheReadRate: number
  }>
  modelRows: UsageDetailsModelRow[]
}

export type UsageDetailsModelRow = {
  usageDate: string
  source: UsageSource
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  totalTokens: number
  totalTokensWithoutCacheRead: number
  cacheReadRate: number
  costUsd: number
  sessionCount: number
}

export type UsageDetails = {
  summary: {
    totalTokens: number
    totalTokensWithoutCacheRead: number
    cacheReadRate: number
    costUsd: number
    sessionCount: number
    activeDays: number
  }
  dailyRows: UsageDetailsDailyRow[]
  modelRows: UsageDetailsModelRow[]
}

type SummaryRow = {
  todayTokens: number | null
  todayTokensWithoutCacheRead: number | null
  todayCostUsd: number | null
  monthTokens: number | null
  monthTokensWithoutCacheRead: number | null
  monthCostUsd: number | null
  lastSyncedAt: string | null
  deviceCount: number | null
  sourceSplit: unknown
}

export async function getUsageSummary(
  db: D1Database,
  input: UsageSummaryInput
): Promise<UsageSummary> {
  const summary = await db
    .prepare(
      `
        WITH params(user_id, today, month_start) AS (SELECT ?, ?, ?),
        ${effectiveDailyUsageSummaryWith({
          dailyUsageFilter: `
            daily_usage.user_id = (SELECT user_id FROM params)
            AND daily_usage.usage_date >= (SELECT month_start FROM params)
          `,
          summaryFilter: `
            daily_usage_summary.user_id = (SELECT user_id FROM params)
            AND daily_usage_summary.usage_date >= (SELECT month_start FROM params)
          `,
          summaryStrict: input.summaryStrict
        })},
        month_usage AS (
          SELECT
            effective_daily_usage_summary.*
          FROM effective_daily_usage_summary
          JOIN params ON params.user_id = effective_daily_usage_summary.user_id
        ),
        source_usage AS (
          SELECT
            source,
            COALESCE(SUM(total_tokens), 0) as total_tokens,
            COALESCE(SUM(total_tokens_without_cache_read), 0) as total_tokens_without_cache_read
          FROM month_usage
          GROUP BY source
        ),
        device_stats AS (
          SELECT
            devices.user_id,
            MAX(devices.last_synced_at) as lastSyncedAt,
            COUNT(*) as deviceCount
          FROM devices
          GROUP BY devices.user_id
        )
        SELECT
          COALESCE(SUM(CASE WHEN month_usage.usage_date = params.today THEN month_usage.total_tokens ELSE 0 END), 0) as todayTokens,
          COALESCE(SUM(CASE WHEN month_usage.usage_date = params.today THEN month_usage.total_tokens_without_cache_read ELSE 0 END), 0) as todayTokensWithoutCacheRead,
          COALESCE(SUM(CASE WHEN month_usage.usage_date = params.today THEN month_usage.cost_usd ELSE 0 END), 0) as todayCostUsd,
          COALESCE(SUM(month_usage.total_tokens), 0) as monthTokens,
          COALESCE(SUM(month_usage.total_tokens_without_cache_read), 0) as monthTokensWithoutCacheRead,
          COALESCE(SUM(month_usage.cost_usd), 0) as monthCostUsd,
          device_stats.lastSyncedAt as lastSyncedAt,
          COALESCE(device_stats.deviceCount, 0) as deviceCount,
          (
            SELECT COALESCE(json_group_array(json_object(
              'source', ordered_sources.source,
              'totalTokens', ordered_sources.total_tokens,
              'totalTokensWithoutCacheRead', ordered_sources.total_tokens_without_cache_read
            )), '[]')
            FROM (
              SELECT
                source,
                total_tokens,
                total_tokens_without_cache_read
              FROM source_usage
              ORDER BY total_tokens_without_cache_read DESC, total_tokens DESC
            ) AS ordered_sources
          ) as sourceSplit
        FROM params
        LEFT JOIN month_usage ON month_usage.user_id = params.user_id
        LEFT JOIN device_stats ON device_stats.user_id = params.user_id
      `
    )
    .bind(input.userId, input.today, input.monthStart)
    .first<SummaryRow>()
  const sourceSplit = parseSummarySourceSplit(summary?.sourceSplit)

  return {
    todayTokens: Number(summary?.todayTokens ?? 0),
    todayTokensWithoutCacheRead: Number(summary?.todayTokensWithoutCacheRead ?? 0),
    todayCacheReadRate: cacheReadRateFromTotals({
      totalTokens: Number(summary?.todayTokens ?? 0),
      totalTokensWithoutCacheRead: Number(summary?.todayTokensWithoutCacheRead ?? 0)
    }),
    todayCostUsd: Number(summary?.todayCostUsd ?? 0),
    monthTokens: Number(summary?.monthTokens ?? 0),
    monthTokensWithoutCacheRead: Number(summary?.monthTokensWithoutCacheRead ?? 0),
    monthCacheReadRate: cacheReadRateFromTotals({
      totalTokens: Number(summary?.monthTokens ?? 0),
      totalTokensWithoutCacheRead: Number(summary?.monthTokensWithoutCacheRead ?? 0)
    }),
    monthCostUsd: Number(summary?.monthCostUsd ?? 0),
    lastSyncedAt: summary?.lastSyncedAt ?? null,
    deviceCount: Number(summary?.deviceCount ?? 0),
    sourceSplit: sourceSplit.map((row) => ({
      source: row.source,
      totalTokens: Number(row.totalTokens),
      totalTokensWithoutCacheRead: Number(row.totalTokensWithoutCacheRead),
      cacheReadRate: cacheReadRateFromTotals({
        totalTokens: Number(row.totalTokens),
        totalTokensWithoutCacheRead: Number(row.totalTokensWithoutCacheRead)
      })
    }))
  }
}

function parseSummarySourceSplit(value: unknown) {
  if (!value) return []
  const parsed = typeof value === 'string' ? JSON.parse(value) : value
  if (!Array.isArray(parsed)) {
    throw new Error('Invalid dashboard summary sourceSplit')
  }
  return parsed.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Invalid dashboard summary sourceSplit item')
    }
    const row = item as Record<string, unknown>
    if (typeof row.source !== 'string') throw new Error('Invalid dashboard summary sourceSplit source')
    return {
      source: row.source as UsageSource,
      totalTokens: Number(row.totalTokens ?? 0),
      totalTokensWithoutCacheRead: Number(row.totalTokensWithoutCacheRead ?? 0)
    }
  })
}

export async function getDailyUsageTrend(
  db: D1Database,
  input: DailyUsageTrendInput
): Promise<DailyUsageTrendItem[]> {
  const rows = await db
    .prepare(
      `
        WITH ${effectiveDailyUsageSummaryWith({
          dailyUsageFilter: 'daily_usage.user_id = ? AND daily_usage.usage_date >= ? AND daily_usage.usage_date <= ?',
          summaryFilter: 'daily_usage_summary.user_id = ? AND daily_usage_summary.usage_date >= ? AND daily_usage_summary.usage_date <= ?',
          summaryStrict: input.summaryStrict
        })}
        SELECT
          usage_date as usageDate,
          COALESCE(SUM(total_tokens), 0) as totalTokens,
          COALESCE(SUM(total_tokens_without_cache_read), 0) as totalTokensWithoutCacheRead,
          COALESCE(SUM(cost_usd), 0) as costUsd
        FROM effective_daily_usage_summary
        GROUP BY usage_date
        ORDER BY usage_date ASC
      `
    )
    .bind(...summaryRangeBindings(input.summaryStrict, input.userId, input.startDate, input.endDate))
    .all<DailyUsageTrendItem>()

  const byDate = new Map(
    (rows.results ?? []).map((row) => [
      row.usageDate,
      {
        usageDate: row.usageDate,
        totalTokens: Number(row.totalTokens),
        totalTokensWithoutCacheRead: Number(row.totalTokensWithoutCacheRead),
        cacheReadRate: cacheReadRateFromTotals({
          totalTokens: Number(row.totalTokens),
          totalTokensWithoutCacheRead: Number(row.totalTokensWithoutCacheRead)
        }),
        costUsd: Number(row.costUsd)
      }
    ])
  )

  return eachIsoDate(input.startDate, input.endDate).map(
    (usageDate) => byDate.get(usageDate) ?? {
      usageDate,
      totalTokens: 0,
      totalTokensWithoutCacheRead: 0,
      cacheReadRate: 0,
      costUsd: 0
    }
  )
}

export async function getUsageDetails(
  db: D1Database,
  input: UsageDetailsInput
): Promise<UsageDetails> {
  const deviceId = normalizeDeviceFilter(input.deviceId)
  const usageTable = usageTableForDeviceFilter(deviceId)
  const dedupedUsageFilter = usageDetailsDedupedFilter(deviceId)
  const usageWith = optionalDedupedDailyUsageWith(deviceId, dedupedUsageFilter)
  const bindings = usageDetailsBindings(input, deviceId)
  const dailySourceRows = await db
    .prepare(
      `
        ${usageWith}
        SELECT
          usage_date as usageDate,
          source,
          COALESCE(SUM(total_tokens), 0) as totalTokens,
          COALESCE(SUM(${tokensWithoutCacheReadSql()}), 0) as totalTokensWithoutCacheRead,
          COALESCE(SUM(cost_usd), 0) as costUsd,
          COALESCE(SUM(session_count), 0) as sessionCount
        FROM ${usageTable}
        WHERE user_id = ?
          AND usage_date >= ?
          AND usage_date <= ?
          AND (? = 'all' OR source = ?)
          AND (? = 'all' OR device_id = ?)
          AND (? = '' OR lower(model) LIKE '%' || lower(?) || '%')
        GROUP BY usage_date, source
        ORDER BY usage_date ASC, source ASC
      `
    )
    .bind(...bindings)
    .all<{
      usageDate: string
      source: UsageSource
      totalTokens: number
      totalTokensWithoutCacheRead: number
      costUsd: number
      sessionCount: number
    }>()

  const modelRowsResult = await db
    .prepare(
      `
        ${usageWith}
        SELECT
          usage_date as usageDate,
          source,
          model,
          COALESCE(SUM(input_tokens), 0) as inputTokens,
          COALESCE(SUM(output_tokens), 0) as outputTokens,
          COALESCE(SUM(cache_creation_tokens), 0) as cacheCreationTokens,
          COALESCE(SUM(cache_read_tokens), 0) as cacheReadTokens,
          COALESCE(SUM(total_tokens), 0) as totalTokens,
          COALESCE(SUM(${tokensWithoutCacheReadSql()}), 0) as totalTokensWithoutCacheRead,
          COALESCE(SUM(cost_usd), 0) as costUsd,
          COALESCE(SUM(session_count), 0) as sessionCount
        FROM ${usageTable}
        WHERE user_id = ?
          AND usage_date >= ?
          AND usage_date <= ?
          AND (? = 'all' OR source = ?)
          AND (? = 'all' OR device_id = ?)
          AND (? = '' OR lower(model) LIKE '%' || lower(?) || '%')
        GROUP BY usage_date, source, model
        ORDER BY usage_date DESC, totalTokens DESC, model ASC
      `
    )
    .bind(...bindings)
    .all<UsageDetailsModelRow>()

  const modelRows = (modelRowsResult.results ?? []).map((row) => ({
    usageDate: row.usageDate,
    source: row.source,
    model: row.model,
    inputTokens: Number(row.inputTokens),
    outputTokens: Number(row.outputTokens),
    cacheCreationTokens: Number(row.cacheCreationTokens),
    cacheReadTokens: Number(row.cacheReadTokens),
    totalTokens: Number(row.totalTokens),
    totalTokensWithoutCacheRead: Number(row.totalTokensWithoutCacheRead),
    cacheReadRate: cacheReadRateFromTotals({
      totalTokens: Number(row.totalTokens),
      totalTokensWithoutCacheRead: Number(row.totalTokensWithoutCacheRead)
    }),
    costUsd: Number(row.costUsd),
    sessionCount: Number(row.sessionCount)
  }))
  const dailyRows = buildDailyDetails(
    input.startDate,
    input.endDate,
    (dailySourceRows.results ?? []).map((row) => ({
      usageDate: row.usageDate,
      source: row.source,
      totalTokens: Number(row.totalTokens),
      totalTokensWithoutCacheRead: Number(row.totalTokensWithoutCacheRead),
      cacheReadRate: cacheReadRateFromTotals({
        totalTokens: Number(row.totalTokens),
        totalTokensWithoutCacheRead: Number(row.totalTokensWithoutCacheRead)
      }),
      costUsd: Number(row.costUsd),
      sessionCount: Number(row.sessionCount)
    })),
    modelRows
  )

  return {
    summary: {
      totalTokens: dailyRows.reduce((total, row) => total + row.totalTokens, 0),
      totalTokensWithoutCacheRead: dailyRows.reduce((total, row) => total + row.totalTokensWithoutCacheRead, 0),
      cacheReadRate: cacheReadRateFromTotals({
        totalTokens: dailyRows.reduce((total, row) => total + row.totalTokens, 0),
        totalTokensWithoutCacheRead: dailyRows.reduce((total, row) => total + row.totalTokensWithoutCacheRead, 0)
      }),
      costUsd: roundMetric(dailyRows.reduce((total, row) => total + row.costUsd, 0)),
      sessionCount: dailyRows.reduce((total, row) => total + row.sessionCount, 0),
      activeDays: dailyRows.filter((row) => row.totalTokens > 0).length
    },
    dailyRows,
    modelRows
  }
}

function usageDetailsDedupedFilter(deviceId: string) {
  if (deviceId !== 'all') return undefined
  return `
    daily_usage.user_id = ?
    AND daily_usage.usage_date >= ?
    AND daily_usage.usage_date <= ?
    AND (? = 'all' OR daily_usage.source = ?)
    AND (? = '' OR lower(daily_usage.model) LIKE '%' || lower(?) || '%')
  `
}

function usageDetailsBindings(input: UsageDetailsInput, deviceId: string) {
  const outer = [
    input.userId,
    input.startDate,
    input.endDate,
    input.source,
    input.source,
    deviceId,
    deviceId,
    input.modelQuery ?? '',
    input.modelQuery ?? ''
  ]
  if (deviceId !== 'all') return outer
  return [
    input.userId,
    input.startDate,
    input.endDate,
    input.source,
    input.source,
    input.modelQuery ?? '',
    input.modelQuery ?? '',
    ...outer
  ]
}

function buildDailyDetails(
  startDate: string,
  endDate: string,
  rows: Array<{
    usageDate: string
    source: UsageSource
    totalTokens: number
    totalTokensWithoutCacheRead: number
    cacheReadRate: number
    costUsd: number
    sessionCount: number
  }>,
  modelRows: UsageDetailsModelRow[]
) {
  const byDate = new Map<string, UsageDetailsDailyRow>()

  for (const usageDate of eachIsoDate(startDate, endDate)) {
    byDate.set(usageDate, {
      usageDate,
      totalTokens: 0,
      totalTokensWithoutCacheRead: 0,
      cacheReadRate: 0,
      costUsd: 0,
      sessionCount: 0,
      sourceSplit: [],
      modelRows: []
    })
  }

  for (const row of rows) {
    const daily = byDate.get(row.usageDate)
    if (!daily) continue

    daily.totalTokens += row.totalTokens
    daily.totalTokensWithoutCacheRead += row.totalTokensWithoutCacheRead
    daily.cacheReadRate = cacheReadRateFromTotals({
      totalTokens: daily.totalTokens,
      totalTokensWithoutCacheRead: daily.totalTokensWithoutCacheRead
    })
    daily.costUsd = roundMetric(daily.costUsd + row.costUsd)
    daily.sessionCount += row.sessionCount
    daily.sourceSplit.push({
      source: row.source,
      totalTokens: row.totalTokens,
      totalTokensWithoutCacheRead: row.totalTokensWithoutCacheRead,
      cacheReadRate: row.cacheReadRate
    })
  }

  for (const row of modelRows) {
    byDate.get(row.usageDate)?.modelRows.push(row)
  }

  return [...byDate.values()]
}

function eachIsoDate(startDate: string, endDate: string) {
  const dates: string[] = []
  const current = new Date(`${startDate}T00:00:00.000Z`)
  const end = new Date(`${endDate}T00:00:00.000Z`)

  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10))
    current.setUTCDate(current.getUTCDate() + 1)
  }

  return dates
}

function roundMetric(value: number) {
  return Math.round(value * 10000) / 10000
}

function summaryRangeBindings(
  summaryStrict: boolean | undefined,
  userId: string,
  startDate: string,
  endDate: string
) {
  return summaryStrict
    ? [userId, startDate, endDate]
    : [userId, startDate, endDate, userId, startDate, endDate]
}
