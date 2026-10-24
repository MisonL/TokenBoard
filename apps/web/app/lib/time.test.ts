import { describe, expect, test } from 'vitest'
import { localClockTime, localIsoDate, timezoneOffsetLabel } from './time'

describe('local calendar helpers', () => {
  test('reads the local date across the day boundary', () => {
    const instant = new Date('2026-04-30T18:00:00.000Z')
    expect(localIsoDate(instant, 'Asia/Shanghai')).toBe('2026-05-01')
    expect(localIsoDate(instant, 'America/Los_Angeles')).toBe('2026-04-30')
  })

  test('reads the local clock in 24-hour form', () => {
    expect(localClockTime(new Date('2026-04-30T18:05:00.000Z'), 'Asia/Shanghai')).toBe('02:05')
  })
})

describe('timezoneOffsetLabel', () => {
  // A user who sets a timezone by hand reads a name they recognise; a viewer comparing two
  // people's boards needs the numeric offset, because the names do not say how far apart the
  // two days are. The label carries both so neither has to guess.
  test('labels a whole-hour offset', () => {
    expect(timezoneOffsetLabel('Asia/Shanghai', new Date('2026-09-25T12:00:00.000Z'))).toBe('UTC+8')
  })

  test('labels a half-hour and a quarter-hour offset', () => {
    expect(timezoneOffsetLabel('Asia/Kolkata', new Date('2026-09-25T12:00:00.000Z'))).toBe('UTC+5:30')
    expect(timezoneOffsetLabel('Pacific/Chatham', new Date('2026-09-25T12:00:00.000Z'))).toBe('UTC+12:45')
  })

  test('labels a negative offset and UTC itself', () => {
    expect(timezoneOffsetLabel('America/Los_Angeles', new Date('2026-09-25T12:00:00.000Z'))).toBe('UTC-7')
    expect(timezoneOffsetLabel('UTC', new Date('2026-09-25T12:00:00.000Z'))).toBe('UTC+0')
  })

  // The offset is a property of the instant, not of the zone: the same zone reads +8 in
  // January and +9 in July. A label computed once and cached would be wrong for half the year.
  test('follows daylight saving at the instant it is asked about', () => {
    expect(timezoneOffsetLabel('America/Los_Angeles', new Date('2026-01-15T12:00:00.000Z'))).toBe('UTC-8')
    expect(timezoneOffsetLabel('America/Los_Angeles', new Date('2026-07-15T12:00:00.000Z'))).toBe('UTC-7')
  })
})
