import assert from 'node:assert/strict'
import test from 'node:test'
import { coordinatedSync } from './coordinator.mjs'
import { fakeProcess, memoryRuntime } from './coordinator-test-helpers.mjs'
import { readSignalSources } from './coordinator-signal.mjs'
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

function runAt(
  fs,
  { now, trailing = [], executeSync, source = 'codex', cooldownMs, failureBackoffMs, resourcePressure }
) {
  return coordinatedSync(
    { kind: 'notify', source },
    {
      ...fs,
      stateDir: '/state',
      now: () => now,
      process: fakeProcess(901),
      scheduleWindow,
      cooldownMs,
      failureBackoffMs,
      resourcePressure,
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
  const trailing = []

  const result = runAt(fs, {
    now: localTime(12, 31),
    trailing,
    executeSync: (trigger) => ran.push(trigger.source)
  })

  assert.deepEqual(ran, [], 'the scheduled run already collected this signal')
  assert.equal(result.skippedSync, true)
  assert.equal(result.skippedReason, 'scheduled-covered')
  // No retry is booked from here: the covered request is gone and a hook landing just
  // after this exit queues a fresh one for the next trigger.
  assert.notEqual(result.trailingScheduled, true)
  assert.deepEqual(trailing, [])
  assert.equal(fs.exists('/state/notify.signal.d/codex.json'), false)
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

// The window test and the deadline share one clock reading: two reads that straddle the
// right edge (12:29:59.999 inside, 12:30:00.000 outside) used to book nothing at all.
test('a window skip at the last millisecond books the one-millisecond retry', () => {
  const fs = memoryRuntime()
  queueSignal(fs, 'codex', utcForLocal(12, 5))
  const trailing = []
  const edge = localTime(12, 30) - 1

  const result = runAt(fs, { now: edge, trailing })

  assert.equal(result.skippedReason, 'scheduled-window')
  assert.equal(trailing.length, 1)
  assert.equal(trailing[0].delayMs, 1)
})

// A covered trigger must not be re-queued by the window skip: re-appending it stamps the
// current time and hands it the scan the gate just ruled out.
test('a covered trigger is not revived by the window skip', () => {
  const fs = stateFsWith(memoryRuntime(), {})
  queueSignal(fs, 'codex', utcForLocal(12, 5))
  queueSignal(fs, 'claude-code', utcForLocal(12, 20))
  const trailing = []

  const result = runAt(fs, { now: localTime(12, 20), source: 'codex', trailing })

  assert.equal(result.skippedReason, 'scheduled-window')
  assert.deepEqual(result.trailingSources, ['claude-code'])
  assert.deepEqual(
    trailing.map(({ trigger }) => trigger.source),
    ['claude-code']
  )
  assert.equal(fs.files.has('/state/notify.signal.d/codex.json'), false, 'the covered trigger must stay removed')
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

// The window test and the deadline must read the clock once. With a constant `now` the
// two-read bug is invisible; a reading that advances past the right edge between the two
// calls is what it takes to see it (12:29:59.999 inside, 12:30:00.000 outside).
test('the window test and the deadline share a single clock reading', () => {
  const fs = memoryRuntime()
  queueSignal(fs, 'codex', utcForLocal(12, 5))
  const trailing = []
  // The coordinator reads the clock before the window test: the start stamp, the lock
  // owner stamp, and the coverage gate's "now". The inside reading sits at the window
  // test's position (fourth) and every later read is past the right edge, which is
  // exactly what a second window/deadline read would pick up.
  const readings = [localTime(12, 5), localTime(12, 5), localTime(12, 5), localTime(12, 30) - 1, localTime(12, 30)]
  let calls = 0

  const result = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      now: () => readings[Math.min(calls++, readings.length - 1)],
      process: fakeProcess(903),
      scheduleWindow,
      scheduleTrailing: (trigger, delayMs) => {
        trailing.push({ trigger, delayMs })
        return true
      },
      executeSync: () => ({})
    }
  )

  assert.equal(result.skippedReason, 'scheduled-window')
  // Built from the inside reading; a second read would land exactly on the window's
  // right edge, find no containing span and book nothing.
  assert.equal(result.trailingDelayMs, 1)
  assert.deepEqual(
    trailing.map(({ delayMs }) => delayMs),
    [1]
  )
})

// A hook that lands between the gate's read and its exit saw this worker holding the
// dispatch lock and did not spawn one of its own, so exiting on the first empty answer
// would strand its signal until the next external trigger. The gate re-reads the queue.
test('a signal that arrives while the gate runs is scanned instead of being stranded', () => {
  const fs = stateFsWith(memoryRuntime(), {})
  queueSignal(fs, 'codex', utcForLocal(12, 5))
  let injected = false
  const ran = []

  const result = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      now: () => localTime(14, 0),
      process: fakeProcess(904),
      scheduleWindow,
      rename: (from, to) => {
        fs.rename(from, to)
        // The claim rename is the hook's cue: it lands a claude-code request right after
        // the covered codex entry has been taken out of the queue.
        if (!injected && /\/notify\.signal\.d\/\d+-904-[0-9a-f]+\.json$/.test(to)) {
          injected = true
          queueSignal(fs, 'claude-code', utcForLocal(13, 59))
        }
      },
      scheduleTrailing: () => true,
      executeSync: (trigger) => {
        ran.push(trigger.source)
        return {}
      }
    }
  )

  assert.equal(injected, true, 'the concurrent arrival must actually have been exercised')
  assert.deepEqual(ran, ['claude-code'])
  assert.notEqual(result.skippedReason, 'scheduled-covered')
})

// An entry the claim cannot split (it carries another source's line) is kept queued and
// reported as not covered — so the source is scanned this run, not skipped.
test('a mixed-source entry the claim cannot split is scanned, not treated as covered', () => {
  const fs = stateFsWith(memoryRuntime(), {})
  fs.writeFile(
    '/state/notify.signal.d/codex.json',
    `${JSON.stringify({ source: 'codex', requestedAt: utcForLocal(12, 5) })}\n${JSON.stringify({
      source: 'claude-code',
      requestedAt: utcForLocal(12, 20)
    })}\n`
  )
  const ran = []

  const result = runAt(fs, { now: localTime(14, 0), executeSync: (trigger) => ran.push(trigger.source) })

  assert.ok(ran.includes('codex'), 'the split-impossible source must be scanned')
  assert.ok(ran.includes('claude-code'))
  assert.notEqual(result.skippedReason, 'scheduled-covered')
})

// Every skip path that re-queues a trigger must leave a covered one alone; `keepCooldownTrigger`
// stamps the current time and would hand the source a scan the gate ruled out.
test('a covered trigger is not revived by the cooldown skip', () => {
  const fs = stateFsWith(memoryRuntime(), {})
  queueSignal(fs, 'codex', utcForLocal(12, 5))
  queueSignal(fs, 'claude-code', utcForLocal(12, 20))
  fs.writeFile('/state/last-success.json', utcForLocal(12, 19))
  const trailing = []

  const result = runAt(fs, { now: localTime(12, 21), trailing })

  assert.equal(result.skippedReason, 'cooldown')
  assert.deepEqual(result.trailingSources, ['claude-code'])
  assert.equal(fs.files.has('/state/notify.signal.d/codex.json'), false, 'the covered trigger must stay removed')
})

test('a covered trigger is not revived by the resource-pressure skip', () => {
  const fs = stateFsWith(memoryRuntime(), {})
  queueSignal(fs, 'codex', utcForLocal(12, 5))
  queueSignal(fs, 'claude-code', utcForLocal(12, 20))

  const result = runAt(fs, {
    now: localTime(14, 0),
    resourcePressure: () => ({ pressured: true, detail: 'test pressure' })
  })

  assert.equal(result.skippedReason, 'resource-pressure')
  assert.equal(fs.files.has('/state/notify.signal.d/codex.json'), false, 'the covered trigger must stay removed')
})

test('a covered trigger is not revived by the failure-backoff skip', () => {
  const fs = stateFsWith(memoryRuntime(), {})
  queueSignal(fs, 'codex', utcForLocal(12, 5))
  queueSignal(fs, 'claude-code', utcForLocal(12, 20))
  fs.writeFile('/state/last-failure.json', utcForLocal(13, 59))

  const result = runAt(fs, { now: localTime(14, 0), failureBackoffMs: 10 * 60_000 })

  assert.equal(result.skippedReason, 'failure-backoff')
  assert.equal(fs.files.has('/state/notify.signal.d/codex.json'), false, 'the covered trigger must stay removed')
})

// A half-width window wider than 12 hours spans more than a day on its own, so adjacent
// days always overlap and there is no gap to wake into. Booking the merged span's end
// would wake inside the next window and re-arm the chain forever.
test('an injected window wider than half a day books no trailing retry', () => {
  const wideFs = memoryRuntime()
  queueSignal(wideFs, 'codex', utcForLocal(12, 5))
  const wideTrailing = []
  const wideResult = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...wideFs,
      stateDir: '/state',
      now: () => localTime(12, 5),
      process: fakeProcess(905),
      scheduleWindow: { times: ['12:00'], windowMs: 13 * 60 * 60_000 },
      scheduleTrailing: (trigger, delayMs) => {
        wideTrailing.push({ trigger, delayMs })
        return true
      },
      executeSync: () => ({})
    }
  )

  assert.equal(wideResult.skippedReason, 'scheduled-window')
  assert.equal(wideResult.trailingScheduled, undefined)
  assert.equal(wideTrailing.length, 0)
})

