import { createHash, randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { UsageSnapshot, UsageSource } from '@tokenboard/usage-core'

export type CursorSnapshot = Omit<UsageSnapshot, 'collectedAt'>

export type CursorEntry = {
  size: number
  mtimeMs: number
  sha256: string
  snapshots: CursorSnapshot[]
  missingCost: boolean
  pendingUpload?: boolean
  updatedAt: string
}

export type CursorState = {
  version: 1
  source: UsageSource
  lastScanHighWaterMs?: number
  lastScanOffsetBytes?: number
  lastScanGeneration?: string
  files: Record<string, CursorEntry>
}

const cursorLockRetryMs = 25
const cursorLockTimeoutMs = 30_000
const cursorLockStaleMs = 30_000
const cursorLockHeartbeatMs = 5_000

export async function readCursor(cursorPath: string, source: UsageSource): Promise<CursorState> {
  const empty: CursorState = { version: 1, source, files: {} }
  try {
    const parsed = JSON.parse(await readFile(cursorPath, 'utf8')) as unknown
    if (isValidCursor(parsed, source)) return parsed
    throw new Error(`Invalid ${source} cursor file: ${cursorPath}`)
  } catch (error) {
    if (isMissingFileError(error)) {
      return empty
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid ${source} cursor JSON: ${cursorPath}`)
    }
    throw error
  }
}

function isMissingFileError(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

export async function writeCursor(cursorPath: string, cursor: CursorState) {
  await mkdir(dirname(cursorPath), { recursive: true })
  const tempPath = `${cursorPath}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`
  try {
    await writeFile(tempPath, `${JSON.stringify(cursor, null, 2)}\n`, { mode: 0o600 })
    await rename(tempPath, cursorPath)
  } catch (error) {
    await rm(tempPath, { force: true })
    throw error
  }
}

export async function withCursorLock<T>(cursorPath: string, callback: () => Promise<T>) {
  await mkdir(dirname(cursorPath), { recursive: true })
  const lockPath = `${cursorPath}.lock`
  const owner = { pid: process.pid, token: randomBytes(16).toString('hex') }
  await acquireCursorLock(lockPath, owner)
  const heartbeat = setInterval(() => {
    void refreshCursorLock(lockPath, owner)
  }, cursorLockHeartbeatMs)
  heartbeat.unref()
  try {
    return await callback()
  } finally {
    clearInterval(heartbeat)
    await releaseCursorLock(lockPath, owner)
  }
}

async function acquireCursorLock(lockPath: string, owner: CursorLockOwner) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < cursorLockTimeoutMs) {
    try {
      const handle = await open(lockPath, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify(owner))
      } finally {
        await handle.close()
      }
      return
    } catch (error) {
      if (!isFileExistsError(error)) throw error
      await recoverStaleCursorLock(lockPath)
      await delay(cursorLockRetryMs)
    }
  }
  throw new Error(`Timed out waiting for cursor lock: ${lockPath}`)
}

async function recoverStaleCursorLock(lockPath: string) {
  const lockStat = await stat(lockPath).catch(() => null)
  if (!lockStat || Date.now() - lockStat.mtimeMs < cursorLockStaleMs) return
  const owner = await readCursorLockOwner(lockPath)
  if (owner && !await sameCursorLockOwner(lockPath, owner)) return
  await rm(lockPath, { force: true })
}

async function refreshCursorLock(lockPath: string, owner: CursorLockOwner) {
  if (!await sameCursorLockOwner(lockPath, owner)) return
  const now = new Date()
  await utimes(lockPath, now, now).catch(() => undefined)
}

async function releaseCursorLock(lockPath: string, owner: CursorLockOwner) {
  if (!await fileExists(lockPath)) return
  if (!await sameCursorLockOwner(lockPath, owner)) {
    throw new Error(`Cursor lock ownership changed: ${lockPath}`)
  }
  await rm(lockPath, { force: true })
}

async function fileExists(path: string) {
  return stat(path).then(() => true).catch(() => false)
}

async function sameCursorLockOwner(lockPath: string, expected: CursorLockOwner) {
  const current = await readCursorLockOwner(lockPath)
  return current?.pid === expected.pid && current.token === expected.token
}

async function readCursorLockOwner(lockPath: string): Promise<CursorLockOwner | null> {
  try {
    const value = JSON.parse(await readFile(lockPath, 'utf8')) as Partial<CursorLockOwner>
    if (!Number.isSafeInteger(value.pid) || Number(value.pid) <= 0) return null
    if (typeof value.token !== 'string' || !value.token) return null
    return { pid: Number(value.pid), token: value.token }
  } catch {
    return null
  }
}

function isFileExistsError(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

type CursorLockOwner = { pid: number; token: string }

export function stripCollectedAt(snapshot: UsageSnapshot): CursorSnapshot {
  return {
    source: snapshot.source,
    usageDate: snapshot.usageDate,
    timezone: snapshot.timezone,
    model: snapshot.model,
    inputTokens: snapshot.inputTokens,
    outputTokens: snapshot.outputTokens,
    cacheCreationTokens: snapshot.cacheCreationTokens,
    cacheReadTokens: snapshot.cacheReadTokens,
    totalTokens: snapshot.totalTokens,
    costUsd: snapshot.costUsd,
    sessionCount: snapshot.sessionCount
  }
}

export function cursorFileName(source: UsageSource, scope?: string) {
  const baseName = sourceCursorFileName(source)
  if (!scope) return baseName
  const scopeHash = createHash('sha256').update(scope).digest('hex')
  return baseName.replace(/\.json$/, `.server-${scopeHash}.json`)
}

function sourceCursorFileName(source: UsageSource) {
  if (source === 'codex') return 'codex-cursor.json'
  if (source === 'antigravity-cli') return 'antigravity-cli-cursor.json'
  if (source === 'antigravity') return 'antigravity-cursor.json'
  if (source === 'antigravity-ide') return 'antigravity-ide-cursor.json'
  return 'claude-code-cursor.json'
}

function isValidCursor(value: unknown, source: UsageSource): value is CursorState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as CursorState
  return candidate.version === 1 &&
    candidate.source === source &&
    (candidate.lastScanHighWaterMs === undefined || isFiniteTimestampMs(candidate.lastScanHighWaterMs)) &&
    (candidate.lastScanOffsetBytes === undefined || isFiniteTimestampMs(candidate.lastScanOffsetBytes)) &&
    (candidate.lastScanGeneration === undefined || isValidScanGeneration(candidate.lastScanGeneration)) &&
    candidate.files !== null &&
    typeof candidate.files === 'object' &&
    !Array.isArray(candidate.files) &&
    Object.values(candidate.files).every(isValidCursorEntry)
}

function isValidCursorEntry(value: unknown): value is CursorEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as CursorEntry
  return isFiniteNumber(candidate.size) &&
    isFiniteNumber(candidate.mtimeMs) &&
    typeof candidate.sha256 === 'string' &&
    Array.isArray(candidate.snapshots) &&
    candidate.snapshots.every(isValidCursorSnapshot) &&
    typeof candidate.missingCost === 'boolean' &&
    typeof candidate.updatedAt === 'string' &&
    (candidate.pendingUpload === undefined || typeof candidate.pendingUpload === 'boolean')
}

function isValidCursorSnapshot(value: unknown): value is CursorSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as CursorSnapshot
  if (
    candidate.source !== 'codex' &&
    candidate.source !== 'claude-code' &&
    candidate.source !== 'antigravity-cli' &&
    candidate.source !== 'antigravity' &&
    candidate.source !== 'antigravity-ide'
  ) return false
  return typeof candidate.usageDate === 'string' &&
    typeof candidate.timezone === 'string' &&
    typeof candidate.model === 'string' &&
    isFiniteNumber(candidate.inputTokens) &&
    isFiniteNumber(candidate.outputTokens) &&
    isFiniteNumber(candidate.cacheCreationTokens) &&
    isFiniteNumber(candidate.cacheReadTokens) &&
    isFiniteNumber(candidate.totalTokens) &&
    isFiniteNumber(candidate.costUsd) &&
    isFiniteNumber(candidate.sessionCount)
}

function isFiniteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value)
}

function isFiniteTimestampMs(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isValidScanGeneration(value: unknown) {
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)
}
