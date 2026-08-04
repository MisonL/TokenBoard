import { randomBytes } from 'node:crypto'
import { probeProcessLiveness } from './process-liveness.mjs'

const maxAcquireAttempts = 5
const activeLockOwners = new Set()
const activeCleanupOwners = new Set()

export function acquireLock(lockPath, runtime, options = {}) {
  const allowDirectoryFence = options.allowDirectoryFence === true
  for (let attempt = 0; attempt < maxAcquireAttempts; attempt += 1) {
    if (isLockCleanupInProgress(lockPath, runtime)) return false
    const owner = createLockOwner(runtime)
    try {
      runtime.writeFile(lockPath, lockPayload(owner), { flag: 'wx', mode: 0o600 })
      rememberLockOwner(lockPath, owner)
      return owner
    } catch (error) {
      if (error.code === 'EISDIR') {
        if (allowDirectoryFence) return false
        throw error
      }
      if (error.code !== 'EEXIST') throw error
      if (!removeStaleLock(lockPath, runtime, { allowDirectoryFence })) return false
    }
  }
  return null
}

export function waitForLock(lockPath, runtime, options = {}) {
  const started = runtime.now()
  let backoff = 100
  while (runtime.now() - started < runtime.lockTimeoutMs) {
    const owner = acquireLock(lockPath, runtime, options)
    if (owner) return { acquired: true, owner }
    runtime.sleep(backoff)
    backoff = Math.min(backoff * 2, 2000)
  }
  return { acquired: false, error: 'lock timeout' }
}

export function releaseLock(lockPath, runtime, owner = null, options = {}) {
  const record = readLockRecord(lockPath, runtime, options)
  if (!record) {
    forgetLockOwner(lockPath, owner)
    return false
  }
  if (record.directory) {
    forgetLockOwner(lockPath, owner)
    return false
  }
  if (owner && record.token !== owner.token) {
    forgetLockOwner(lockPath, owner)
    return false
  }
  if (record.pid !== null && record.pid !== runtime.process.pid) {
    forgetLockOwner(lockPath, owner)
    return false
  }
  const released = removeLockRecord(lockPath, record.raw, runtime, options)
  if (released) forgetLockOwner(lockPath, record)
  else forgetLockOwner(lockPath, owner)
  return released
}

export function lockHasToken(lockPath, token, runtime, options = {}) {
  if (typeof token !== 'string' || !token) return false
  const record = readLockRecord(lockPath, runtime, options)
  return record?.token === token
}

function createLockOwner(runtime) {
  const now = typeof runtime.now === 'function' ? runtime.now() : Date.now()
  return {
    pid: runtime.process.pid,
    startedAt: new Date(now).toISOString(),
    token: randomBytes(16).toString('hex')
  }
}

function rememberLockOwner(lockPath, owner) {
  if (owner?.token) activeLockOwners.add(lockOwnerKey(lockPath, owner.token))
}

function forgetLockOwner(lockPath, owner) {
  if (owner?.token) activeLockOwners.delete(lockOwnerKey(lockPath, owner.token))
}

function lockOwnerKey(lockPath, token) {
  return `${lockPath}\u0000${token}`
}

function lockPayload(owner) {
  return JSON.stringify({
    pid: owner.pid,
    startedAt: owner.startedAt,
    token: owner.token
  })
}

function removeStaleLock(lockPath, runtime, options = {}) {
  const record = readLockRecord(lockPath, runtime, options)
  if (!record) return true
  if (record.directory) return false
  if (!isLockRecordStale(lockPath, record, runtime)) return false
  const removed = removeLockRecord(lockPath, record.raw, runtime, options)
  if (removed) forgetLockOwner(lockPath, record)
  return removed
}

function removeLockRecord(lockPath, expectedRaw, runtime, options = {}) {
  if (typeof runtime.rename !== 'function' || typeof runtime.link !== 'function' || typeof runtime.writeFile !== 'function') {
    throw new Error('TokenBoard lock cleanup requires atomic rename and link operations')
  }

  const cleanupOwner = acquireLockCleanup(lockPath, runtime)
  if (!cleanupOwner) return false

  try {
    const current = readLockRecord(lockPath, runtime, options)
    if (!current || current.raw !== expectedRaw) return false
    return removeVerifiedLockRecord(lockPath, expectedRaw, runtime, options)
  } finally {
    releaseLockCleanup(lockPath, cleanupOwner, runtime)
  }
}

function removeVerifiedLockRecord(lockPath, expectedRaw, runtime, options = {}) {

  const quarantinePath = lockQuarantinePath(lockPath, runtime)
  try {
    runtime.rename(lockPath, quarantinePath)
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }

  let quarantined
  try {
    quarantined = readLockRecord(quarantinePath, runtime, options)
  } catch (error) {
    restoreLockRecord(lockPath, quarantinePath, runtime)
    throw error
  }
  if (!quarantined || quarantined.raw !== expectedRaw) {
    restoreLockRecord(lockPath, quarantinePath, runtime)
    return false
  }
  try {
    runtime.unlink(quarantinePath)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    restoreLockRecord(lockPath, quarantinePath, runtime)
    throw error
  }
}