// A hook can land a *newer* request for a source the gate has already judged covered,
// between the gate's read and its exit. The re-read must judge it on its own timestamp,
// not skip the whole source because the name is in the covered set, or the request waits
// for the next external trigger — exactly what the re-read exists to prevent.
test('a newer request for an already-covered source is not filtered out by name', () => {
  const fs = stateFsWith(memoryRuntime(), {})
  queueSignal(fs, 'codex', utcForLocal(12, 5))
  let injected = false
  const ran = []

  const result = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      now: () => localTime(14, 0),
      process: fakeProcess(907),
      scheduleWindow,
      rename: (from, to) => {
        fs.rename(from, to)
        if (!injected && String(to).replace(/\\/g, '/').includes('/notify.signal.d/')) {
          injected = true
          queueSignal(fs, 'codex', utcForLocal(13, 59))
        }
      },
      scheduleTrailing: () => true,
      executeSync: (trigger) => {
        ran.push(trigger.source)
        return {}
      }
    }
  )

  assert.equal(injected, true, 'the concurrent arrival must actually have been exercised')
  assert.deepEqual(ran, ['codex'])
  assert.notEqual(result.skippedReason, 'scheduled-covered')
})

// A covered exit through the legacy channel only writes nothing: the legacy file is not
// ours to delete, and the exit is still a plain coverage decision.
test('a covered exit through the legacy channel claims nothing', () => {
  const fs = stateFsWith(memoryRuntime(), {})
  fs.writeFile('/state/notify.signal', `${JSON.stringify({ source: 'codex', requestedAt: utcForLocal(12, 5) })}\n`)
  const trailing = []

  const result = runAt(fs, { now: localTime(12, 31), trailing })

  assert.equal(result.skippedReason, 'scheduled-covered')
  assert.notEqual(result.trailingScheduled, true)
  assert.deepEqual(trailing, [])
  assert.equal(fs.exists('/state/notify.signal'), true)
})

