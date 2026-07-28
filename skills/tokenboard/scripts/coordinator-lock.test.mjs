import assert from 'node:assert/strict'
import test from 'node:test'
import { acquireLock, lockHasToken, releaseLock } from './coordinator-lock.mjs'
import { coordinatedSync } from './coordinator.mjs'
import {
  fakeProcess,
  linkMemoryFile,
  memoryRuntime,
  moveMemoryFile,
  readMemoryFile,
  removeMemoryFile
} from './coordinator-test-helpers.mjs'

test('releaseLock rejects non-atomic cleanup instead of deleting a lock', () => {
  const removed = []

  assert.throws(
    () => releaseLock('/state/sync.lock', {
      process: fakeProcess(201),
      readFile: () => JSON.stringify({ pid: 201, startedAt: '2026-05-22T10:00:00.000Z' }),
      unlink: (path) => removed.push(path)
    }),
    /requires atomic rename and link operations/
  )

  assert.deepEqual(removed, [])
})

test('acquireLock creates a private tokenized lock record', () => {
  const files = new Map()
  let writeOptions
  const runtime = {
    now: () => Date.parse('2026-07-18T10:00:00.000Z'),
    process: fakeProcess(201),
    readFile: (path) => readMemoryFile(files, path),
    writeFile: (path, value, options) => {
      writeOptions = options
      files.set(path, String(value))
    }
  }

  const owner = acquireLock('/state/sync.lock', runtime)

  assert.match(owner.token, /^[a-f0-9]{32}$/)
  assert.deepEqual(JSON.parse(files.get('/state/sync.lock')), {
    pid: 201,
    startedAt: '2026-07-18T10:00:00.000Z',
    token: owner.token
  })
  assert.equal(writeOptions.flag, 'wx')
  assert.equal(writeOptions.mode, 0o600)
  assert.equal(lockHasToken('/state/sync.lock', owner.token, runtime), true)
})

test('releaseLock preserves a same-process lock with a different token', () => {
  const lockPath = '/state/sync.lock'
  const original = JSON.stringify({ pid: 201, token: 'new-owner' })
  const files = new Map([[lockPath, original]])
  const runtime = {
    process: fakeProcess(201),
    readFile: (path) => readMemoryFile(files, path),
    rename: (from, to) => moveMemoryFile(files, from, to),
    link: (from, to) => linkMemoryFile(files, from, to),
    unlink: (path) => removeMemoryFile(files, path)
  }

  assert.equal(releaseLock(lockPath, runtime, { token: 'old-owner' }), false)
  assert.equal(files.get(lockPath), original)
})

test('coordinator recovers a pid-reused lock not owned by the current process', () => {
  const lockPath = '/state/sync.lock'
  const fs = memoryRuntime({
    [lockPath]: JSON.stringify({ pid: 301, token: 'crashed-owner', startedAt: '2026-07-18T10:00:00.000Z' })
  })
  let ran = false

  const result = coordinatedSync({ kind: 'notify', source: 'codex' }, {
    ...fs,
    stateDir: '/state',
    cooldownMs: 0,
    process: fakeProcess(301),
    executeSync: () => {
      ran = true
      return { ok: true }
    }
  })

  assert.equal(result.error, undefined)
  assert.equal(ran, true)
  assert.equal(fs.files.has(lockPath), false)
})

test('coordinator preserves an active same-process lock owner', () => {
  const lockPath = '/state/sync.lock'
  const fs = memoryRuntime()
  const runtime = {
    ...fs,
    now: () => Date.parse('2026-07-18T10:00:00.000Z'),
    process: fakeProcess(302)
  }
  const owner = acquireLock(lockPath, runtime)
  let ran = false

  const result = coordinatedSync({ kind: 'notify', source: 'codex' }, {
    ...runtime,
    stateDir: '/state',
    cooldownMs: 0,
    lockTimeoutMs: 0,
    executeSync: () => {
      ran = true
      return { ok: true }
    }
  })

  assert.equal(result.skippedReason, 'lock-timeout')
  assert.equal(ran, false)
  assert.equal(lockHasToken(lockPath, owner.token, runtime), true)
  assert.equal(releaseLock(lockPath, runtime, owner), true)
})

test('releaseLock removes malformed lock files', () => {
  const lockPath = '/state/sync.lock'
  const files = new Map([[lockPath, 'not-json']])
  const released = releaseLock(lockPath, {
    process: fakeProcess(202),
    readFile: (path) => readMemoryFile(files, path),
    writeFile: (path, value, options = {}) => {
      if (options.flag === 'wx' && files.has(path)) {
        const error = new Error('EEXIST')
        error.code = 'EEXIST'
        throw error
      }
      files.set(path, String(value))
    },
    rename: (from, to) => moveMemoryFile(files, from, to),
    link: (from, to) => linkMemoryFile(files, from, to),
    unlink: (path) => removeMemoryFile(files, path)
  })

  assert.equal(released, true)
  assert.equal(files.has(lockPath), false)
})

