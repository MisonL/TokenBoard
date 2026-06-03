export const dedupedDailyUsageCte = `
deduped_daily_usage AS (
  SELECT daily_usage.*
  FROM daily_usage
  WHERE daily_usage.device_id <> 'legacy'
    OR NOT EXISTS (
      SELECT 1
      FROM daily_usage AS current_usage
      WHERE current_usage.user_id = daily_usage.user_id
        AND current_usage.usage_date = daily_usage.usage_date
        AND current_usage.source = daily_usage.source
        AND current_usage.model = daily_usage.model
        AND current_usage.device_id <> 'legacy'
    )
)`

const summaryColumns = [
  'user_id',
  'usage_date',
  'source',
  'model',
  'timezone',
  'input_tokens',
  'output_tokens',
  'cache_creation_tokens',
  'cache_read_tokens',
  'total_tokens',
  'total_tokens_without_cache_read',
  'cost_usd',
  'session_count',
  'updated_at'
]

export function effectiveDailyUsageSummaryWith(input?: {
  dailyUsageFilter?: string
  summaryFilter?: string
}) {
  const dailyUsageFilter = input?.dailyUsageFilter
    ? `AND (${input.dailyUsageFilter})`
    : ''
  const summaryFilter = input?.summaryFilter
    ? `WHERE ${input.summaryFilter}`
    : ''
  return `
deduped_daily_usage AS (
  SELECT daily_usage.*
  FROM daily_usage
  WHERE (
      daily_usage.device_id <> 'legacy'
      OR NOT EXISTS (
        SELECT 1
        FROM daily_usage AS current_usage
        WHERE current_usage.user_id = daily_usage.user_id
          AND current_usage.usage_date = daily_usage.usage_date
          AND current_usage.source = daily_usage.source
          AND current_usage.model = daily_usage.model
          AND current_usage.device_id <> 'legacy'
      )
    )
    ${dailyUsageFilter}
),
fallback_daily_usage_summary AS (
  SELECT
    user_id,
    usage_date,
    source,
    model,
    COALESCE(MAX(timezone), 'UTC') as timezone,
    COALESCE(SUM(input_tokens), 0) as input_tokens,
    COALESCE(SUM(output_tokens), 0) as output_tokens,
    COALESCE(SUM(cache_creation_tokens), 0) as cache_creation_tokens,
    COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens,
    COALESCE(SUM(total_tokens), 0) as total_tokens,
    COALESCE(SUM(total_tokens - cache_read_tokens), 0) as total_tokens_without_cache_read,
    COALESCE(SUM(cost_usd), 0) as cost_usd,
    COALESCE(SUM(session_count), 0) as session_count,
    MAX(synced_at) as updated_at
  FROM deduped_daily_usage
  WHERE NOT EXISTS (
    SELECT 1
    FROM daily_usage_summary
    WHERE daily_usage_summary.user_id = deduped_daily_usage.user_id
      AND daily_usage_summary.usage_date = deduped_daily_usage.usage_date
      AND daily_usage_summary.source = deduped_daily_usage.source
      AND daily_usage_summary.model = deduped_daily_usage.model
  )
  GROUP BY user_id, usage_date, source, model
),
effective_daily_usage_summary AS (
  SELECT ${summaryColumns.join(', ')}
  FROM daily_usage_summary
  ${summaryFilter}
  UNION ALL
  SELECT ${summaryColumns.join(', ')}
  FROM fallback_daily_usage_summary
)`
}

export function usageTableForDeviceFilter(deviceId?: string) {
  return isSpecificDeviceFilter(deviceId) ? 'daily_usage' : 'deduped_daily_usage'
}

export function optionalDedupedDailyUsageWith(deviceId?: string) {
  return isSpecificDeviceFilter(deviceId) ? '' : `WITH ${dedupedDailyUsageCte}`
}

export function tokensWithoutCacheReadSql(tableAlias?: string) {
  const prefix = tableAlias ? `${tableAlias}.` : ''
  return `${prefix}total_tokens - ${prefix}cache_read_tokens`
}

export function normalizeDeviceFilter(deviceId?: string) {
  const normalized = String(deviceId ?? '').trim()
  if (!normalized || normalized.toLowerCase() === 'all') return 'all'
  return /^[A-Za-z0-9_-]{1,128}$/.test(normalized) ? normalized : 'all'
}

function isSpecificDeviceFilter(deviceId?: string) {
  return normalizeDeviceFilter(deviceId) !== 'all'
}
