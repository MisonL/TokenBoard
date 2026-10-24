import assert from 'node:assert/strict'
import test from 'node:test'
import { coordinatedSync } from './coordinator.mjs'
import { fakeProcess, memoryRuntime } from './coordinator-test-helpers.mjs'
import { readNotifyScheduleWindow } from './notify.mjs'

test('the schedule window comes from the config only when the config has one', () => {
  assert.deepEqual(readNotifyScheduleWindow(undefined, {}, ['09:00', '12:00']), {
    times: ['09:00', '12:00'],
    windowMs: 30 * 60_000
  })
  assert.equal(readNotifyScheduleWindow(undefined, {}, undefined), undefined, 'no schedule must disable the window')
  assert.deepEqual(readNotifyScheduleWindow(undefined, { TOKENBOARD_SCHEDULE_TIMES: '09:00,18:00' }, ['23:00']).times, [
    '09:00',
    '18:00'
  ])
})

// The schedule is local wall-clock time, so the test has to build local
// timestamps too — a UTC literal would land on a different hour of the day
// depending on the machine running the suite.
function localTime(hour, minute) {
  const date = new Date(2026, 4, 22, hour, minute, 0, 0)
  return date.getTime()
}

// A hook trigger that lands within half an hour of a scheduled sync must not start
// a second full scan: the scheduled run a few minutes away will collect the same
// usage, and each ccusage scan costs 4.6-7.6 GB of resident memory. Skipping the
// hook leaves the queued signal in place, so the scheduled run still picks the
// source up — nothing is dropped, only the duplicate scan is avoided.
test('coordinator skips a trigger that lands inside the scheduled-sync window', () => {
  const fs = memoryRuntime()
  let runs = 0
  const result = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      now: () => localTime(9, 5),
      process: fakeProcess(501),
      scheduleWindow: { times: ['09:00', '12:00', '18:00', '23:00'], windowMs: 30 * 60_000 },
      executeSync: () => {
        runs += 1
        return {}
      }
    }
  )

  assert.equal(runs, 0, 'a trigger near a scheduled run must not start a scan')
  assert.equal(result.skippedReason, 'scheduled-window')
  assert.equal(result.error, undefined, 'a skip is not a failure')
})

// The window has to hold on both sides: a trigger just before the scheduled run
// would otherwise scan the same tree minutes before that run does.
test('coordinator skips a trigger just before a scheduled run', () => {
  const fs = memoryRuntime()
  let runs = 0
  const result = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      now: () => localTime(8, 45),
      process: fakeProcess(502),
      scheduleWindow: { times: ['09:00'], windowMs: 30 * 60_000 },
      executeSync: () => {
        runs += 1
        return {}
      }
    }
  )

  assert.equal(runs, 0)
  assert.equal(result.skippedReason, 'scheduled-window')
})

test('coordinator runs a trigger that falls outside the scheduled-sync window', () => {
  const fs = memoryRuntime()
  let runs = 0
  const result = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      now: () => localTime(7, 0),
      process: fakeProcess(503),
      scheduleWindow: { times: ['09:00', '12:00'], windowMs: 30 * 60_000 },
      executeSync: () => {
        runs += 1
        return {}
      }
    }
  )

  assert.equal(runs, 1, 'a trigger far from every scheduled run must still sync')
  assert.equal(result.skippedReason, undefined)
})

// Without a configured window the coordinator behaves exactly as before: the
// schedule is an optional input, not a requirement.
test('coordinator syncs when no schedule window is configured', () => {
  const fs = memoryRuntime()
  let runs = 0
  coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      now: () => localTime(9, 5),
      process: fakeProcess(504),
      executeSync: () => {
        runs += 1
        return {}
      }
    }
  )

  assert.equal(runs, 1)
})
