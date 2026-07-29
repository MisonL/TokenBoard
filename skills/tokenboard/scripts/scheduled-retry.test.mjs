import assert from 'node:assert/strict'
import test from 'node:test'
import { runScheduledRetry, scheduledRetryStatePath } from './scheduled-retry.mjs'
import { runSyncInvocation } from './sync.mjs'

test('scheduled retry records deferred lock contention and then completion', () => {
  const fs = memoryRuntime()
  let calls = 0

  const result = runScheduledRetry({
    stateDir: '/state',
    source: 'all',
    runtime: fs.runtime,
    maxAttempts: 2,
    delayMs: 250,
    runAttempt: ({ attempt }) => {
      calls += 1
      if (attempt === 1) throw lockTimeout()
      return 0
    }
  })

  assert.deepEqual(result, { exitCode: 0, skipped: false, attempts: 2 })
  assert.equal(calls, 2)
  assert.deepEqual(fs.sleeps, [250])
  assert.equal(fs.files.has('/state/scheduled-sync-retry.lock'), false)
  assert.deepEqual(JSON.parse(fs.files.get(scheduledRetryStatePath('/state'))), {
    schemaVersion: 'tokenboard-scheduled-sync-retry/v1',
    source: 'all',
    status: 'completed',
    retryAttempt: 2,
    maxAttempts: 2,
    updatedAt: '2026-07-29T00:00:00.250Z'
  })
})

test('scheduled retry stops after its bounded lock-timeout budget', () => {
  const fs = memoryRuntime()
  let calls = 0

  const result = runScheduledRetry({
    stateDir: '/state',
    source: 'all',
    runtime: fs.runtime,
    maxAttempts: 2,
    delayMs: 10,
    runAttempt: () => {
      calls += 1
      throw lockTimeout()
    }
  })

  assert.deepEqual(result, { exitCode: 1, skipped: false, attempts: 2, exhausted: true })
  assert.equal(calls, 2)
  assert.deepEqual(fs.sleeps, [10])
  assert.equal(fs.files.has('/state/scheduled-sync-retry.lock'), false)
  const state = JSON.parse(fs.files.get(scheduledRetryStatePath('/state')))
  assert.equal(state.status, 'exhausted')
  assert.equal(state.retryAttempt, 2)
  assert.match(state.error, /Timed out waiting for TokenBoard sync lock/)
})

test('scheduled retry stops immediately on a real collector failure', () => {
  const fs = memoryRuntime()

  const result = runScheduledRetry({
    stateDir: '/state',
    source: 'all',
    runtime: fs.runtime,
    runAttempt: () => 17
  })

  assert.deepEqual(result, { exitCode: 17, skipped: false, attempts: 1 })
  assert.deepEqual(fs.sleeps, [])
  assert.equal(JSON.parse(fs.files.get(scheduledRetryStatePath('/state'))).status, 'failed')
})

test('scheduled retry writes a failure state before rethrowing an infrastructure error', () => {
  const fs = memoryRuntime()

  assert.throws(
    () => runScheduledRetry({
      stateDir: '/state',
      source: 'all',
      runtime: fs.runtime,
      runAttempt: () => {
        throw new Error('config unreadable')
      }
    }),
    /config unreadable/
  )

  const state = JSON.parse(fs.files.get(scheduledRetryStatePath('/state')))
  assert.equal(state.status, 'failed')
  assert.equal(state.retryAttempt, 1)
  assert.equal(state.error, 'config unreadable')
  assert.equal(fs.files.has('/state/scheduled-sync-retry.lock'), false)
})

test('scheduled retry coalesces while another retry loop owns its lock', () => {
  const fs = memoryRuntime({
    '/state/scheduled-sync-retry.lock': JSON.stringify({
      pid: 999,
      startedAt: '2026-07-29T00:00:00.000Z',
      token: 'other-retry'
    })
  })
  let collected = false

  const result = runScheduledRetry({
    stateDir: '/state',
    source: 'all',
    runtime: fs.runtime,
    runAttempt: () => {
      collected = true
      return 0
    }
  })

  assert.deepEqual(result, { exitCode: 0, skipped: true, skippedReason: 'active-retry', attempts: 0 })
  assert.equal(collected, false)
})

