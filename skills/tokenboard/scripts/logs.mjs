import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

export const scheduledLogFiles = ['daily-sync.out.log', 'daily-sync.err.log']
export const defaultMaxLogBytes = 1024 * 1024
export const defaultRetentionDays = 7
const defaultFileSystem = {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
}

export function createScheduledLogRuntime({ env = process.env, homeDir, now = new Date(), scheduled = false }) {
  if (!shouldManageScheduledLogs(env, scheduled)) {
    return null
  }

  const logDir = env.TOKENBOARD_LOG_DIR || join(homeDir, '.tokenboard', 'logs')
  rotateScheduledLogs({ logDir, now })
  mkdirSync(logDir, { recursive: true, mode: 0o700 })
  chmodSync(logDir, 0o700)
  const stdoutPath = join(logDir, 'daily-sync.out.log')
  const stderrPath = join(logDir, 'daily-sync.err.log')
  const stdoutFd = openSync(stdoutPath, 'a', 0o600)
  const stderrFd = openSync(stderrPath, 'a', 0o600)
  chmodSync(stdoutPath, 0o600)
  chmodSync(stderrPath, 0o600)

  return {
    logDir,
    stdoutFd,
    stderrFd
  }
}

export function closeScheduledLogRuntime(runtime, { now = new Date() } = {}) {
  if (!runtime) {
    return
  }

  closeSync(runtime.stdoutFd)
  closeSync(runtime.stderrFd)
  rotateScheduledLogs({ logDir: runtime.logDir, now })
}

export function rotateScheduledLogs({
  logDir,
  now = new Date(),
  maxBytes = readPositiveInt(process.env.TOKENBOARD_LOG_MAX_BYTES, defaultMaxLogBytes),
  retentionDays = readPositiveInt(process.env.TOKENBOARD_LOG_RETENTION_DAYS, defaultRetentionDays),
  fileSystem = defaultFileSystem
}) {
  fileSystem.mkdirSync(logDir, { recursive: true, mode: 0o700 })
  fileSystem.chmodSync?.(logDir, 0o700)
  const timestamp = formatTimestamp(now)

  for (const fileName of scheduledLogFiles) {
    const filePath = join(logDir, fileName)
    const fileSize = readExistingFileSize(fileSystem, filePath)
    if (fileSize > maxBytes) {
      const rotatedPath = nextRotatedPath(logDir, `${fileName}.${timestamp}`, fileSystem)
      if (!tryRename(fileSystem, filePath, rotatedPath)) {
        continue
      }
      trimFileToLastBytes(rotatedPath, maxBytes, fileSize, fileSystem)
      fileSystem.chmodSync?.(rotatedPath, 0o600)
      fileSystem.writeFileSync(filePath, '', { mode: 0o600 })
      fileSystem.chmodSync?.(filePath, 0o600)
    }
  }

  removeExpiredRotatedLogs({ logDir, now, retentionDays, fileSystem })
}

function nextRotatedPath(logDir, baseName, fileSystem) {
  let candidate = join(logDir, baseName)
  let index = 1
  while (fileSystem.existsSync(candidate)) {
    candidate = join(logDir, `${baseName}.${index}`)
    index += 1
  }
  return candidate
}

function trimFileToLastBytes(filePath, maxBytes, fileSize, fileSystem) {
  if (fileSize <= maxBytes) {
    return
  }

  const buffer = Buffer.alloc(maxBytes)
  const fd = fileSystem.openSync(filePath, 'r')
  try {
    const bytesRead = fileSystem.readSync(fd, buffer, 0, maxBytes, fileSize - maxBytes)
    fileSystem.writeFileSync(filePath, buffer.subarray(0, bytesRead))
  } finally {
    fileSystem.closeSync(fd)
  }
}

function removeExpiredRotatedLogs({ logDir, now, retentionDays, fileSystem }) {
  const cutoffMs = now.getTime() - retentionDays * 24 * 60 * 60 * 1000

  for (const entry of fileSystem.readdirSync(logDir)) {
    if (!isRotatedLogName(entry)) {
      continue
    }

    const filePath = join(logDir, entry)
    const fileStat = safeStat(fileSystem, filePath)
    if (fileStat && fileStat.mtime.getTime() < cutoffMs) {
      tryUnlink(fileSystem, filePath)
    }
  }
}

function readExistingFileSize(fileSystem, filePath) {
  const fileStat = safeStat(fileSystem, filePath)
  return fileStat?.size || 0
}

function safeStat(fileSystem, filePath) {
  try {
    return fileSystem.statSync(filePath)
  } catch (error) {
    if (isMissingFileError(error)) {
      return null
    }
    throw error
  }
}

function tryRename(fileSystem, source, target) {
  try {
    fileSystem.renameSync(source, target)
    return true
  } catch (error) {
    if (isMissingFileError(error)) {
      return false
    }
    throw error
  }
}

function tryUnlink(fileSystem, filePath) {
  try {
    fileSystem.unlinkSync(filePath)
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error
    }
  }
}

function isMissingFileError(error) {
  return error && typeof error === 'object' && error.code === 'ENOENT'
}

function shouldManageScheduledLogs(env, scheduled) {
  return (
    scheduled ||
    env.TOKENBOARD_SCHEDULED_SYNC === '1' ||
    env.XPC_SERVICE_NAME === 'com.tokenboard.daily-sync' ||
    Boolean(env.INVOCATION_ID)
  )
}

function isRotatedLogName(fileName) {
  return scheduledLogFiles.some((baseName) => fileName.startsWith(`${baseName}.`))
}

function readPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10)
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed
  }
  return fallback
}

function formatTimestamp(date) {
  const parts = [
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds()
  ]
  return parts.map((part) => String(part).padStart(2, '0')).join('')
}
