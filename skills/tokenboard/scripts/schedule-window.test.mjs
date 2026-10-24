import assert from 'node:assert/strict'
import test from 'node:test'
import { isWithinScheduleWindow } from './schedule.mjs'

// The schedule is local wall-clock time, so these timestamps are built locally
// too — a UTC literal would land on a different hour of the day depending on
// the machine running the suite.
function localTime(hour, minute) {
  return new Date(2026, 4, 22, hour, minute, 0, 0).getTime()
}

const half = 30 * 60_000

test('reports a time inside the window on either side of a scheduled run', () => {
  const window = { times: ['09:00'], windowMs: half }
  assert.equal(isWithinScheduleWindow({ ...window, now: localTime(9, 0) }), true)
  assert.equal(isWithinScheduleWindow({ ...window, now: localTime(9, 30) }), true)
  assert.equal(isWithinScheduleWindow({ ...window, now: localTime(8, 30) }), true)
  assert.equal(isWithinScheduleWindow({ ...window, now: localTime(8, 29) }), false)
  assert.equal(isWithinScheduleWindow({ ...window, now: localTime(9, 31) }), false)
})

test('wraps the window across midnight', () => {
  const window = { times: ['00:00'], windowMs: half }
  assert.equal(isWithinScheduleWindow({ ...window, now: localTime(23, 45) }), true)
  assert.equal(isWithinScheduleWindow({ ...window, now: localTime(0, 15) }), true)
  assert.equal(isWithinScheduleWindow({ ...window, now: localTime(23, 0) }), false)
})

test('checks every configured time', () => {
  const window = { times: ['09:00', '12:00', '18:00', '23:00'], windowMs: half }
  assert.equal(isWithinScheduleWindow({ ...window, now: localTime(12, 10) }), true)
  assert.equal(isWithinScheduleWindow({ ...window, now: localTime(15, 0) }), false)
})

test('treats an absent or unusable window as never matching', () => {
  assert.equal(isWithinScheduleWindow({ now: localTime(9, 0) }), false)
  assert.equal(isWithinScheduleWindow({ times: [], windowMs: half, now: localTime(9, 0) }), false)
  assert.equal(isWithinScheduleWindow({ times: ['09:00'], windowMs: 0, now: localTime(9, 0) }), false)
  assert.equal(isWithinScheduleWindow({ times: ['not-a-time'], windowMs: half, now: localTime(9, 0) }), false)
})
