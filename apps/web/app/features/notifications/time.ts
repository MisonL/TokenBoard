import { localClockTime, localDateTimeParts, localIsoDate } from '../../lib/time'

export const defaultWebhookScheduleTime = '18:00'
export const defaultWebhookScheduleWeekdays = [0, 1, 2, 3, 4, 5, 6]

const scheduleTimePattern = /^([01]\d|2[0-3]):[0-5]\d$/

// The date/time primitives live in `lib/time` because the dashboard, the leaderboard and the
// public card all attribute dates by the user's zone, not just this feature. These names are
// kept as the scheduling-facing aliases so the rest of this module reads the same as before.
export const localDateInTimezone = localIsoDate
export const localTimeInTimezone = localClockTime

export function nextScheduledRunAt(input: {
  now: Date
  timezone: string
  scheduleTimeLocal?: string
  scheduleTimesLocal?: string[]
  scheduleWeekdays?: number[]
}) {
  const localDate = localDateInTimezone(input.now, input.timezone)
  const scheduleTimes = normalizeScheduleTimes(input.scheduleTimesLocal ?? input.scheduleTimeLocal)
  const scheduleWeekdays = normalizeScheduleWeekdays(input.scheduleWeekdays)

  for (let dayOffset = 0; dayOffset <= 7; dayOffset += 1) {
    const candidateDate = addIsoDays(localDate, dayOffset)
    if (!scheduleWeekdays.includes(localWeekday(candidateDate))) continue
    for (const scheduleTime of scheduleTimes) {
      const candidate = zonedTimeToUtc(candidateDate, scheduleTime, input.timezone)
      if (candidate > input.now) return candidate.toISOString()
    }
  }

  return zonedTimeToUtc(addIsoDays(localDate, 8), scheduleTimes[0], input.timezone).toISOString()
}

export function normalizeScheduleTimes(input: unknown): string[] {
  const values = flattenScheduleValues(input)
  const candidates = values.length > 0 ? values : [defaultWebhookScheduleTime]
  const normalized = [...new Set(candidates.map((value) => value.trim()).filter(Boolean))]

  if (normalized.length < 1 || normalized.some((value) => !scheduleTimePattern.test(value))) {
    throw new Error('Invalid schedule time')
  }

  return normalized.sort()
}

export function normalizeScheduleWeekdays(input: unknown): number[] {
  const values = flattenScheduleValues(input)
  const candidates = values.length > 0 ? values : defaultWebhookScheduleWeekdays.map(String)
  const normalized = [...new Set(candidates.map(parseWeekday))]

  if (normalized.length < 1 || normalized.some((value) => !Number.isInteger(value) || value < 0 || value > 6)) {
    throw new Error('Invalid schedule weekday')
  }

  return normalized.sort((left, right) => left - right)
}

export function zonedTimeToUtc(localDate: string, time: string, timezone: string) {
  const [year, month, day] = localDate.split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)
  const targetLocalAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0)
  let utc = targetLocalAsUtc

  for (let index = 0; index < 3; index += 1) {
    const parts = localDateTimeParts(new Date(utc), timezone)
    const currentLocalAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
    utc += targetLocalAsUtc - currentLocalAsUtc
  }

  // The iteration converges for every local time that exists. It cannot for one inside a
  // spring-forward gap — 02:30 in a zone that jumps 02:00 to 03:00 is not a real instant — and
  // the loop then settles on a time before the transition, which is the *wrong* instant and
  // reads back as a different wall clock. Such a schedule has no exact answer, so the run is
  // placed at the start of the gap instead: that is the first instant on or after the requested
  // wall-clock time, it is what a scheduler is expected to do with a skipped slot, and it keeps
  // the result a real instant rather than a silently shifted one.
  const settled = localDateTimeParts(new Date(utc), timezone)
  const settledLocalAsUtc = Date.UTC(
    settled.year,
    settled.month - 1,
    settled.day,
    settled.hour,
    settled.minute,
    settled.second
  )
  if (settledLocalAsUtc < targetLocalAsUtc) {
    return new Date(utc + (targetLocalAsUtc - settledLocalAsUtc))
  }

  return new Date(utc)
}

export function addIsoDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

function flattenScheduleValues(input: unknown): string[] {
  if (Array.isArray(input)) return input.flatMap(flattenScheduleValues)
  if (input === null || input === undefined) return []
  return String(input)
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean)
}

function localWeekday(localDate: string) {
  return new Date(`${localDate}T00:00:00.000Z`).getUTCDay()
}

function parseWeekday(value: string) {
  if (!/^[0-6]$/.test(value)) return Number.NaN
  return Number(value)
}
