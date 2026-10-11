import type { UsageDetailsFilters } from '../service'
export { formatSource } from '../source-format'

export function formatInteger(value: number) {
  return new Intl.NumberFormat('en-US').format(value)
}

// Shares a source's whole-percent share. A listed source did put tokens on the board, so a
// bare `Math.round` would print `0%` for a 0.4% contribution and read as a display bug rather
// than a small one — the floor is 1%, matching the leaderboard's source split.
export function formatPercent(value: number, total: number) {
  if (total <= 0) return '0%'
  if (value <= 0) return '0%'
  return `${Math.max(1, Math.round((value / total) * 100))}%`
}

export function csvHref(filters: UsageDetailsFilters) {
  const params = new URLSearchParams({
    source: filters.source,
    startDate: filters.startDate,
    endDate: filters.endDate,
    device: filters.deviceId
  })
  if (filters.modelQuery) {
    params.set('model', filters.modelQuery)
  }
  return `/dashboard/details.csv?${params.toString()}`
}