test('releaseLock does not remove locks with unreadable ownership', () => {
  const removed = []
  assert.throws(
    () => releaseLock('/state/sync.lock', {
      process: fakeProcess(205),
      readFile: () => {
        const error = new Error('EACCES')
        error.code = 'EACCES'
        throw error
      },
      unlink: (path) => removed.push(path)
    }),
    /EACCES/
  )

  assert.deepEqual(removed, [])
})

test('releaseLock leaves a replacement untouched when its ownership read sees no file', () => {
  const removed = []
  releaseLock('/state/sync.lock', {
    process: fakeProcess(206),
    readFile: () => {
      const error = new Error('ENOENT')
      error.code = 'ENOENT'
      throw error
    },
    unlink: (path) => {
      removed.push(path)
      const error = new Error('ENOENT')
      error.code = 'ENOENT'
      throw error
    }
  })

  assert.deepEqual(removed, [])
})

test('coordinator restores a stale lock when its quarantined record cannot be read', () => {
  const lockPath = '/state/sync.lock'
  const original = JSON.stringify({ pid: 300, startedAt: '2026-05-22T10:00:00.000Z' })
  const fs = memoryRuntime({ [lockPath]: original })
  let quarantinePath = ''

  const result = coordinatedSync({ kind: 'notify', source: 'codex' }, {
    ...fs,
    stateDir: '/state',
    process: {
      pid: 301,
      kill: (pid) => {
        if (pid === 300) {
          const error = new Error('ESRCH')
          error.code = 'ESRCH'
          throw error
        }
        return true
      }
    },
    readFile: (path) => {
      if (path === quarantinePath) {
        const error = new Error('EACCES')
        error.code = 'EACCES'
        throw error
      }
      return fs.readFile(path)
    },
    rename: (from, to) => {
      if (from === lockPath) quarantinePath = to
      fs.rename(from, to)
    },
    executeSync: () => {
      throw new Error('should not run')
    }
  })

  assert.equal(result.error, 'EACCES')
  assert.equal(fs.files.get(lockPath), original)
  assert.equal(fs.files.has(quarantinePath), false)
})

test('releaseLock preserves a replacement created after reading its owner', () => {
  const lockPath = '/state/sync.lock'
  const replacement = JSON.stringify({ pid: 302, token: 'replacement' })
  const files = new Map([
    [lockPath, JSON.stringify({ pid: 301, token: 'original' })]
  ])
  let replaced = false
  const replaceOwner = () => {
    if (replaced) return
    replaced = true
    files.set(lockPath, replacement)
  }
  const runtime = {
    process: fakeProcess(301),
    readFile: (path) => readMemoryFile(files, path),
    writeFile: (path, value, options = {}) => {
      if (options.flag === 'wx' && files.has(path)) {
        const error = new Error('EEXIST')
        error.code = 'EEXIST'
        throw error
      }
      files.set(path, String(value))
    },
    rename: (from, to) => {
      replaceOwner()
      moveMemoryFile(files, from, to)
    },
    link: (from, to) => linkMemoryFile(files, from, to),
    unlink: (path) => {
      replaceOwner()
      removeMemoryFile(files, path)
    }
  }

  releaseLock(lockPath, runtime)

  assert.equal(files.get(lockPath), replacement)
})

test('coordinator does not clear a live replacement while recovering a stale lock', () => {
  const lockPath = '/state/sync.lock'
  const replacement = JSON.stringify({ pid: 302, token: 'replacement' })
  const fs = memoryRuntime({
    [lockPath]: JSON.stringify({ pid: 300, token: 'stale' })
  })
  let replaced = false
  let ran = false
  const replaceOwner = () => {
    if (replaced) return
    replaced = true
    fs.files.set(lockPath, replacement)
  }

  const result = coordinatedSync({ kind: 'notify', source: 'codex' }, {
    ...fs,
    stateDir: '/state',
    lockTimeoutMs: 0,
    process: {
      pid: 301,
      kill: (pid) => {
        if (pid === 300) {
          const error = new Error('ESRCH')
          error.code = 'ESRCH'
          throw error
        }
        return true
      }
    },
    rename: (from, to) => {
      replaceOwner()
      moveMemoryFile(fs.files, from, to)
    },
    link: (from, to) => linkMemoryFile(fs.files, from, to),
    unlink: (path) => {
      replaceOwner()
      removeMemoryFile(fs.files, path)
    },
    executeSync: () => {
      ran = true
      return { ok: true }
    }
  })

  assert.equal(result.skippedReason, 'lock-timeout')
  assert.equal(ran, false)
  assert.equal(fs.files.get(lockPath), replacement)
})

