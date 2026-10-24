import { randomBytes } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const scheduledSyncStateFileName = 'scheduled-sync-state.json'
export const scheduledSyncStateSchemaVersion = 'tokenboard-scheduled-sync/v1'

const scheduledSyncStatuses = new Set(['running', 'success', 'failed', 'deferred'])

export function scheduledSyncStatePath(stateDir, source = 'all') {
  if (typeof stateDir !== 'string' || !stateDir.trim()) {
    throw new Error('TokenBoard scheduled sync state directory is required')
  }
  const normalizedSource = readRequiredString(source, 'TokenBoard scheduled sync source is required')
  if (normalizedSource === 'all') return join(stateDir, scheduledSyncStateFileName)
  return join(stateDir, `scheduled-sync-state.${encodeURIComponent(normalizedSource)}.json`)
}

export function writeScheduledSyncState(input, providedRuntime) {
  const stateDir = readRequiredString(input?.stateDir, 'TokenBoard scheduled sync state directory is required')
  const source = readRequiredString(input?.source, 'TokenBoard scheduled sync source is required')
  const status = input?.status
  if (!scheduledSyncStatuses.has(status)) {
    throw new Error(`Invalid TokenBoard scheduled sync status: ${String(status)}`)
  }
  const updatedAt = canonicalTimestamp(input?.updatedAt ?? Date.now(), 'updatedAt')
  const startedAt = canonicalTimestamp(input?.startedAt ?? updatedAt, 'startedAt')
  const completedAt =
    input?.completedAt === undefined ? undefined : canonicalTimestamp(input.completedAt, 'completedAt')
  const runtime = providedRuntime || productionRuntime()
  const path = scheduledSyncStatePath(stateDir, source)
  const state = {
    schemaVersion: scheduledSyncStateSchemaVersion,
    source,
    status,
    startedAt,
    updatedAt,
    ...(completedAt ? { completedAt } : {}),
    ...(input?.exitCode === undefined ? {} : { exitCode: canonicalExitCode(input.exitCode) }),
    ...(typeof input?.error === 'string' && input.error.trim() ? { error: input.error } : {})
  }

  ensurePrivateStateDir(runtime, stateDir)
  const temporaryPath = `${path}.tmp-${runtime.pid ?? process.pid}-${randomBytes(8).toString('hex')}`
  try {
    runtime.writeFile(temporaryPath, `${JSON.stringify(state)}\n`, { flag: 'wx', mode: 0o600 })
    runtime.rename(temporaryPath, path)
  } catch (error) {
    try {
      runtime.unlink(temporaryPath)
    } catch (cleanupError) {
      if (cleanupError?.code !== 'ENOENT') {
        throw new AggregateError([error, cleanupError], 'TokenBoard scheduled sync state cleanup failed')
      }
    }
    throw error
  }
  return state
}

export function readScheduledSyncState(path, providedRuntime) {
  const runtime = providedRuntime || productionRuntime()
  let value
  try {
    value = JSON.parse(runtime.readFile(path))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    if (error instanceof SyntaxError) return { status: 'invalid' }
    throw error
  }
  return isScheduledSyncState(value) ? value : { status: 'invalid' }
}

export function isScheduledSyncState(value) {
  return (
    value &&
    typeof value === 'object' &&
    value.schemaVersion === scheduledSyncStateSchemaVersion &&
    typeof value.source === 'string' &&
    value.source.trim().length > 0 &&
    scheduledSyncStatuses.has(value.status) &&
    isIsoTimestamp(value.startedAt) &&
    isIsoTimestamp(value.updatedAt) &&
    (value.completedAt === undefined || isIsoTimestamp(value.completedAt)) &&
    (value.exitCode === undefined || Number.isSafeInteger(value.exitCode)) &&
    (value.error === undefined || (typeof value.error === 'string' && value.error.length > 0))
  )
}

function ensurePrivateStateDir(runtime, stateDir) {
  if (typeof runtime.mkdir !== 'function' || typeof runtime.chmod !== 'function') {
    throw new Error('TokenBoard scheduled sync state directory setup requires mkdir and chmod operations')
  }
  if (typeof runtime.lstat === 'function') {
    const before = inspectDirectory(runtime.lstat, stateDir)
    if (before?.isSymbolicLink?.()) {
      throw new Error(`TokenBoard scheduled sync state directory must not be a symbolic link: ${stateDir}`)
    }
  }
  runtime.mkdir(stateDir, { recursive: true, mode: 0o700 })
  if (typeof runtime.lstat === 'function') {
    const after = inspectDirectory(runtime.lstat, stateDir)
    if (after?.isSymbolicLink?.()) {
      throw new Error(`TokenBoard scheduled sync state directory must not be a symbolic link: ${stateDir}`)
    }
    if (after && typeof after.isDirectory === 'function' && !after.isDirectory()) {
      throw new Error(`TokenBoard scheduled sync state path is not a directory: ${stateDir}`)
    }
  }
  runtime.chmod(stateDir, 0o700)
}

function inspectDirectory(lstat, stateDir) {
  try {
    return lstat(stateDir)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function productionRuntime() {
  return {
    pid: process.pid,
    chmod: chmodSync,
    lstat: lstatSync,
    mkdir: mkdirSync,
    readFile: (path) => readFileSync(path, 'utf8'),
    rename: renameSync,
    unlink: unlinkSync,
    writeFile: writeFileSync
  }
}

// A process exit code is 0-255, which is the range `readExitCode` in scheduled-retry.mjs
// already enforces on the same value as it travels back from the retry loop. Validating it
// here keeps the two sides of that contract consistent, and follows this module's existing
// treatment of `status`: an out-of-contract value throws rather than being written or
// silently dropped. A dropped exit code would read as "no exit code recorded", which is
// indistinguishable from a run that never finished.
function canonicalExitCode(value) {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new Error(`Invalid TokenBoard scheduled sync exit code: ${String(value)}`)
  }
  return value
}

function readRequiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(label)
  return value.trim()
}

function canonicalTimestamp(value, label) {
  const timestamp =
    typeof value === 'number' ? new Date(value) : value instanceof Date ? new Date(value.getTime()) : new Date(value)
  if (!Number.isFinite(timestamp.getTime())) throw new Error(`Invalid TokenBoard scheduled sync ${label}`)
  return timestamp.toISOString()
}

function isIsoTimestamp(value) {
  if (typeof value !== 'string') return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}
