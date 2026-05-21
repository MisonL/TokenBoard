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

function isSpecificDeviceFilter(deviceId?: string) {
  const normalized = String(deviceId ?? '').trim()
  return Boolean(normalized && normalized.toLowerCase() !== 'all')
}
