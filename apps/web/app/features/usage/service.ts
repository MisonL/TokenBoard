import {
  getDailyUsageTrend,
  getUsageSummary,
  type DailyUsageTrendItem,
  type UsageDetails,
  type UsageSummary
} from './queries'
import { toIsoDate } from '../../lib/time'
import { localIsoDate } from '../../lib/time'
import { findMismatchedUsageTimezones, listActiveUsageTimezones } from './queries/usage-timezone-scope'
import { defaultTimezone } from '../../lib/timezone'
import { usageSourceSchema } from './schema'
import { normalizeDeviceFilter, usageSummaryStrictMode } from './deduped-daily-usage'
import type { Bindings } from '../../lib/db'
import { isCostUnavailableSource, isValidIsoDate, type UsageSource } from '@tokenboard/usage-core'

export type DashboardSummary = UsageSummary & {
  dailyTrend: DailyUsageTrendItem[]
  /**
   * Collector zones that disagree with the profile zone, or `[]` when they agree.
   *
   * The dashboard attributes "today" by the profile zone while each collector stamps
   * `usage_date` in its own — frozen into the collector's config at install time, with nothing
   * propagating a later profile change back to it. After a user moves and edits the setting the
   * two calendars diverge and today's figure silently reads zero while the month still counts
   * the rows. Reporting the disagreement is what turns that into something the user can act on.
   */
  mismatchedUsageTimezones: string[]
}

export async function getDashboardSummary(
  db: D1Database,
  userId: string,
  now = new Date(),
  env: Pick<Bindings, 'TOKENBOARD_USAGE_SUMMARY_STRICT'> = {},
  timezone = defaultTimezone
) {
  // "Today" is the user's local day, not the UTC one. `daily_usage.usage_date` is written by the
  // collector in the user's own timezone, so comparing it against a UTC date makes the dashboard
  // report the previous day for the whole evening in the Americas and label the wrong day for
  // the first hours of every UTC+ offset. The public card already reads its date this way, so
  // the two surfaces disagreed about the same user at the same moment.
  const today = localIsoDate(now, timezone)
  const monthStart = `${today.slice(0, 8)}01`
  // Plain calendar arithmetic on the date string. Re-entering the timezone here would shift the
  // day again: the anchor is UTC midnight, which is the previous evening further west.
  const trendStart = toIsoDate(addUtcDays(new Date(`${today}T00:00:00.000Z`), -29))
  const summaryStrict = usageSummaryStrictMode(env)
  const [summary, dailyTrend, usageTimezones] = await Promise.all([
    getUsageSummary(db, { userId, today, monthStart, summaryStrict }),
    getDailyUsageTrend(db, { userId, startDate: trendStart, endDate: today, summaryStrict }),
    listActiveUsageTimezones(db, userId)
  ])
  return {
    ...summary,
    dailyTrend,
    mismatchedUsageTimezones: findMismatchedUsageTimezones(timezone, usageTimezones)
  } satisfies DashboardSummary
}

export type UsageDetailsFilters = {
  source: 'all' | UsageSource
  startDate: string
  endDate: string
  deviceId: string
  modelQuery: string
}

export function parseUsageDetailsFilters(
  query: Record<string, string | undefined>,
  now = new Date(),
  timezone = defaultTimezone
): UsageDetailsFilters {
  // The default window follows the same local day the dashboard uses, so an export taken
  // without explicit dates covers exactly what the page shows.
  const today = localIsoDate(now, timezone)
  const defaultStart = toIsoDate(addUtcDays(new Date(`${today}T00:00:00.000Z`), -29))
  const parsedSource = usageSourceSchema.safeParse(query.source)
  const source = query.source === 'all' || !parsedSource.success ? 'all' : parsedSource.data
  const startDate = readIsoDate(query.startDate, defaultStart)
  const endDate = readIsoDate(query.endDate, today)
  const deviceId = normalizeDeviceFilter(query.device)
  const modelQuery = String(query.model ?? '').trim()

  // Both endpoints are caller-supplied and both are accepted as long as they look like a
  // date, so the span between them was unbounded. `getUsageDetails` then pre-creates a row
  // for every day in the range, which makes the request's memory proportional to the span
  // rather than to the data: `startDate=0000-01-01&endDate=9999-12-31` enumerates 3.6M days
  // and is enough to take the isolate down on its own. Clamping to the maximum span the
  // dashboard can actually display keeps the work proportional to the data.
  const [from, to] = startDate > endDate ? [endDate, startDate] : [startDate, endDate]
  const clampedFrom = spanExceedsLimit(from, to)
    ? toIsoDate(addUtcDays(new Date(`${to}T00:00:00.000Z`), -(maxUsageDetailsSpanDays - 1)))
    : from

  return {
    source,
    startDate: clampedFrom,
    endDate: to,
    deviceId,
    modelQuery
  }
}

// A year plus a day, so a full leap year and every preset the dashboard offers fit without
// being clamped. The point is only to bound the work, not to express a product rule.
export const maxUsageDetailsSpanDays = 366

function spanExceedsLimit(startDate: string, endDate: string) {
  const start = Date.parse(`${startDate}T00:00:00.000Z`)
  const end = Date.parse(`${endDate}T00:00:00.000Z`)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false
  return (end - start) / 86_400_000 + 1 > maxUsageDetailsSpanDays
}

export function usageDetailsToCsv(details: UsageDetails) {
  const header = [
    'date',
    'source',
    'model',
    'input_tokens',
    'output_tokens',
    'cache_creation_tokens',
    'cache_read_tokens',
    'cache_read_rate',
    'total_tokens_without_cache_read',
    'total_tokens',
    'cost_usd',
    'cost_available',
    'session_count'
  ]

  const rows = details.modelRows.map((row) => {
    const costAvailable = !isCostUnavailableSource(row.source)
    return [
      row.usageDate,
      row.source,
      row.model,
      row.inputTokens,
      row.outputTokens,
      row.cacheCreationTokens,
      row.cacheReadTokens,
      row.cacheReadRate,
      row.totalTokensWithoutCacheRead,
      row.totalTokens,
      costAvailable ? row.costUsd : '',
      costAvailable,
      row.sessionCount
    ]
  })

  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n')
}

function addUtcDays(date: Date, days: number) {
  const next = new Date(date)
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

function readIsoDate(value: string | undefined, fallback: string) {
  // A shape-only check let through dates that are not real (`0000-00-00`) as well as real
  // ones far outside any displayable range. `isValidIsoDate` already exists for this and
  // rejects both, so the caller falls back to the default range instead of enumerating it.
  return value && isValidIsoDate(value) ? value : fallback
}

// A spreadsheet evaluates a cell that starts with `=`, `+`, `-` or `@` as a formula when the
// file is opened, so an exported model name is a code-injection vector. CSV quoting does not
// help: the quoting below is a transport-level escape, and the spreadsheet strips it before
// deciding whether the cell is a formula. A leading apostrophe is what makes the cell literal
// — the spreadsheet consumes it and shows the original text.
function csvCell(value: string | number | boolean) {
  const text = csvFormulaGuard(String(value))
  if (/[",\n\r]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`
  }
  return text
}

function csvFormulaGuard(text: string) {
  // `\t` and `\r` lead the same way: the spreadsheet trims leading whitespace before it
  // decides, so a cell that opens with a tab is still a formula.
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
}
