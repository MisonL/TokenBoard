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
