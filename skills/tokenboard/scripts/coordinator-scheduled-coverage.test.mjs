import assert from 'node:assert/strict'
import test from 'node:test'
import { coordinatedSync } from './coordinator.mjs'
import { fakeProcess, memoryRuntime } from './coordinator-test-helpers.mjs'
import { writeScheduledSyncState } from './scheduled-sync-state.mjs'

// C4: a hook signal suppressed inside the scheduled-run window is covered by the scheduled
// run — but only when that run actually finished, for this source, after the signal was
// requested. "A scheduled run exists" is not enough (the 2026-11-25 plan's prerequisite):
// a retry delayed only by wall-clock arithmetic would land after this window and still be
// wrong. The state file, not the scheduled task's exit code, is the evidence: that task
// records success even when the upload was paused.

const scheduleWindow = { times: ['09:00', '12:00', '18:00', '23:00'], windowMs: 30 * 60_000 }

function localTime(hour, minute, second = 0) {
  return new Date(2026, 10, 27, hour, minute, second, 0).getTime()
}

function atLocal(hour, minute, second = 0) {
  return new Date(localTime(hour, minute, second)).toISOString()
}

// The source timestamps below are written by `writeScheduledSyncState`, which stores UTC;
// build them from the same local wall clock the coordinator window uses.
function utcForLocal(hour, minute, second = 0) {
  return atLocal(hour, minute, second)
}

function stateFsWith(fs, overrides) {
  const withState = { ...fs, chmod: () => {}, lstat: () => null }
  writeScheduledSyncState(
    {
      stateDir: '/state',
      source: 'all',
      status: 'success',
      // Coverage requires the run to have started after the 12:05 request.
      startedAt: utcForLocal(12, 6),
      updatedAt: utcForLocal(12, 19),
      completedAt: utcForLocal(12, 19),
      ...overrides
    },
    withState
  )
  return fs
}

// A queue entry carrying the request time, as `appendSignal` writes it.
function queueSignal(fs, source, requestedAt) {
  fs.writeFile(`/state/notify.signal.d/${source}.json`, `${JSON.stringify({ source, requestedAt })}\n`)
}

function runAt(fs, { now, trailing = [], executeSync, source = 'codex' }) {
  return coordinatedSync(
    { kind: 'notify', source },
    {
      ...fs,
      stateDir: '/state',
      now: () => now,
      process: fakeProcess(901),
      scheduleWindow,
      scheduleTrailing: (trigger, delayMs) => {
        trailing.push({ trigger, delayMs })
        return true
      },
      executeSync: executeSync || (() => ({}))
    }
  )
}

test('a signal the scheduled run has not covered yet gets a trailing retry with a deadline', () => {
  const fs = memoryRuntime()
  queueSignal(fs, 'codex', utcForLocal(12, 5))
  const trailing = []

  const result = runAt(fs, { now: localTime(12, 5), trailing })

  assert.equal(result.skippedReason, 'scheduled-window')
  assert.equal(result.trailingScheduled, true)
  assert.deepEqual(result.trailingSources, ['codex'])
  // Deadline-based: the retry wakes when the window it was suppressed in closes
  // (12:05 inside the 12:00 window → 12:30), not at the next scheduled slot hours later
  // and not at a fixed delay that would land inside the same window.
  assert.equal(trailing.length, 1)
  assert.deepEqual(trailing[0].trigger, { kind: 'notify', source: 'codex' })
  assert.equal(trailing[0].delayMs, 25 * 60_000)
})

test('a trigger on the early side of the window wakes when that window closes', () => {
  // 08:45 sits in the symmetric window of the 09:00 run (T-30..T+30); the retry must wait
  // until 09:30, not treat the window as starting at 09:00 and not skip the retry.
  const fs = memoryRuntime()
  queueSignal(fs, 'codex', utcForLocal(8, 45))
  const trailing = []

  const result = runAt(fs, { now: localTime(8, 45), trailing })

  assert.equal(result.skippedReason, 'scheduled-window')
  assert.equal(trailing.length, 1)
  assert.equal(trailing[0].delayMs, 45 * 60_000)
})

