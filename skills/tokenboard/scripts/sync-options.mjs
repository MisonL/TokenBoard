const DEFAULT_LOOKBACK_DAYS = 7

export function readSince({ flags = {}, env = process.env, config = {}, now = new Date() } = {}) {
  return (
    flags.since ||
    env.TOKENBOARD_SINCE ||
    config.since ||
    buildDefaultSince({
      now,
      timezone: config.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      lookbackDays: Number(config.lookbackDays || DEFAULT_LOOKBACK_DAYS)
    })
  )
}

export function buildDefaultSince({ now, timezone, lookbackDays }) {
  const localNow = new Date(now.toLocaleString('en-US', { timeZone: timezone }))
  localNow.setDate(localNow.getDate() - lookbackDays)
  const year = localNow.getFullYear()
  const month = String(localNow.getMonth() + 1).padStart(2, '0')
  const day = String(localNow.getDate()).padStart(2, '0')
  return `${year}${month}${day}`
}