test('scheduled retry surfaces retry-state write failures and releases its retry lock', () => {
  const fs = memoryRuntime()
  const writeFile = fs.runtime.writeFile
  let collected = false

  assert.throws(
    () => runScheduledRetry({
      stateDir: '/state',
      source: 'all',
      runtime: {
        ...fs.runtime,
        writeFile: (path, value, options) => {
          if (path.includes('scheduled-sync-retry.json.tmp-')) throw codeError('EACCES', path)
          writeFile(path, value, options)
        }
      },
      runAttempt: () => {
        collected = true
        return 0
      }
    }),
    /EACCES/
  )

  assert.equal(collected, false)
  assert.equal(fs.files.has('/state/scheduled-sync-retry.lock'), false)
})

test('scheduled retry reports lock-release failures without hiding a completed collection', () => {
  const fs = memoryRuntime()
  const unlink = fs.runtime.unlink
  let releaseFailed = false

  assert.throws(
    () => runScheduledRetry({
      stateDir: '/state',
      source: 'all',
      runtime: {
        ...fs.runtime,
        unlink: (path) => {
          if (!releaseFailed && path.startsWith('/state/scheduled-sync-retry.lock.release-')) {
            releaseFailed = true
            throw new Error('retry lock release failed')
          }
          unlink(path)
        }
      },
      runAttempt: () => 0
    }),
    /TokenBoard scheduled retry lock release failed: retry lock release failed/
  )

  const state = JSON.parse(fs.files.get(scheduledRetryStatePath('/state')))
  assert.equal(state.status, 'failed')
  assert.equal(state.retryAttempt, 1)
  assert.match(state.error, /TokenBoard scheduled retry lock release failed/)
  assert.equal(fs.files.has('/state/scheduled-sync-retry.lock'), true)
})

test('sync invocation retries only scheduled lock timeouts and skips upgrade during recovery', () => {
  const retries = []
  const invocation = {
    source: 'all',
    env: { TOKENBOARD_CONFIG_DIR: '/config' }
  }
  const initialFlags = { mode: 'sync', scheduled: true }

  const exitCode = runSyncInvocation({
    flags: initialFlags,
    invocation,
    stateDir: '/state',
    runWithLock: ({ flags }) => {
      if (flags['skip-upgrade'] === true) return 0
      throw lockTimeout()
    },
    runRetry: (options) => {
      retries.push(options)
      return { exitCode: options.runAttempt({ attempt: 1 }), skipped: false, attempts: 1 }
    }
  })

  assert.equal(exitCode, 0)
  assert.equal(retries.length, 1)
  assert.equal(retries[0].source, 'all')
  assert.equal(retries[0].stateDir, '/state')
  assert.equal(initialFlags['skip-upgrade'], undefined)
})

test('sync invocation never retries a hook timeout or a non-sync mode', () => {
  for (const flags of [
    { mode: 'sync', scheduled: true, hook: true },
    { mode: 'preview', scheduled: true }
  ]) {
    assert.throws(
      () => runSyncInvocation({
        flags,
        invocation: { source: 'all', env: {} },
        stateDir: '/state',
        runWithLock: () => {
          throw lockTimeout()
        },
        runRetry: () => {
          throw new Error('this invocation must not enter scheduled retry')
        }
      }),
      /Timed out waiting for TokenBoard sync lock/
    )
  }
})

function lockTimeout() {
  const error = new Error('Timed out waiting for TokenBoard sync lock: /state/sync.lock')
  error.code = 'TOKENBOARD_SYNC_LOCK_TIMEOUT'
  return error
}

function memoryRuntime(initial = {}) {
  const files = new Map(Object.entries(initial))
  const sleeps = []
  let now = Date.parse('2026-07-29T00:00:00.000Z')
  const runtime = {
    stateDir: '/state',
    now: () => now,
    process: {
      pid: 101,
      kill: () => true
    },
    mkdir: () => {},
    readFile: (path) => readFile(files, path),
    writeFile: (path, value, options = {}) => {
      if (options.flag === 'wx' && files.has(path)) throw codeError('EEXIST', path)
      files.set(path, String(value))
    },
    rename: (from, to) => {
      const value = readFile(files, from)
      files.set(to, value)
      files.delete(from)
    },
    link: (from, to) => {
      if (files.has(to)) throw codeError('EEXIST', to)
      files.set(to, readFile(files, from))
    },
    unlink: (path) => {
      if (!files.has(path)) throw codeError('ENOENT', path)
      files.delete(path)
    },
    sleep: (milliseconds) => {
      sleeps.push(milliseconds)
      now += milliseconds
    }
  }
  return { files, sleeps, runtime }
}

function readFile(files, path) {
  if (!files.has(path)) throw codeError('ENOENT', path)
  return files.get(path)
}

function codeError(code, path) {
  const error = new Error(`${code}: ${path}`)
  error.code = code
  return error
}
