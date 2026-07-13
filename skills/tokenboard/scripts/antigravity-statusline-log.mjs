import { randomBytes } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { probeProcessLiveness, supportsReliableSignalZero } from './process-liveness.mjs'

export { supportsReliableSignalZero } from './process-liveness.mjs'

const logSchemaVersion = 'antigravity-statusline-log/v1'
const lockRetryDelayMs = 20
const lockWaitTimeoutMs = 2_000
const orphanLockGraceMs = 500
const sleepState = new Int32Array(new SharedArrayBuffer(4))

export function appendBoundedStatuslineEvent(filePath, value, maxBytes) {
  appendBoundedJsonLine(filePath, value, maxBytes, buildUsageLogHeader)
}

export function appendBoundedStatuslineError(filePath, value, maxBytes) {
  appendBoundedJsonLine(filePath, value, maxBytes)
}

function appendBoundedJsonLine(filePath, value, maxBytes, buildHeader) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
  const lockPath = `${filePath}.lock`
  const lease = acquireLock(lockPath)
  try {
    appendWithinLock(filePath, value, maxBytes, buildHeader)
  } finally {
    releaseLock(lease)
  }
}

function appendWithinLock(filePath, value, maxBytes, buildHeader) {
  const line = `${JSON.stringify(value)}\n`
  const currentSize = readFileSize(filePath)
  if (currentSize + Buffer.byteLength(line) <= maxBytes) {
    appendFileSync(filePath, line, { mode: 0o600 })
    chmodSync(filePath, 0o600)
    return
  }
  compactJsonl(filePath, line, maxBytes, currentSize, buildHeader?.() ?? '')
}

function buildUsageLogHeader() {
  return `${JSON.stringify({
    schemaVersion: logSchemaVersion,
    generation: randomBytes(16).toString('hex')
  })}\n`
}

function compactJsonl(filePath, line, maxBytes, currentSize, header) {
  const availableBytes = maxBytes - Buffer.byteLength(header) - Buffer.byteLength(line)
  if (availableBytes < 0) {
    throw new Error('Antigravity statusline log limit is too small for one event')
  }
  const content = `${header}${readCompleteLogTail(filePath, currentSize, availableBytes)}${line}`
  const tempPath = `${filePath}.tmp-${process.pid}`
  writeFileSync(tempPath, content, { mode: 0o600 })
  renameSync(tempPath, filePath)
  chmodSync(filePath, 0o600)
}

function readCompleteLogTail(filePath, currentSize, maxBytes) {
  if (currentSize === 0 || maxBytes === 0) return ''
  const bytesToRead = Math.min(currentSize, maxBytes)
  const start = currentSize - bytesToRead
  const buffer = Buffer.alloc(bytesToRead)
  const file = openSync(filePath, 'r')
  try {
    readSync(file, buffer, 0, bytesToRead, start)
  } finally {
    closeSync(file)
  }
  let text = buffer.toString('utf8')
  if (start > 0) {
    const firstNewline = text.indexOf('\n')
    text = firstNewline === -1 ? '' : text.slice(firstNewline + 1)
  }
  const lines = text.split('\n').filter((item) => item && !isLogHeader(item))
  while (Buffer.byteLength(`${lines.join('\n')}${lines.length ? '\n' : ''}`) > maxBytes) {
    lines.shift()
  }
  return lines.length ? `${lines.join('\n')}\n` : ''
}

function isLogHeader(line) {
  try {
    return JSON.parse(line)?.schemaVersion === logSchemaVersion
  } catch {
    return false
  }
}

function readFileSize(filePath) {
  try {
    return statSync(filePath).size
  } catch (error) {
    if (error && error.code === 'ENOENT') return 0
    throw error
  }
}

function acquireLock(lockPath) {
  const deadline = Date.now() + lockWaitTimeoutMs
  while (Date.now() < deadline) {
    const pendingPath = `${lockPath}.pending-${process.pid}-${randomBytes(8).toString('hex')}`
    try {
      mkdirSync(pendingPath, { mode: 0o700 })
      writeFileSync(join(pendingPath, 'pid'), String(process.pid), { flag: 'wx', mode: 0o600 })
      const identity = readLockIdentity(pendingPath)
      renameSync(pendingPath, lockPath)
      return { lockPath, identity }
    } catch (error) {
      rmSync(pendingPath, { recursive: true, force: true })
      if (!isLockExistsError(error, lockPath)) throw error
      recoverOrphanedLock(lockPath)
      sleep(lockRetryDelayMs)
    }
  }
  throw new Error('Timed out waiting for Antigravity statusline log lock')
}

function releaseLock(lease) {
  if (!sameLockIdentity(lease.lockPath, lease.identity)) {
    throw new Error('Antigravity statusline log lock ownership changed')
  }
  const pid = readLockPid(lease.lockPath)
  if (pid !== process.pid) {
    throw new Error('Antigravity statusline log lock owner changed')
  }
  removeLockWithIdentity(lease.lockPath, lease.identity)
}

function isLockExistsError(error, lockPath) {
  if (!error || typeof error !== 'object') return false
  if (error.code === 'EEXIST' || error.code === 'ENOTEMPTY') return true
  return error.code === 'EPERM' && existsSync(lockPath)
}

function recoverOrphanedLock(lockPath) {
  const identity = readLockIdentityOrNull(lockPath)
  if (!identity) return
  const ageMs = readLockAgeMs(lockPath)
  if (ageMs === null) return
  const pid = readLockPid(lockPath)
  if (pid === null) {
    if (ageMs < orphanLockGraceMs) return
    removeLockWithIdentity(lockPath, identity)
    return
  }
  const liveness = probeProcessLiveness(pid)
  if (liveness !== 'dead') return
  removeLockWithIdentity(lockPath, identity)
}

function readLockPid(lockPath) {
  try {
    const raw = readFileSync(join(lockPath, 'pid'), 'utf8').trim()
    if (!/^\d+$/.test(raw)) return null
    const pid = Number(raw)
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function readLockIdentity(lockPath) {
  const stats = statSync(lockPath, { bigint: true })
  return { dev: stats.dev, ino: stats.ino }
}

function readLockIdentityOrNull(lockPath) {
  try {
    return readLockIdentity(lockPath)
  } catch {
    return null
  }
}

function sameLockIdentity(lockPath, expected) {
  const current = readLockIdentityOrNull(lockPath)
  return current !== null && current.dev === expected.dev && current.ino === expected.ino
}

function removeLockWithIdentity(lockPath, identity) {
  if (!sameLockIdentity(lockPath, identity)) return
  const quarantinePath = `${lockPath}.stale-${process.pid}-${randomBytes(8).toString('hex')}`
  try {
    renameSync(lockPath, quarantinePath)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  if (!sameLockIdentity(quarantinePath, identity)) {
    restoreQuarantinedLock(lockPath, quarantinePath)
    return
  }
  rmSync(quarantinePath, { recursive: true, force: true })
}

function restoreQuarantinedLock(lockPath, quarantinePath) {
  try {
    renameSync(quarantinePath, lockPath)
  } catch (error) {
    throw new Error('Antigravity statusline replacement lock could not be restored', { cause: error })
  }
}

function readLockAgeMs(lockPath) {
  try {
    return Math.max(0, Date.now() - statSync(lockPath).mtimeMs)
  } catch {
    return null
  }
}

function sleep(milliseconds) {
  Atomics.wait(sleepState, 0, 0, milliseconds)
}
