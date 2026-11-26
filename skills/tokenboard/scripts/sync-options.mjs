const DEFAULT_LOOKBACK_DAYS = 7

// Returns { since, auto }. `auto` is true only when `since` is the skill's own
// rolling default (no --since, TOKENBOARD_SINCE or config.since), because that
// is the only value the collector may widen from its delivered watermark.
export function readSince({ flags = {}, env = process.env, config = {}, now = new Date() } = {}) {
  const explicit = flags.since || env.TOKENBOARD_SINCE || config.since
  if (explicit) return { since: explicit, auto: false }
  return {
    since: buildDefaultSince({
      now,
      timezone: config.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      lookbackDays: Number(config.lookbackDays || DEFAULT_LOOKBACK_DAYS)
    }),
    auto: true
  }
}

export function buildDefaultSince({ now, timezone, lookbackDays }) {
  const parts = readTimeZoneDateParts(now, timezone)
  const localDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day))
  localDate.setUTCDate(localDate.getUTCDate() - lookbackDays)
  return formatCompactDate(localDate)
}

function readTimeZoneDateParts(date, timezone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })
  const values = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  )
  return {
    year: Number.parseInt(values.year, 10),
    month: Number.parseInt(values.month, 10),
    day: Number.parseInt(values.day, 10)
  }
}

function formatCompactDate(date) {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${year}${month}${day}`
}