function isLockCleanupInProgress(lockPath, runtime) {
  const guardPath = lockCleanupPath(lockPath)
  const guard = readLockCleanup(guardPath, runtime)
  if (!guard) return false
  if (isLockCleanupOwnerActive(guardPath, guard, runtime)) return true
  return !removeStaleLockCleanup(guardPath, guard.raw, runtime)
}

function acquireLockCleanup(lockPath, runtime) {
  const guardPath = lockCleanupPath(lockPath)
  for (let attempt = 0; attempt < maxAcquireAttempts; attempt += 1) {
    const owner = createLockOwner(runtime)
    try {
      runtime.writeFile(guardPath, lockPayload(owner), { flag: 'wx', mode: 0o600 })
      rememberCleanupOwner(guardPath, owner)
      return owner
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const existing = readLockCleanup(guardPath, runtime)
      if (!existing || isLockCleanupOwnerActive(guardPath, existing, runtime)) return null
      if (!removeStaleLockCleanup(guardPath, existing.raw, runtime)) return null
    }
  }
  return null
}

function releaseLockCleanup(lockPath, owner, runtime) {
  const guardPath = lockCleanupPath(lockPath)
  try {
    const current = readLockCleanup(guardPath, runtime)
    if (!current || current.token !== owner.token || current.pid !== runtime.process.pid) return false
    runtime.unlink(guardPath)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  } finally {
    forgetCleanupOwner(guardPath, owner)
  }
}

function removeStaleLockCleanup(guardPath, expectedRaw, runtime) {
  const current = readLockCleanup(guardPath, runtime)
  if (!current || current.raw !== expectedRaw) return false
  try {
    runtime.unlink(guardPath)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return true
    throw error
  }
}

function readLockCleanup(guardPath, runtime) {
  let raw
  try {
    raw = runtime.readFile(guardPath)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  const record = parseLockRecord(raw)
  return { raw, ...record }
}

function isLockCleanupOwnerActive(guardPath, record, runtime) {
  if (record.pid === null) return false
  if (record.pid === runtime.process.pid) {
    return Boolean(record.token && activeCleanupOwners.has(lockOwnerKey(guardPath, record.token)))
  }
  return probeProcessLiveness(record.pid, {
    platform: runtime.platform,
    nodeVersion: runtime.nodeVersion,
    kill: runtime.process.kill?.bind(runtime.process),
    runTasklist: runtime.runTasklist
  }) !== 'dead'
}

function rememberCleanupOwner(guardPath, owner) {
  if (owner?.token) activeCleanupOwners.add(lockOwnerKey(guardPath, owner.token))
}

function forgetCleanupOwner(guardPath, owner) {
  if (owner?.token) activeCleanupOwners.delete(lockOwnerKey(guardPath, owner.token))
}

function restoreLockRecord(lockPath, quarantinePath, runtime) {
  try {
    runtime.link(quarantinePath, lockPath)
  } catch (error) {
    if (error.code !== 'EEXIST' && error.code !== 'ENOENT') throw error
  }
  try {
    runtime.unlink(quarantinePath)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

function isLockRecordStale(lockPath, record, runtime) {
  const pid = record?.pid ?? null
  if (pid === null) return true
  if (pid === runtime.process.pid) {
    return !record.token || !activeLockOwners.has(lockOwnerKey(lockPath, record.token))
  }
  return probeProcessLiveness(pid, {
    platform: runtime.platform,
    nodeVersion: runtime.nodeVersion,
    kill: runtime.process.kill?.bind(runtime.process),
    runTasklist: runtime.runTasklist
  }) === 'dead'
}

function readLockRecord(lockPath, runtime, options = {}) {
  let raw
  try {
    raw = runtime.readFile(lockPath)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    if (error.code === 'EISDIR') {
      if (options.allowDirectoryFence === true) {
        return { directory: true, pid: null, token: null, raw: null }
      }
      throw error
    }
    throw error
  }
  return { raw, ...parseLockRecord(raw) }
}

function parseLockRecord(raw) {
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { pid: null, token: null }
    return {
      pid: typeof parsed.pid === 'number' ? parsed.pid : null,
      token: typeof parsed.token === 'string' ? parsed.token : null
    }
  } catch (error) {
    if (error instanceof SyntaxError) return { pid: null, token: null }
    throw error
  }
}

function lockQuarantinePath(lockPath, runtime) {
  const now = typeof runtime.now === 'function' ? runtime.now() : Date.now()
  return `${lockPath}.release-${runtime.process.pid}-${now}-${Math.random().toString(36).slice(2)}`
}

function lockCleanupPath(lockPath) {
  return `${lockPath}.cleanup`
}
