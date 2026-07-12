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

const logSchemaVersion = 'antigravity-statusline-log/v1'
const lockRetryDelayMs = 20
const lockWaitTimeoutMs = 2_000
const orphanLockGraceMs = 500
const lockRetryCount = Math.ceil(lockWaitTimeoutMs / lockRetryDelayMs) + 1
const sleepState = new Int32Array(new SharedArrayBuffer(4))

export function appendBoundedStatuslineEvent(filePath, value, maxBytes) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
  const lockPath = `${filePath}.lock`
  const lease = acquireLock(lockPath)
  try {
    appendWithinLock(filePath, value, maxBytes)
  } finally {
    releaseLock(lease)
  }
}

function appendWithinLock(filePath, value, maxBytes) {
  const line = `${JSON.stringify(value)}\n`
  const currentSize = readFileSize(filePath)
  if (currentSize + Buffer.byteLength(line) <= maxBytes) {
    appendFileSync(filePath, line, { mode: 0o600 })
    chmodSync(filePath, 0o600)
    return
  }
  compactUsageLog(filePath, line, maxBytes, currentSize)
}

function compactUsageLog(filePath, line, maxBytes, currentSize) {
  const header = `${JSON.stringify({
    schemaVersion: logSchemaVersion,
    generation: randomBytes(16).toString('hex')
  })}\n`
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
  for (let attempt = 0; attempt < lockRetryCount; attempt += 1) {
    try {
      mkdirSync(lockPath, { mode: 0o700 })
      const identity = readLockIdentity(lockPath)
      writeLockOwner(lockPath, identity)
      return { lockPath, identity }
    } catch (error) {
      if (!isLockExistsError(error)) throw error
      recoverOrphanedLock(lockPath)
      sleep(lockRetryDelayMs)
    }
  }
  throw new Error('Timed out waiting for Antigravity statusline log lock')
}

function writeLockOwner(lockPath, identity) {
  try {
    writeFileSync(join(lockPath, 'pid'), String(process.pid), { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (!isLockExistsError(error)) removeLockWithIdentity(lockPath, identity)
    throw error
  }
}

function releaseLock(lease) {
  if (!sameLockIdentity(lease.lockPath, lease.identity)) {
    throw new Error('Antigravity statusline log lock ownership changed')
  }
  const pid = readLockPid(lease.lockPath)
  if (pid !== process.pid) {
    throw new Error('Antigravity statusline log lock owner changed')
  }
  try {
    rmSync(lease.lockPath, { recursive: true, force: true })
  } catch (error) {
    if (existsSync(lease.lockPath)) throw error
  }
}

function isLockExistsError(error) {
  return error && typeof error === 'object' && error.code === 'EEXIST'
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
  if (isProcessAlive(pid)) return
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

function isProcessAlive(pid) {
  if (!supportsReliableSignalZero(process.platform, process.versions.node)) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error && typeof error === 'object' && error.code === 'EPERM'
  }
}

export function supportsReliableSignalZero(platform, nodeVersion) {
  if (platform !== 'win32') return true
  const [major, minor] = nodeVersion.split('.').map(Number)
  return major > 23 || (major === 22 && minor >= 16)
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
  try {
    rmSync(lockPath, { recursive: true, force: true })
  } catch (error) {
    if (sameLockIdentity(lockPath, identity)) throw error
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
