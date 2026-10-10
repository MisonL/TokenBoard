import { roundUsd } from '@tokenboard/usage-core'

export function eachIsoDate(startDate: string, endDate: string) {
  const dates: string[] = []
  const current = new Date(`${startDate}T00:00:00.000Z`)
  const end = new Date(`${endDate}T00:00:00.000Z`)

  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10))
    current.setUTCDate(current.getUTCDate() + 1)
  }

  return dates
}

// The four-decimal rounding every metric on the page goes through, re-exported from
// `usage-core` so the web and the collector share one definition and round a stored value the
// same way once the collector adopts it.
export const roundMetric = roundUsd

export function summaryRangeBindings(
  summaryStrict: boolean | undefined,
  userId: string,
  startDate: string,
  endDate: string
) {
  return summaryStrict ? [userId, startDate, endDate] : [userId, startDate, endDate, userId, startDate, endDate]
}
