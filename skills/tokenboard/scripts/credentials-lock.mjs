import { randomBytes } from 'node:crypto'
import {
  closeSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { isProcessAlive } from './process-liveness.mjs'

const lockRetryDelayMs = 20
const lockWaitTimeoutMs = 2_000
const malformedLockGraceMs = 500
const lockMaxLeaseMs = 120_000
const sleepState = new Int32Array(new SharedArrayBuffer(4))

export function credentialsLockPath(root) {
  return join(root, 'device-link.json.lock')
}

export function withCredentialsLock(root, callback) {
  const lockPath = credentialsLockPath(root)
  const owner = acquireCredentialsLock(lockPath)
  let callbackFailed = false
  try {
    return callback()
  } catch (error) {
    callbackFailed = true
    throw error
  } finally {
    try {
      releaseCredentialsLock(lockPath, owner)
    } catch (error) {
      if (!callbackFailed) throw error
    }
  }
}

function acquireCredentialsLock(lockPath) {
  const deadline = Date.now() + lockWaitTimeoutMs
  while (Date.now() < deadline) {
    const owner = { pid: process.pid, token: randomBytes(16).toString('hex') }
    let file = null
    let created = false
    try {
      file = openSync(lockPath, 'wx', 0o600)
      created = true
      try {
        writeFileSync(file, JSON.stringify(owner))
      } finally {
        closeSync(file)
        file = null
      }
      return owner
    } catch (error) {
      if (file !== null) closeSync(file)
      if (!isFileExistsError(error)) {
        if (created) rmSync(lockPath, { force: true })
        throw error
      }
      recoverCredentialsLock(lockPath)
      sleep(lockRetryDelayMs)
    }
  }
  throw new Error('Timed out waiting for TokenBoard credentials lock')
}

function releaseCredentialsLock(lockPath, owner) {
  const identity = readLockIdentity(lockPath)
  if (!identity || !sameLockOwner(lockPath, owner)) {
    throw new Error('TokenBoard credentials lock ownership changed')
  }
  removeCredentialsLock(lockPath, identity, owner)
}

function recoverCredentialsLock(lockPath) {
  const identity = readLockIdentity(lockPath)
  if (!identity) return
  const owner = readLockOwner(lockPath)
  const ageMs = readLockAgeMs(lockPath)
  if (!owner) {
    if (ageMs < malformedLockGraceMs) return
    removeCredentialsLock(lockPath, identity)
    return
  }
  if (isProcessAlive(owner.pid) && ageMs < lockMaxLeaseMs) return
  removeCredentialsLock(lockPath, identity, owner)
}

function removeCredentialsLock(lockPath, identity, owner) {
  if (!sameLockIdentity(lockPath, identity)) return
  if (owner && !sameLockOwner(lockPath, owner)) return
  const quarantinePath = `${lockPath}.stale-${process.pid}-${randomBytes(8).toString('hex')}`
  try {
    renameSync(lockPath, quarantinePath)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  if (!sameLockIdentity(quarantinePath, identity) ||
      (owner && !sameLockOwner(quarantinePath, owner))) {
    restoreCredentialsLock(lockPath, quarantinePath)
    return
  }
  rmSync(quarantinePath, { force: true })
}

export function restoreCredentialsLock(lockPath, quarantinePath) {
  try {
    linkSync(quarantinePath, lockPath)
  } catch (error) {
    if (isFileExistsError(error)) {
      rmSync(quarantinePath, { force: true })
      return
    }
    throw new Error('TokenBoard replacement credentials lock could not be restored', { cause: error })
  }
  rmSync(quarantinePath, { force: true })
}

function readLockOwner(lockPath) {
  try {
    const owner = JSON.parse(readFileSync(lockPath, 'utf8'))
    if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) return null
    if (typeof owner.token !== 'string' || !owner.token) return null
    return owner
  } catch {
    return null
  }
}

function sameLockOwner(lockPath, expected) {
  const current = readLockOwner(lockPath)
  return current?.pid === expected.pid && current.token === expected.token
}

function readLockIdentity(lockPath) {
  try {
    const stats = statSync(lockPath, { bigint: true })
    return { dev: stats.dev, ino: stats.ino }
  } catch {
    return null
  }
}

function sameLockIdentity(lockPath, expected) {
  const current = readLockIdentity(lockPath)
  return current?.dev === expected.dev && current.ino === expected.ino
}

function readLockAgeMs(lockPath) {
  try {
    return Math.max(0, Date.now() - statSync(lockPath).mtimeMs)
  } catch {
    return 0
  }
}

function isFileExistsError(error) {
  return error?.code === 'EEXIST'
}

function sleep(milliseconds) {
  Atomics.wait(sleepState, 0, 0, milliseconds)
}
