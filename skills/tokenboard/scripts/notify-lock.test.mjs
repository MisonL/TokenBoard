import assert from 'node:assert/strict'
import test from 'node:test'
import { runNotify } from './notify.mjs'

test('notify retains its own trailing lock without recursive scheduling', () => {
  const files = new Map([
    ['/state/last-success.json', '2026-05-22T10:00:00.000Z'],
    ['/state/trailing.lock', JSON.stringify({ pid: 900 })]
  ])

  const result = runNotify({
    argv: ['--source', 'codex'],
    stateDir: '/state',
    ...atomicMemoryFileOps(files),
    now: () => Date.parse('2026-05-22T10:01:00.000Z'),
    mkdir: () => {},
    exists: (path) => files.has(path),
    readFile: (path) => files.get(path) || '',
    writeFile: (path, value, options = {}) => {
      if (options.flag === 'wx' && files.has(path)) {
        const error = new Error('EEXIST')
        error.code = 'EEXIST'
        throw error
      }
      files.set(path, String(value))
    },
    unlink: () => {},
    process: {
      pid: 900,
      kill: () => true
    },
    executeSync: () => {
      throw new Error('should not run')
    }
  })

  assert.equal(result.error, undefined)
  assert.equal(result.skippedReason, 'cooldown')
  assert.equal(result.trailingScheduled, true)
  assert.equal(JSON.parse(files.get('/state/trailing.lock')).pid, 900)
})

test('notify reports trailing lock cleanup failures after spawn errors', () => {
  const files = new Map([
    ['/state/last-success.json', '2026-05-22T10:00:00.000Z']
  ])
  let failedCleanup = false

  const result = runNotify({
    argv: ['--source', 'codex'],
    stateDir: '/state',
    ...atomicMemoryFileOps(files),
    now: () => Date.parse('2026-05-22T10:01:00.000Z'),
    mkdir: () => {},
    exists: (path) => files.has(path),
    readFile: (path) => files.get(path) || '',
    writeFile: (path, value, options = {}) => {
      if (options.flag === 'wx' && files.has(path)) {
        const error = new Error('EEXIST')
        error.code = 'EEXIST'
        throw error
      }
      files.set(path, String(value))
    },
    unlink: (path) => {
      if (path.startsWith('/state/trailing.lock.release-') && !failedCleanup) {
        failedCleanup = true
        const error = new Error('EPERM')
        error.code = 'EPERM'
        throw error
      }
      files.delete(path)
    },
    process: {
      pid: 901,
      kill: () => true
    },
    spawnDetached: () => {
      throw new Error('spawn failed')
    },
    executeSync: () => {
      throw new Error('should not run')
    }
  })

  assert.match(result.error, /spawn failed/)
  assert.match(result.error, /trailing lock cleanup failed: EPERM/)
})

test('notify preserves diagnostics when spawn and cleanup errors have empty messages', () => {
  const files = new Map([
    ['/state/last-success.json', '2026-05-22T10:00:00.000Z']
  ])
  let failedCleanup = false

  const result = runNotify({
    argv: ['--source', 'codex'],
    stateDir: '/state',
    ...atomicMemoryFileOps(files),
    now: () => Date.parse('2026-05-22T10:01:00.000Z'),
    mkdir: () => {},
    exists: (path) => files.has(path),
    readFile: (path) => files.get(path) || '',
    writeFile: (path, value) => files.set(path, String(value)),
    unlink: (path) => {
      if (path.startsWith('/state/trailing.lock.release-') && !failedCleanup) {
        failedCleanup = true
        throw new Error('')
      }
      files.delete(path)
    },
    process: {
      pid: 904,
      kill: () => true
    },
    spawnDetached: () => {
      throw new Error('')
    },
    executeSync: () => {
      throw new Error('should not run')
    }
  })

  assert.equal(result.error, 'Error; trailing lock cleanup failed: Error')
})