// The same witness inside one run: an entry that reappears after the claim was removed
// by that claim's judgement of the *old* entry, so it cannot be the same request even if
// its timestamp sorts before the run.
test('an entry that reappears after the claim is judged on evidence, not its clock', () => {
  const fs = stateFsWith(memoryRuntime(), { startedAt: utcForLocal(12, 29, 55), completedAt: utcForLocal(12, 30) })
  queueSignal(fs, 'codex', utcForLocal(12, 29, 50))
  let injected = false
  const ran = []

  coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      now: () => localTime(14, 0),
      process: fakeProcess(911),
      scheduleWindow,
      rename: (from, to) => {
        fs.rename(from, to)
        if (!injected && String(to).replace(/\\/g, '/').includes('/notify.signal.d/')) {
          injected = true
          queueSignal(fs, 'codex', utcForLocal(12, 29, 53))
        }
      },
      scheduleTrailing: () => true,
      executeSync: (trigger) => {
        ran.push(trigger.source)
        return {}
      }
    }
  )

  assert.equal(injected, true, 'the reappearing entry must actually have been exercised')
  assert.deepEqual(ran, ['codex'])
})

// A re-read can meet a signal whose time cannot be parsed — another writer appended a
// bare source line to the legacy journal while the claim ran. The first judgement never
// treats an undatable request as covered; the re-read must not quietly reinstate the
// earlier coverage for it, or the request waits for the next trigger after the gate had
// already decided it needed a scan.
test('an undatable arrival during the re-read is scanned, not left covered', () => {
  const fs = stateFsWith(memoryRuntime(), {})
  queueSignal(fs, 'codex', utcForLocal(12, 5))
  let injected = false
  const ran = []

  const result = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      now: () => localTime(12, 31),
      process: fakeProcess(915),
      scheduleWindow,
      rename: (from, to) => {
        fs.rename(from, to)
        if (!injected && String(to).replace(/\\/g, '/').includes('/notify.signal.d/')) {
          injected = true
          let existing = ''
          try {
            existing = fs.readFile('/state/notify.signal')
          } catch {
            // no legacy journal yet
          }
          fs.writeFile('/state/notify.signal', `${existing}codex\n`)
        }
      },
      scheduleTrailing: () => true,
      executeSync: (trigger) => {
        ran.push(trigger.source)
        return {}
      }
    }
  )

  assert.equal(injected, true, 'the undatable arrival must actually have been exercised')
  assert.deepEqual(ran, ['codex'])
  assert.notEqual(result.skippedReason, 'scheduled-covered')
})

