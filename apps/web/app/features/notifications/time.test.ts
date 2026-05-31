import { describe, expect, test } from 'vitest'
import { localDateInTimezone, nextScheduledRunAt, zonedTimeToUtc } from './time'

describe('notification time helpers', () => {
  test('reads local date in the configured timezone', () => {
    expect(localDateInTimezone(new Date('2026-04-28T16:30:00.000Z'), 'Asia/Shanghai')).toBe('2026-04-29')
  })

  test('converts local scheduled time to UTC', () => {
    expect(zonedTimeToUtc('2026-04-29', '09:30', 'Asia/Shanghai').toISOString()).toBe('2026-04-29T01:30:00.000Z')
  })

  test('moves next run to tomorrow after the configured local time has passed', () => {
    expect(nextScheduledRunAt({
      now: new Date('2026-04-29T02:00:00.000Z'),
      timezone: 'Asia/Shanghai',
      scheduleTimeLocal: '09:30'
    })).toBe('2026-04-30T01:30:00.000Z')
  })
})
