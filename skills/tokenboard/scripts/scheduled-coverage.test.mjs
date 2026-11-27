import assert from 'node:assert/strict'
import test from 'node:test'
import { sourceCoveredByScheduledRun } from './scheduled-coverage.mjs'
import { writeScheduledSyncState } from './scheduled-sync-state.mjs'
import { memoryRuntime } from './coordinator-test-helpers.mjs'

const stateDir = '/state'
const source = 'codex'
const requestedAt = '2026-11-27T12:05:00.000Z'
const now = '2026-11-27T12:31:00.000Z'

function stateFs(overrides = {}) {
  const fs = { ...memoryRuntime(), chmod: () => {}, lstat: () => null }
  writeScheduledSyncState(
    {
      stateDir,
      source: 'all',
      status: 'success',
      // Coverage requires the run to have *started after* the request (12:05).
      startedAt: '2026-11-27T12:06:00.000Z',
      updatedAt: now,
      completedAt: now,
      exitCode: 0,
      ...overrides
    },
    fs
  )
  return fs
}

function covered(fs, overrides = {}) {
  return sourceCoveredByScheduledRun({
    stateDir,
    source,
    requestedAt,
    now: () => Date.parse(now),
    readFile: fs.readFile,
    ...overrides
  })
}

test('a successful all-source run finished after the signal covers it', () => {
  assert.equal(covered(stateFs()), true)
})

test('a run that finished before the signal does not cover it', () => {
  assert.equal(
    covered(
      stateFs({
        startedAt: '2026-11-27T12:00:00.000Z',
        completedAt: '2026-11-27T12:04:30.000Z',
        updatedAt: '2026-11-27T12:04:30.000Z'
      })
    ),
    false
  )
})

// The run may have scanned the source before the signal arrived: a request that lands while
// the scheduled run is in flight is not guaranteed to be inside that run's scan, so it is
// not covered (the conservative direction — a duplicate scan, never a missed signal).
test('a run that was already scanning when the signal arrived does not cover it', () => {
  assert.equal(
    covered(
      stateFs({
        startedAt: '2026-11-27T12:03:00.000Z',
        completedAt: now,
        updatedAt: now
      })
    ),
    false
  )
})

test('a failed run does not cover a signal, whatever its exit code', () => {
  assert.equal(covered(stateFs({ status: 'failed', exitCode: 0 })), false)
})

test('a deferred hand-off and a still-running run do not cover a signal', () => {
  assert.equal(covered(stateFs({ status: 'deferred' })), false)
  assert.equal(covered(stateFs({ status: 'running' })), false)
})

test('a partial-source run does not cover a different source', () => {
  const fs = stateFs({ source: 'claude-code' })
  assert.equal(covered(fs), false, 'claude-code run has nothing to say about codex')
  assert.equal(covered(fs, { source: 'claude-code' }), true)
})

test('a per-source success covers that source even when the all-source state is older', () => {
  const fs = stateFs({
    startedAt: '2026-11-27T12:00:00.000Z',
    completedAt: '2026-11-27T12:04:30.000Z',
    updatedAt: '2026-11-27T12:04:30.000Z'
  })
  writeScheduledSyncState(
    {
      stateDir,
      source,
      status: 'success',
      startedAt: '2026-11-27T12:05:30.000Z',
      updatedAt: now,
      completedAt: now
    },
    fs
  )
  assert.equal(covered(fs), true)
})

test('no state or a corrupt state means not covered', () => {
  assert.equal(covered(memoryRuntime()), false)
  const broken = stateFs()
  broken.writeFile(`${stateDir}/scheduled-sync-state.json`, '{')
  assert.equal(covered(broken), false)
})

// A success row without an explicit completion is not evidence of a finished scan: the
// shape check allows the field to be absent (a `running` row has none), so coverage must
// not borrow `updatedAt` to fill it in.
test('a success state without completedAt is not covered', () => {
  const fs = stateFs()
  fs.writeFile(
    `${stateDir}/scheduled-sync-state.json`,
    '{"schemaVersion":"tokenboard-scheduled-sync/v1","source":"all","status":"success",' +
      '"startedAt":"2026-11-27T12:06:00.000Z","updatedAt":"2026-11-27T12:30:00.000Z"}\n'
  )
  assert.equal(covered(fs), false)
})

// An unreadable state file is a bookkeeping problem, not a reason to abort the hook: the
// candidate is simply not covered and the run proceeds.
test('an unreadable state file means not covered instead of failing the hook', () => {
  const fs = stateFs()
  const eacces = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
  assert.equal(
    covered(fs, {
      readFile: (path) => {
        if (String(path).endsWith('scheduled-sync-state.json')) throw eacces
        return fs.readFile(path)
      }
    }),
    false
  )
})

test('a state file whose own source does not match the file it lives in is not covered', () => {
  const fs = stateFs()
  // The all-source file claiming to be a claude-code-only run: the file name the gate
  // trusts and the content it reads must agree.
  fs.writeFile(
    `${stateDir}/scheduled-sync-state.json`,
    '{"schemaVersion":"tokenboard-scheduled-sync/v1","source":"claude-code","status":"success",' +
      '"startedAt":"2026-11-27T12:06:00.000Z","updatedAt":"2026-11-27T12:31:00.000Z",' +
      '"completedAt":"2026-11-27T12:31:00.000Z"}\n'
  )
  assert.equal(covered(fs, { source: 'claude-code' }), false)
})

test('a completion before the run start is a corrupt file, not coverage', () => {
  assert.equal(
    covered(
      stateFs({
        startedAt: '2026-11-27T12:10:00.000Z',
        completedAt: '2026-11-27T12:08:00.000Z',
        updatedAt: '2026-11-27T12:08:00.000Z'
      })
    ),
    false
  )
})

test('an unknown request age never counts as covered', () => {
  assert.equal(covered(stateFs(), { requestedAt: 'not-a-date' }), false)
  assert.equal(covered(stateFs(), { requestedAt: undefined }), false)
})

test('a completion in the future does not cover a signal', () => {
  assert.equal(
    covered(stateFs({ completedAt: '2026-11-27T13:00:00.000Z', updatedAt: '2026-11-27T13:00:00.000Z' })),
    false
  )
})

// The one-day age cap on its own: a request two days ago, a run that started after it and
// finished 25 hours before now — every timestamp order is valid, so only the cap rejects it.
test('a completion older than a day does not cover a signal even though it is after the request', () => {
  const fs = stateFs({
    startedAt: '2026-11-26T11:00:00.000Z',
    completedAt: '2026-11-26T11:30:00.000Z',
    updatedAt: '2026-11-26T11:30:00.000Z'
  })
  assert.equal(covered(fs, { requestedAt: '2026-11-26T10:00:00.000Z' }), false)
  const recent = stateFs({
    startedAt: '2026-11-26T13:00:00.000Z',
    completedAt: '2026-11-26T13:30:00.000Z',
    updatedAt: '2026-11-26T13:30:00.000Z'
  })
  assert.equal(covered(recent, { requestedAt: '2026-11-26T10:00:00.000Z' }), true)
})
