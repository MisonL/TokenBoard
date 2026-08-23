export function assertValidTimeZone(value: unknown, field = 'timezone') {
  if (typeof value !== 'string') throw new Error(`Invalid ${field}`)

  const timezone = value.trim()
  if (!timezone) throw new Error(`Invalid ${field}`)

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
    return timezone
  } catch {
    throw new Error(`Invalid ${field}`)
  }
}
