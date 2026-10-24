export function isValidIsoDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(0)
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCFullYear(year, month - 1, day)

  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

export function assertIsoDate(value: string) {
  if (!isValidIsoDate(value)) {
    throw new Error(`Invalid ISO date: ${value}`)
  }
}

/**
 * The latest calendar date an upload may carry, given the server's clock.
 *
 * A usage date is a day a collector observed locally, so the newest legitimate one is the
 * server's current UTC date plus one day of headroom for the UTC+14 zones — a collector there
 * is already on tomorrow while the server is still on today. Anything later is not a day that
 * has happened yet, and accepting it would let a clock-skewed or hostile client write rows no
 * dashboard, leaderboard, or report window will ever display, removable only by hand in D1.
 *
 * Returns a `YYYY-MM-DD` string so callers can compare lexically against a validated date.
 */
export function maxUploadIsoDate(now = new Date()) {
  const ceiling = new Date(now.getTime() + 24 * 60 * 60 * 1000)
  return ceiling.toISOString().slice(0, 10)
}

/**
 * The earliest calendar date an upload may carry.
 *
 * The symmetric guard to {@link maxUploadIsoDate}: a date far in the past is as unreachable
 * for every dashboard, leaderboard, and report window as one in the future, and equally
 * removable only by hand in D1. The floor is a conservative constant rather than a function
 * of the clock — AI coding tools did not exist before 2023, and a fixed bound keeps a
 * legitimate historical backfill (`--since all`) working regardless of when it runs.
 */
export const minUploadIsoDate = '2023-01-01'

export type UploadIsoDateIssue = 'invalid' | 'too-far-future' | 'before-history-window'

/**
 * Classifies why an upload date falls outside the accepted window, or `null` when the date
 * is acceptable. Callers that only need a boolean use {@link isValidUploadIsoDate}; the
 * classification exists so a caller can tell "not yet" from "too old" without re-deriving
 * the bounds and risking drift from the constants here.
 */
export function uploadIsoDateIssue(value: string, now = new Date()): UploadIsoDateIssue | null {
  if (!isValidIsoDate(value)) return 'invalid'
  if (value > maxUploadIsoDate(now)) return 'too-far-future'
  if (value < minUploadIsoDate) return 'before-history-window'
  return null
}

/** True when `value` is a real calendar date within the accepted upload window. */
export function isValidUploadIsoDate(value: string, now = new Date()) {
  return uploadIsoDateIssue(value, now) === null
}
