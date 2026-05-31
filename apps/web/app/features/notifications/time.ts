export function localDateInTimezone(date: Date, timezone: string) {
  const parts = localDateTimeParts(date, timezone)
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`
}

export function nextScheduledRunAt(input: {
  now: Date
  timezone: string
  scheduleTimeLocal: string
}) {
  const localDate = localDateInTimezone(input.now, input.timezone)
  let candidate = zonedTimeToUtc(localDate, input.scheduleTimeLocal, input.timezone)

  if (candidate <= input.now) {
    candidate = zonedTimeToUtc(addIsoDays(localDate, 1), input.scheduleTimeLocal, input.timezone)
  }

  return candidate.toISOString()
}

export function zonedTimeToUtc(localDate: string, time: string, timezone: string) {
  const [year, month, day] = localDate.split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)
  const targetLocalAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0)
  let utc = targetLocalAsUtc

  for (let index = 0; index < 3; index += 1) {
    const parts = localDateTimeParts(new Date(utc), timezone)
    const currentLocalAsUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    )
    utc += targetLocalAsUtc - currentLocalAsUtc
  }

  return new Date(utc)
}

export function addIsoDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

function localDateTimeParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date)

  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value)
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second')
  }
}

function pad2(value: number) {
  return String(value).padStart(2, '0')
}
