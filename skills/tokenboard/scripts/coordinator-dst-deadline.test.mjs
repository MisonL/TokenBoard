import assert from 'node:assert/strict'
import test from 'node:test'
import { coordinatedSync } from './coordinator.mjs'
import { fakeProcess, memoryRuntime } from './coordinator-test-helpers.mjs'

// These cases only exist on a wall clock that observes daylight saving, so this file pins
// its own zone. Node re-reads `process.env.TZ` for new Date construction, and every test
// here sets the zone it needs before building any Date; the rest of the suite runs in its
// own process and is untouched.
const originalTZ = process.env.TZ

function runAt(fs, now, scheduleWindow) {
  const trailing = []
  const result = coordinatedSync(
    { kind: 'notify', source: 'codex' },
    {
      ...fs,
      stateDir: '/state',
      now: () => now,
      process: fakeProcess(906),
      scheduleWindow,
      scheduleTrailing: (trigger, delayMs) => {
        trailing.push({ trigger, delayMs })
        return true
      },
      executeSync: () => ({})
    }
  )
  return { result, trailing }
}

function queueSignal(fs, requestedAt) {
  fs.writeFile('/state/notify.signal.d/codex.json', `${JSON.stringify({ source: 'codex', requestedAt })}\n`)
}

// On 2026-03-08 the 02:00 hour does not exist in New York. An hourly schedule that omits
// 02:00 therefore loses the one real gap on that day: the windows run continuously from
// 01:00 through 03:00 wall time, and the surrounding spans merge into one block longer
// than 24 hours. The block still ends at a gap (the 01:30-02:30 hole every other day), so
// the retry belongs there — a span-length heuristic would refuse to book anything.
test('a daylight-saving day does not turn an hourly schedule into a gap-free day', () => {
  process.env.TZ = 'America/New_York'
  try {
    const fs = memoryRuntime()
    const now = new Date(2026, 2, 8, 12, 5).getTime()
    queueSignal(fs, new Date(2026, 2, 8, 12, 0).toISOString())
    const times = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, '0')}:00`).filter(
      (time) => time !== '02:00'
    )

    const { result, trailing } = runAt(fs, now, { times, windowMs: 30 * 60_000 })

    assert.equal(result.skippedReason, 'scheduled-window')
    // Every day carries a 01:30-02:30 gap, so the merged block containing noon ends at
    // the next day's 01:30.
    const gapEnd = new Date(2026, 2, 9, 1, 30).getTime()
    assert.equal(trailing.length, 1)
    assert.equal(trailing[0].delayMs, gapEnd - now)
  } finally {
    process.env.TZ = originalTZ
  }
})

// America/Nuuk skipped 2026-03-28 23:00-24:00. A base-23:45 construction renormalises
// "+1 day" onto 03-29 00:45 and then loses the 03-28 00:00 window entirely, booking the
// retry a day late (into a still-open window). Building the candidate from noon of the
// target calendar day keeps the 00:00 slot on its own day.
test('a midnight window right after a skipped hour keeps its own day', () => {
  process.env.TZ = 'America/Nuuk'
  try {
    const fs = memoryRuntime()
    const now = new Date(2026, 2, 27, 23, 45).getTime()
    queueSignal(fs, new Date(2026, 2, 27, 23, 30).toISOString())

    const { result, trailing } = runAt(fs, now, { times: ['00:00', '23:30'], windowMs: 30 * 60_000 })

    assert.equal(result.skippedReason, 'scheduled-window')
    const windowEnd = new Date(2026, 2, 28, 0, 30).getTime()
    assert.equal(trailing.length, 1)
    assert.equal(trailing[0].delayMs, windowEnd - now)
  } finally {
    process.env.TZ = originalTZ
  }
})
