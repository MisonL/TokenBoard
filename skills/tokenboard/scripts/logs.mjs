import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const scheduledLogFiles = ['daily-sync.out.log', 'daily-sync.err.log']
export const defaultMaxLogBytes = 1024 * 1024
export const defaultRetentionDays = 7

export function createScheduledLogRuntime({
  env = process.env,
  homeDir,
  now = new Date(),
  scheduled = false
}) {
  if (!shouldManageScheduledLogs(env, scheduled)) {
    return null
  }

  const logDir = env.TOKENBOARD_LOG_DIR || join(homeDir, '.tokenboard', 'logs')
  rotateScheduledLogs({ logDir, now })
  mkdirSync(logDir, { recursive: true })

  return {
    logDir,
    stdoutFd: openSync(join(logDir, 'daily-sync.out.log'), 'a'),
    stderrFd: openSync(join(logDir, 'daily-sync.err.log'), 'a')
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
  retentionDays = readPositiveInt(process.env.TOKENBOARD_LOG_RETENTION_DAYS, defaultRetentionDays)
}) {
  mkdirSync(logDir, { recursive: true })
  const timestamp = formatTimestamp(now)

  for (const fileName of scheduledLogFiles) {
    const filePath = join(logDir, fileName)
    if (existsSync(filePath) && statSync(filePath).size > maxBytes) {
      const rotatedPath = nextRotatedPath(logDir, `${fileName}.${timestamp}`)
      renameSync(filePath, rotatedPath)
      trimFileToLastBytes(rotatedPath, maxBytes)
      writeFileSync(filePath, '')
    }
  }

  removeExpiredRotatedLogs({ logDir, now, retentionDays })
}

function nextRotatedPath(logDir, baseName) {
  let candidate = join(logDir, baseName)
  let index = 1
  while (existsSync(candidate)) {
    candidate = join(logDir, `${baseName}.${index}`)
    index += 1
  }
  return candidate
}

function trimFileToLastBytes(filePath, maxBytes) {
  const content = readFileSync(filePath)
  if (content.byteLength <= maxBytes) {
    return
  }

  writeFileSync(filePath, content.subarray(content.byteLength - maxBytes))
}

function removeExpiredRotatedLogs({ logDir, now, retentionDays }) {
  const cutoffMs = now.getTime() - retentionDays * 24 * 60 * 60 * 1000

  for (const entry of readdirSync(logDir)) {
    if (!isRotatedLogName(entry)) {
      continue
    }

    const filePath = join(logDir, entry)
    if (statSync(filePath).mtime.getTime() < cutoffMs) {
      unlinkSync(filePath)
    }
  }
}

function shouldManageScheduledLogs(env, scheduled) {
  return scheduled ||
    env.TOKENBOARD_SCHEDULED_SYNC === '1' ||
    env.XPC_SERVICE_NAME === 'com.tokenboard.daily-sync' ||
    Boolean(env.INVOCATION_ID)
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
