export function assertValidTimeZone(value: unknown, field = 'timezone') {
  if (typeof value !== 'string') throw new Error(`Invalid ${field}`)

  const timezone = value.trim()
  if (!timezone) throw new Error(`Invalid ${field}`)

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
    return timezone
  } catch {
    // A trimmed Node build without full ICU rejects every zone, so the same message covers
    // both a genuinely mistyped zone and a runtime the user cannot fix from here.
    throw new Error(
      `Invalid ${field}: ${timezone}. If the zone is spelled correctly, this Node.js build may lack ICU timezone data; set TOKENBOARD_TIMEZONE explicitly or use a full-icu Node build`
    )
  }
}