test('notify reports trailing lock ownership read failures', () => {
  const files = new Map([
    ['/state/last-success.json', '2026-05-22T10:00:00.000Z'],
    ['/state/trailing.lock', JSON.stringify({ pid: 902 })]
  ])

  const result = runNotify({
    argv: ['--source', 'codex'],
    stateDir: '/state',
    ...atomicMemoryFileOps(files),
    now: () => Date.parse('2026-05-22T10:01:00.000Z'),
    mkdir: () => {},
    exists: (path) => files.has(path),
    readFile: (path) => {
      if (path === '/state/trailing.lock') {
        const error = new Error('EACCES')
        error.code = 'EACCES'
        throw error
      }
      return files.get(path) || ''
    },
    writeFile: (path, value, options = {}) => {
      if (options.flag === 'wx' && files.has(path)) {
        const error = new Error('EEXIST')
        error.code = 'EEXIST'
        throw error
      }
      files.set(path, String(value))
    },
    unlink: (path) => files.delete(path),
    process: {
      pid: 903,
      kill: () => true
    },
    executeSync: () => {
      throw new Error('should not run')
    }
  })

  assert.equal(result.error, 'EACCES')
  assert.equal(files.has('/state/trailing.lock'), true)
})

test('notify recovers a stale trailing lock through tasklist on legacy Windows Node', () => {
  const files = new Map([
    ['/state/last-success.json', '2026-05-22T10:00:00.000Z'],
    ['/state/trailing.lock', JSON.stringify({ pid: 900 })]
  ])
  const spawned = []
  let tasklistCalls = 0
  const result = runNotify({
    argv: ['--source', 'codex'],
    stateDir: '/state',
    ...atomicMemoryFileOps(files),
    now: () => Date.parse('2026-05-22T10:01:00.000Z'),
    mkdir: () => {},
    exists: (path) => files.has(path),
    readFile: (path) => files.get(path) || '',
    writeFile: (path, value, options = {}) => {
      if (options.flag === 'wx' && files.has(path)) {
        const error = new Error('EEXIST')
        error.code = 'EEXIST'
        throw error
      }
      files.set(path, String(value))
    },
    unlink: (path) => files.delete(path),
    process: { pid: 901, kill: () => true },
    platform: 'win32',
    nodeVersion: '22.12.0',
    runTasklist: () => {
      tasklistCalls += 1
      return { status: 0, stdout: 'INFO: no matching process\r\n' }
    },
    spawnDetached: () => {
      spawned.push('spawned')
      return { pid: 902, unref: () => {} }
    },
    executeSync: () => {
      throw new Error('should not run')
    }
  })

  assert.equal(result.trailingScheduled, true)
  assert.equal(tasklistCalls, 1)
  assert.deepEqual(spawned, ['spawned'])
  assert.equal(JSON.parse(files.get('/state/trailing.lock')).pid, 902)
})

test('notify retries trailing lock acquisition when its owner releases the lock after EEXIST', () => {
  const files = new Map([
    ['/state/last-success.json', '2026-05-22T10:00:00.000Z']
  ])
  let firstTrailingLockWrite = true
  const trailingLockAcquireFlags = []
  const spawned = []
  const result = runNotify({
    argv: ['--source', 'codex'],
    stateDir: '/state',
    ...atomicMemoryFileOps(files),
    now: () => Date.parse('2026-05-22T10:01:00.000Z'),
    mkdir: () => {},
    exists: (path) => files.has(path),
    readFile: (path) => {
      const value = files.get(path)
      if (value !== undefined) return value
      const error = new Error(`ENOENT: ${path}`)
      error.code = 'ENOENT'
      throw error
    },
    writeFile: (path, value, options = {}) => {
      if (path === '/state/trailing.lock' && options.flag === 'wx') {
        trailingLockAcquireFlags.push(options.flag)
      }
      if (path === '/state/trailing.lock' && options.flag === 'wx' && firstTrailingLockWrite) {
        firstTrailingLockWrite = false
        const error = new Error('EEXIST')
        error.code = 'EEXIST'
        throw error
      }
      if (options.flag === 'wx' && files.has(path)) {
        const error = new Error('EEXIST')
        error.code = 'EEXIST'
        throw error
      }
      files.set(path, String(value))
    },
    unlink: (path) => files.delete(path),
    process: { pid: 903, kill: () => true },
    spawnDetached: () => {
      spawned.push('spawned')
      return { pid: 904, unref: () => {} }
    },
    executeSync: () => {
      throw new Error('should not run')
    }
  })

  assert.equal(result.error, undefined)
  assert.equal(result.trailingScheduled, true)
  assert.deepEqual(trailingLockAcquireFlags, ['wx', 'wx'])
  assert.deepEqual(spawned, ['spawned'])
  assert.equal(JSON.parse(files.get('/state/trailing.lock')).pid, 904)
})

