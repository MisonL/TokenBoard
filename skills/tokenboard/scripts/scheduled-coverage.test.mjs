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
      startedAt: '2026-11-27T12:04:00.000Z',
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
    covered(stateFs({ completedAt: '2026-11-27T12:04:30.000Z', updatedAt: '2026-11-27T12:04:30.000Z' })),
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
  const fs = stateFs({ completedAt: '2026-11-27T12:04:30.000Z', updatedAt: '2026-11-27T12:04:30.000Z' })
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

test('no state, an unreadable state, or a malformed timestamp means not covered', () => {
  assert.equal(covered(memoryRuntime()), false)
  const broken = stateFs()
  broken.writeFile(`${stateDir}/scheduled-sync-state.json`, '{')
  assert.equal(covered(broken), false)
  // A file that passes the reader's shape check but whose time cannot be parsed (written by
  // an older or hand-edited producer).
  const noTime = stateFs()
  noTime.writeFile(
    `${stateDir}/scheduled-sync-state.json`,
    '{"schemaVersion":"tokenboard-scheduled-sync/v1","source":"all","status":"success",' +
      '"startedAt":"2026-11-27T12:04:00.000Z","updatedAt":"2026-11-27T12:04:00.000Z",' +
      '"completedAt":"2026-11-27T12:04:00.000Z"}\n'
  )
  assert.equal(covered(noTime), false)
})

test('a covered signal does not reappear as a trailing retry after the window passes', () => {
  // 12:05 signal, suppressed in the window, scheduled run finishes at 12:19. A trailing
  // worker waking at 12:31 must not re-scan the source: the state file is the evidence,
  // not the wall clock and not the scheduled task's exit code.
  const fs = stateFs({ completedAt: '2026-11-27T12:19:00.000Z', updatedAt: '2026-11-27T12:19:00.000Z' })
  assert.equal(
    sourceCoveredByScheduledRun({
      stateDir,
      source,
      requestedAt,
      now: () => Date.parse('2026-11-27T12:31:00.000Z'),
      readFile: fs.readFile
    }),
    true
  )
})

test('an unknown request age never counts as covered', () => {
  assert.equal(covered(stateFs(), { requestedAt: 'not-a-date' }), false)
  assert.equal(covered(stateFs(), { requestedAt: undefined }), false)
})

test('a completion in the future or far in the past does not cover a signal', () => {
  assert.equal(
    covered(stateFs({ completedAt: '2026-11-27T13:00:00.000Z', updatedAt: '2026-11-27T13:00:00.000Z' })),
    false
  )
  assert.equal(
    covered(stateFs({ completedAt: '2026-11-26T12:31:00.000Z', updatedAt: '2026-11-26T12:31:00.000Z' })),
    false
  )
})