test('a trigger before midnight near the 00:00 window wakes after midnight', () => {
  const fs = memoryRuntime()
  queueSignal(fs, 'codex', new Date(2026, 10, 27, 23, 50).toISOString())
  const trailing = []
  const options = { now: new Date(2026, 10, 27, 23, 50).getTime(), trailing }
  const result = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      now: () => options.now,
      process: fakeProcess(902),
      scheduleWindow: { times: ['00:00', '12:00'], windowMs: 30 * 60_000 },
      scheduleTrailing: (trigger, delayMs) => {
        trailing.push({ trigger, delayMs })
        return true
      },
      executeSync: () => ({})
    }
  )

  assert.equal(result.skippedReason, 'scheduled-window')
  assert.equal(trailing.length, 1)
  assert.equal(trailing[0].delayMs, 40 * 60_000)
})

// Hourly runs with a 30-minute window leave no gap: merged spans cover the whole day, so
// a trailing retry would wake into the next window and re-arm forever without scanning.
// No retry is booked; the next external trigger re-evaluates.
test('a configuration whose windows merge across the whole day books no trailing retry', () => {
  const fs = memoryRuntime()
  queueSignal(fs, 'codex', utcForLocal(12, 5))
  const trailing = []
  const hourly = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, '0')}:00`)

  const result = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      now: () => localTime(12, 5),
      process: fakeProcess(903),
      scheduleWindow: { times: hourly, windowMs: 30 * 60_000 },
      scheduleTrailing: (trigger, delayMs) => {
        trailing.push({ trigger, delayMs })
        return true
      },
      executeSync: () => ({})
    }
  )

  assert.equal(result.skippedReason, 'scheduled-window')
  assert.deepEqual(trailing, [])
  assert.notEqual(result.trailingScheduled, true)
})

test('a window skip books a trailing retry only for sources the scheduled run missed', () => {
  // codex was queued yesterday and its scheduled run finished after that request (23:59
  // local yesterday): covered, so it must not come back as a trailing retry. claude-code
  // was queued five minutes ago and nothing has covered it yet.
  const yesterday = new Date(2026, 10, 26, 23, 59).toISOString()
  const fs = stateFsWith(memoryRuntime(), {
    source: 'codex',
    startedAt: new Date(2026, 10, 26, 23, 40).toISOString(),
    completedAt: yesterday,
    updatedAt: yesterday
  })
  queueSignal(fs, 'codex', new Date(2026, 10, 26, 23, 30).toISOString())
  queueSignal(fs, 'claude-code', utcForLocal(12, 0))
  const trailing = []

  // claude-code is the trigger: it is not covered, so it stays; codex is covered and must not.
  const result = runAt(fs, { now: localTime(12, 5), trailing, source: 'claude-code' })

  assert.equal(result.skippedReason, 'scheduled-window')
  assert.deepEqual(result.trailingSources, ['claude-code'])
  assert.deepEqual(
    trailing.map(({ trigger }) => trigger.source),
    ['claude-code']
  )
})

test('a trailing worker waking after an uncovered window runs the source instead of skipping again', () => {
  const fs = memoryRuntime()
  queueSignal(fs, 'codex', utcForLocal(12, 5))
  const ran = []

  // 12:31 is outside the window; no scheduled state exists, so nothing is covered.
  const result = runAt(fs, { now: localTime(12, 31), executeSync: (trigger) => ran.push(trigger.source) })

  assert.deepEqual(ran, ['codex'])
  assert.equal(result.skippedSync, false)
})

test('a signal already covered by a finished scheduled run is not re-scanned', () => {
  const fs = stateFsWith(memoryRuntime(), {})
  queueSignal(fs, 'codex', utcForLocal(12, 5))
  const ran = []

  const result = runAt(fs, { now: localTime(12, 31), executeSync: (trigger) => ran.push(trigger.source) })

  assert.deepEqual(ran, [], 'the scheduled run already collected this signal')
  assert.equal(result.skippedSync, true)
  assert.equal(result.skippedReason, 'scheduled-covered')
  assert.notEqual(result.trailingScheduled, true)
})

test('a signal the scheduled run has not covered yet is re-scanned after the window', () => {
  // The scheduled run holds a state file for another source only: it says nothing about
  // codex, so the hook run is still the one that must collect it.
  const fs = memoryRuntime()
  const withState = { ...fs, chmod: () => {}, lstat: () => null }
  writeScheduledSyncState(
    {
      stateDir: '/state',
      source: 'claude-code',
      status: 'success',
      updatedAt: utcForLocal(12, 19),
      completedAt: utcForLocal(12, 19)
    },
    withState
  )
  queueSignal(fs, 'codex', utcForLocal(12, 5))
  const ran = []

  runAt(fs, { now: localTime(12, 31), executeSync: (trigger) => ran.push(trigger.source) })

  assert.deepEqual(ran, ['codex'])
})

// The scheduled task records `success` even when the upload was paused, and a failed or
// deferred run may never have reached the source. None of those are coverage.
test('a scheduled run that failed or deferred does not cover the signal', () => {
  for (const status of ['failed', 'deferred']) {
    const fs = stateFsWith(memoryRuntime(), { status })
    queueSignal(fs, 'codex', utcForLocal(12, 5))
    const ran = []

    runAt(fs, { now: localTime(12, 31), executeSync: (trigger) => ran.push(trigger.source) })

    assert.deepEqual(ran, ['codex'], `a ${status} scheduled run must not cover the signal`)
  }
})

test('a scheduled run that finished before the signal does not cover it', () => {
  const fs = stateFsWith(memoryRuntime(), {
    completedAt: utcForLocal(12, 2),
    updatedAt: utcForLocal(12, 2),
    startedAt: utcForLocal(11, 58)
  })
  queueSignal(fs, 'codex', utcForLocal(12, 5))
  const ran = []

  runAt(fs, { now: localTime(12, 31), executeSync: (trigger) => ran.push(trigger.source) })

  assert.deepEqual(ran, ['codex'])
})

// During the window the scheduled run is still in flight: not covered, so the retry is
// booked — and once it fires after a successful run, the state file stops it there.
// A queue entry without a request time cannot be ordered against the run, so even a run
// that would otherwise cover it must not: treating the missing time as "the epoch" would.
test('a signal queued without a request time is treated as uncovered despite a covering run', () => {
  const fs = stateFsWith(memoryRuntime(), {})
  fs.writeFile('/state/notify.signal.d/codex.json', 'codex\n')
  const ran = []

  runAt(fs, { now: localTime(12, 31), executeSync: (trigger) => ran.push(trigger.source) })

  assert.deepEqual(ran, ['codex'])
})

// The retry is booked for the window's close; waking exactly there must scan, not land on
// the window again (a closed upper edge did exactly that and the source was never scanned).
test('a trailing retry waking exactly at the window close scans the source', () => {
  const fs = memoryRuntime()
  queueSignal(fs, 'codex', utcForLocal(12, 5))
  const ran = []

  const result = runAt(fs, { now: localTime(12, 30), executeSync: (trigger) => ran.push(trigger.source) })

  assert.deepEqual(ran, ['codex'])
  assert.notEqual(result.skippedReason, 'scheduled-window')
})

// Outside the window the gate still drops a covered source, and the run's own drain must
// not resurrect it: the covered queue entry is removed with the decision.
test('a covered source is not revived by the drain of the same run', () => {
  // The all-source run started at 12:06: codex's 12:05 request predates it (covered), while
  // claude-code's 12:20 request arrived while it was running (not covered).
  const fs = stateFsWith(memoryRuntime(), {})
  queueSignal(fs, 'codex', utcForLocal(12, 5))
  queueSignal(fs, 'claude-code', utcForLocal(12, 20))
  const ran = []

  runAt(fs, {
    now: localTime(12, 31),
    source: 'claude-code',
    executeSync: (trigger) => ran.push(trigger.source)
  })

  assert.deepEqual(ran, ['claude-code'])
  assert.equal(fs.files.has('/state/notify.signal.d/codex.json'), false)
})