test('notify atomically publishes the trailing child process id without exposing partial JSON', () => {
  const lockPath = '/state/trailing.lock'
  const files = new Map([
    ['/state/last-success.json', '2026-05-22T10:00:00.000Z']
  ])
  const writes = []
  const result = runNotify({
    argv: ['--source', 'codex'],
    stateDir: '/state',
    ...atomicMemoryFileOps(files),
    now: () => Date.parse('2026-05-22T10:01:00.000Z'),
    mkdir: () => {},
    exists: (path) => files.has(path),
    readFile: (path) => {
      const value = files.get(path)
      if (value !== undefined) return value
      const error = new Error(`ENOENT: ${path}`)
      error.code = 'ENOENT'
      throw error
    },
    writeFile: (path, value, options = {}) => {
      writes.push({ path, options })
      if (options.flag === 'wx' && files.has(path)) {
        const error = new Error(`EEXIST: ${path}`)
        error.code = 'EEXIST'
        throw error
      }
      files.set(path, String(value))
      if (path !== lockPath && files.has(lockPath)) {
        assert.doesNotThrow(() => JSON.parse(files.get(lockPath)))
      }
    },
    rename: (from, to) => {
      if (to === lockPath) {
        assert.match(from, /^\/state\/trailing\.lock\.publish-/)
        assert.doesNotThrow(() => JSON.parse(files.get(from)))
        assert.doesNotThrow(() => JSON.parse(files.get(to)))
      }
      atomicMemoryFileOps(files).rename(from, to)
    },
    unlink: (path) => files.delete(path),
    process: { pid: 903, kill: () => true },
    spawnDetached: () => ({ pid: 904, unref: () => {} }),
    executeSync: () => {
      throw new Error('should not run')
    }
  })

  assert.equal(result.error, undefined)
  assert.equal(result.trailingScheduled, true)
  assert.equal(writes.filter(({ path }) => path === lockPath).every(({ options }) => options.flag === 'wx'), true)
  assert.equal(writes.some(({ path }) => path.startsWith(`${lockPath}.publish-`)), true)
  assert.deepEqual(JSON.parse(files.get(lockPath)), {
    pid: 904,
    startedAt: '2026-05-22T10:01:00.000Z'
  })
})

function atomicMemoryFileOps(files) {
  return {
    rename: (from, to) => {
      const value = files.get(from)
      if (value === undefined) {
        const error = new Error(`ENOENT: ${from}`)
        error.code = 'ENOENT'
        throw error
      }
      files.set(to, value)
      files.delete(from)
    },
    link: (from, to) => {
      const value = files.get(from)
      if (value === undefined) {
        const error = new Error(`ENOENT: ${from}`)
        error.code = 'ENOENT'
        throw error
      }
      if (files.has(to)) {
        const error = new Error(`EEXIST: ${to}`)
        error.code = 'EEXIST'
        throw error
      }
      files.set(to, value)
    }
  }
}