// The hand-off window in sequence: the covered exit scans nothing and leaves a late
// signal in the queue; the next run (any hook trigger) merges the queue and scans it.
// The late request belongs to *another* source: if the next run only scanned its own
// trigger, or the late entry vanished, the scan below would not happen.
test('a signal left behind by a covered exit is scanned by the next run', () => {
  const fs = stateFsWith(memoryRuntime(), {})
  queueSignal(fs, 'codex', utcForLocal(12, 5))

  const first = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      now: () => localTime(12, 31),
      process: fakeProcess(916),
      scheduleWindow,
      scheduleTrailing: () => true,
      executeSync: () => {
        throw new Error('the covered request must not be scanned')
      }
    }
  )
  assert.equal(first.skippedReason, 'scheduled-covered')

  queueSignal(fs, 'claude-code', utcForLocal(12, 31))
  const ran = []
  coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      now: () => localTime(12, 32),
      process: fakeProcess(917),
      scheduleWindow,
      scheduleTrailing: () => true,
      executeSync: (trigger) => {
        ran.push(trigger.source)
        return {}
      }
    }
  )

  assert.deepEqual([...ran].sort(), ['claude-code', 'codex'])
  // The scan acknowledges what it consumed: the claim file alone disappearing is not
  // enough evidence (an un-acked entry stays readable under its per-event name).
  assert.deepEqual(readSignalSources({ ...fs, stateDir: '/state' }), [])
})
