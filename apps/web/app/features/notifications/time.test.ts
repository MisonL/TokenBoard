import { describe, expect, test } from 'vitest'
import {
  localDateInTimezone,
  nextScheduledRunAt,
  normalizeScheduleTimes,
  normalizeScheduleWeekdays,
  zonedTimeToUtc
} from './time'

describe('notification time helpers', () => {
  test('reads local date in the configured timezone', () => {
    expect(localDateInTimezone(new Date('2026-04-28T16:30:00.000Z'), 'Asia/Shanghai')).toBe('2026-04-29')
  })

  test('converts local scheduled time to UTC', () => {
    expect(zonedTimeToUtc('2026-04-29', '09:30', 'Asia/Shanghai').toISOString()).toBe('2026-04-29T01:30:00.000Z')
  })

  // A local time inside a spring-forward gap does not exist, so there is no exact instant to
  // return. The iteration used to settle on a time *before* the transition, which reads back as
  // a different wall clock — 02:30 in New York came back as 01:30, an hour early. Shifting the
  // run forward by the gap keeps the requested time's distance from the transition, so 02:30 in
  // a one-hour gap lands at 03:30; that is the conventional handling and keeps the result a real
  // instant in the requested zone.
  test.each([
    ['2026-03-08', '02:30', 'America/New_York', '2026-03-08T07:30:00.000Z', '03:30'],
    ['2026-03-29', '01:30', 'Europe/London', '2026-03-29T01:30:00.000Z', '02:30'],
    ['2026-03-29', '02:30', 'Europe/Berlin', '2026-03-29T01:30:00.000Z', '03:30']
  ])('shifts a %s %s schedule in %s forward by the DST gap', (date, time, timezone, expectedIso, expectedLocalTime) => {
    const utc = zonedTimeToUtc(date, time, timezone)

    expect(utc.toISOString()).toBe(expectedIso)
    // The result must read back as a real wall-clock time in that zone, never one that the
    // clock skipped.
    expect(localWallClock(utc, timezone)).toBe(`${date} ${expectedLocalTime}`)
  })

  test('moves next run to tomorrow after the configured local time has passed', () => {
    expect(
      nextScheduledRunAt({
        now: new Date('2026-04-29T02:00:00.000Z'),
        timezone: 'Asia/Shanghai',
        scheduleTimeLocal: '09:30'
      })
    ).toBe('2026-04-30T01:30:00.000Z')
  })

  test('defaults missing schedule to 18:00 local time', () => {
    expect(
      nextScheduledRunAt({
        now: new Date('2026-04-29T08:00:00.000Z'),
        timezone: 'Asia/Shanghai'
      })
    ).toBe('2026-04-29T10:00:00.000Z')
  })

  test('selects the next same-day local time from multiple schedule slots', () => {
    expect(
      nextScheduledRunAt({
        now: new Date('2026-04-29T02:00:00.000Z'),
        timezone: 'Asia/Shanghai',
        scheduleTimesLocal: ['09:30', '18:00']
      })
    ).toBe('2026-04-29T10:00:00.000Z')
  })

  test('skips to the next selected local weekday', () => {
    expect(
      nextScheduledRunAt({
        now: new Date('2026-04-29T02:00:00.000Z'),
        timezone: 'Asia/Shanghai',
        scheduleTimesLocal: ['09:30'],
        scheduleWeekdays: [5]
      })
    ).toBe('2026-05-01T01:30:00.000Z')
  })

  test('normalizes comma separated schedule settings', () => {
    expect(normalizeScheduleTimes('18:00,09:30\n18:00')).toEqual(['09:30', '18:00'])
    expect(normalizeScheduleWeekdays(['5', '1', '5'])).toEqual([1, 5])
  })

  test('rejects out-of-range schedule weekdays', () => {
    expect(() => normalizeScheduleWeekdays(['1', '7'])).toThrow('Invalid schedule weekday')
  })
})

function localWallClock(date: Date, timezone: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
    .format(date)
    .replace(',', '')
}
