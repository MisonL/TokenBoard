import type { UsageDetailsFilters } from '../service'
export { formatSource } from '../source-format'

export function formatInteger(value: number) {
  return new Intl.NumberFormat('en-US').format(value)
}

export function formatPercent(value: number, total: number) {
  if (total <= 0) return '0%'
  return `${Math.round((value / total) * 100)}%`
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
