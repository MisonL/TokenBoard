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
const lockRetryDelayMs = 10
const orphanLockGraceMs = 250
const lockRetryCount = Math.ceil(orphanLockGraceMs / lockRetryDelayMs) + 2

export function appendBoundedStatuslineEvent(filePath, value, maxBytes) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
  const lockPath = `${filePath}.lock`
  acquireLock(lockPath)
  try {
    appendWithinLock(filePath, value, maxBytes)
  } finally {
    releaseLock(lockPath)
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
      writeLockOwner(lockPath)
      return
    } catch (error) {
      if (!isLockExistsError(error)) throw error
      recoverOrphanedLock(lockPath)
      sleep(lockRetryDelayMs)
    }
  }
  throw new Error('Timed out waiting for Antigravity statusline log lock')
}

function writeLockOwner(lockPath) {
  try {
    writeFileSync(join(lockPath, 'pid'), String(process.pid), { mode: 0o600 })
  } catch (error) {
    try {
      rmSync(lockPath, { recursive: true, force: true })
    } catch {}
    throw error
  }
}

function releaseLock(lockPath) {
  try {
    rmSync(lockPath, { recursive: true, force: true })
  } catch (error) {
    if (existsSync(lockPath)) throw error
  }
}

function isLockExistsError(error) {
  return error && typeof error === 'object' && error.code === 'EEXIST'
}

function recoverOrphanedLock(lockPath) {
  const pidPath = join(lockPath, 'pid')
  try {
    const pid = Number.parseInt(readFileSync(pidPath, 'utf8'), 10)
    if (Number.isSafeInteger(pid) && pid > 0 && isProcessAlive(pid)) return
  } catch {
    try {
      if (Date.now() - statSync(lockPath).mtimeMs < orphanLockGraceMs) return
    } catch {
      return
    }
  }
  rmSync(lockPath, { recursive: true, force: true })
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error && typeof error === 'object' && error.code === 'EPERM'
  }
}

function sleep(milliseconds) {
  const deadline = Date.now() + milliseconds
  while (Date.now() < deadline) {}
}
