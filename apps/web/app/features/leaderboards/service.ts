import { listDailyLeaderboard, listLeaderboard, type LeaderboardEntry, type LeaderboardQuery } from './queries'
import { leaderboardMetricSchema, leaderboardPeriodSchema } from './schema'
import { usageSummaryStrictMode } from '../usage/deduped-daily-usage'
import { localIsoDate, timezoneOffsetLabel } from '../../lib/time'
import { defaultTimezone } from '../../lib/timezone'
import type { Bindings } from '../../lib/db'

export type LeaderboardOptions = {
  period?: unknown
  metric?: unknown
}

/**
 * A ranked page plus the window it was ranked over.
 *
 * The board spans users, and `daily_usage.usage_date` is stamped by each collector in its own
 * local zone, so two rows labelled `2026-05-01` cover absolute windows 16 hours apart. The
 * ranking still has to choose a boundary; what it must not do is leave the viewer to guess
 * which one it chose. `rangeLabel` and `timezoneLabel` are computed from the same `today` the
 * query is built from, so the caption cannot describe a different window than the one ranked.
 */
export type LeaderboardView = {
  entries: LeaderboardEntry[]
  period: LeaderboardQuery['period']
  metric: LeaderboardQuery['metric']
  /** `2026-05-01` for a daily board, `2026-05` for a monthly one. */
  rangeLabel: string
  timezone: string
  /** `UTC+8`, `UTC-7`, `UTC+5:30` — the offset at this instant, not a fixed one. */
  timezoneLabel: string
}

export async function getDailyLeaderboard(db: D1Database, today = new Date(), timezone = defaultTimezone) {
  return listDailyLeaderboard(db, localIsoDate(today, timezone))
}

export async function getLeaderboard(
  db: D1Database,
  options: LeaderboardOptions = {},
  now = new Date(),
  env: Pick<Bindings, 'TOKENBOARD_USAGE_SUMMARY_STRICT'> = {},
  timezone = defaultTimezone
) {
  const period = leaderboardPeriodSchema.catch('daily').parse(options.period)
  const metric = leaderboardMetricSchema.catch('tokens').parse(options.metric)
  // The board spans users, so it has no single owner timezone; the day boundary follows the
  // *viewer's* zone instead. `daily_usage.usage_date` is stamped by each collector in its own
  // local zone, so a UTC boundary put the whole evening in the Americas on the wrong board and
  // dropped a UTC+ offset's first hours of the month out of "this month" entirely.
  const today = localIsoDate(now, timezone)
  const range =
    period === 'monthly' ? currentMonthRange(today) : { startDate: today, endDateExclusive: addUtcDaysIso(today, 1) }

  const entries = await listLeaderboard(db, {
    period,
    metric,
    startDate: range.startDate,
    endDateExclusive: range.endDateExclusive,
    limit: 50,
    summaryStrict: usageSummaryStrictMode(env)
  })

  return {
    entries,
    period,
    metric,
    rangeLabel: period === 'monthly' ? today.slice(0, 7) : today,
    timezone,
    timezoneLabel: timezoneOffsetLabel(timezone, now)
  } satisfies LeaderboardView
}

// Plain calendar arithmetic on the viewer's local date string, so the month boundaries are the
// ones that date is in.
function currentMonthRange(today: string) {
  const [year, month] = today.split('-').map(Number)
  const startDate = `${today.slice(0, 8)}01`
  const end = new Date(Date.UTC(year, month, 1))
  return {
    startDate,
    endDateExclusive: end.toISOString().slice(0, 10)
  }
}

function addUtcDaysIso(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}