test('coordinator cleanup guard blocks a competing owner while removing a stale lock', () => {
  const lockPath = '/state/sync.lock'
  const fs = memoryRuntime({
    [lockPath]: JSON.stringify({ pid: 300, token: 'stale' })
  })
  let competingOwner
  let observedCleanupGuard = false
  const competingRuntime = {
    ...fs,
    now: () => Date.parse('2026-07-18T10:00:00.000Z'),
    process: fakeProcess(302)
  }

  const result = coordinatedSync({ kind: 'notify', source: 'codex' }, {
    ...fs,
    stateDir: '/state',
    now: () => Date.parse('2026-07-18T10:00:00.000Z'),
    process: {
      pid: 301,
      kill: (pid) => {
        if (pid === 300) {
          const error = new Error('ESRCH')
          error.code = 'ESRCH'
          throw error
        }
        return true
      }
    },
    writeFile: (path, value, options) => {
      fs.writeFile(path, value, options)
      if (path === `${lockPath}.cleanup` && !observedCleanupGuard) {
        observedCleanupGuard = true
        competingOwner = acquireLock(lockPath, competingRuntime)
      }
    },
    executeSync: () => ({ ok: true })
  })

  assert.equal(observedCleanupGuard, true)
  assert.equal(competingOwner, false)
  assert.equal(result.error, undefined)
  assert.equal(fs.files.has(`${lockPath}.cleanup`), false)
})

test('acquireLock recovers a dead cleanup guard before retrying the lock', () => {
  const lockPath = '/state/sync.lock'
  const fs = memoryRuntime({
    [lockPath]: JSON.stringify({ pid: 300, token: 'stale' }),
    [`${lockPath}.cleanup`]: JSON.stringify({ pid: 300, token: 'abandoned-cleanup' })
  })
  const runtime = {
    ...fs,
    now: () => Date.parse('2026-07-18T10:00:00.000Z'),
    process: {
      pid: 301,
      kill: (pid) => {
        if (pid === 300) {
          const error = new Error('ESRCH')
          error.code = 'ESRCH'
          throw error
        }
        return true
      }
    }
  }

  const owner = acquireLock(lockPath, runtime)

  assert.notEqual(owner, false)
  assert.equal(fs.files.has(`${lockPath}.cleanup`), false)
  assert.equal(lockHasToken(lockPath, owner.token, runtime), true)
})

test('coordinator reacquires a stale lock even if the file is recreated during cleanup', () => {
  const fs = memoryRuntime({
    '/state/sync.lock': JSON.stringify({ pid: 300, startedAt: '2026-05-22T10:00:00.000Z' })
  })
  let recreated = false
  const result = coordinatedSync({ kind: 'notify', source: 'codex' }, {
    ...fs,
    stateDir: '/state',
    process: {
      pid: 301,
      kill: (pid) => {
        if (pid === 300 || pid === 302) {
          const error = new Error('ESRCH')
          error.code = 'ESRCH'
          throw error
        }
        return true
      }
    },
    unlink: (path) => {
      if (path.startsWith('/state/sync.lock.release-')) {
        fs.unlink(path)
        if (!recreated) {
          recreated = true
          fs.writeFile('/state/sync.lock', JSON.stringify({ pid: 302, startedAt: '2026-05-22T10:00:01.000Z' }))
        }
        return
      }
      fs.unlink(path)
    },
    executeSync: () => ({ ok: true })
  })

  assert.equal(result.skippedSync, false)
  assert.equal(result.error, undefined)
  assert.equal(fs.files.get('/state/sync.lock'), undefined)
})

test('coordinator recovers a stale lock through tasklist on legacy Windows Node', () => {
  const fs = memoryRuntime({
    '/state/sync.lock': JSON.stringify({ pid: 300, startedAt: '2026-05-22T10:00:00.000Z' })
  })
  let tasklistCalls = 0
  const result = coordinatedSync({ kind: 'notify', source: 'codex' }, {
    ...fs,
    stateDir: '/state',
    process: fakeProcess(301),
    platform: 'win32',
    nodeVersion: '22.12.0',
    runTasklist: () => {
      tasklistCalls += 1
      return { status: 0, stdout: 'INFO: no matching process\r\n' }
    },
    executeSync: () => ({ ok: true })
  })

  assert.equal(result.error, undefined)
  assert.equal(tasklistCalls, 1)
  assert.equal(fs.files.has('/state/sync.lock'), false)
})
