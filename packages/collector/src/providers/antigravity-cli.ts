import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { usageSnapshotSchema, type UsageSnapshot } from '@tokenboard/usage-core'
import { formatDate } from './session-jsonl-parser-utils'
import {
  cursorFileName,
  readCursor,
  stripCollectedAt,
  writeCursor,
  type CursorEntry
} from './session-cursor-store'
import { mergeSnapshots } from './session-cursor'

const source = 'antigravity-cli'
const statuslineFileName = 'antigravity-cli-statusline.jsonl'
const eventSchemaVersion = 'antigravity-statusline/v1'
const maxTokenValue = 1_000_000_000
const maxModelLength = 160
const cursorRetentionMs = 45 * 24 * 60 * 60 * 1000
const sensitiveKeys = new Set(['cwd', 'workspace', 'email', 'plan_tier', 'transcript_path'])

export type CollectAntigravityCliUsageOptions = {
  timezone?: string
  collectedAt?: string
  stateDir?: string
  eventPath?: string
}

type StatuslineEvent = {
  capturedAt: string
  conversationHash: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
}

export async function collectAntigravityCliUsage(
  options: CollectAntigravityCliUsageOptions = {}
): Promise<UsageSnapshot[]> {
  const timezone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const collectedAt = options.collectedAt ?? new Date().toISOString()
  const stateDir = options.stateDir ?? readStateDir()
  const eventPath = options.eventPath ?? process.env.TOKENBOARD_ANTIGRAVITY_STATUSLINE_LOG ?? join(stateDir, statuslineFileName)
  const eventStats = await readEventStats(eventPath)
  const eventSizeBytes = readEventSizeBytes(eventStats.size)

  const cursorPath = join(stateDir, cursorFileName(source))
  const cursor = await readCursor(cursorPath, source)
  const emittedKeys = new Set<string>()
  const snapshots: UsageSnapshot[] = []
  pushPendingCursorSnapshots(snapshots, cursor, collectedAt, emittedKeys)

  const scanStartBytes = scanStartOffset(cursor.lastScanOffsetBytes, eventSizeBytes)
  for await (const event of readStatuslineEvents(eventPath, scanStartBytes, eventSizeBytes)) {
    const eventKey = usageEventKey(event)
    const existing = cursor.files[eventKey]
    if (existing) {
      if (existing.pendingUpload) {
        pushCachedSnapshots(snapshots, existing, collectedAt, emittedKeys, eventKey)
      }
      continue
    }

    const snapshot = buildSnapshot({ event, timezone, collectedAt, cursor })
    cursor.files[eventKey] = newCursorEntry({
      snapshots: [stripCollectedAt(snapshot)],
      marker: eventKey,
      mtimeMs: Date.parse(event.capturedAt),
      pendingUpload: true
    })
    snapshots.push(snapshot)
    emittedKeys.add(eventKey)
  }

  cursor.lastScanOffsetBytes = eventSizeBytes
  pruneCursor(cursor, Date.parse(collectedAt))
  await writeCursor(cursorPath, cursor)
  return mergeSnapshots(snapshots)
}

async function readEventStats(eventPath: string) {
  try {
    return await stat(eventPath)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`Antigravity CLI statusline log not found: ${eventPath}`)
    }
    throw error
  }
}

async function * readStatuslineEvents(eventPath: string, startBytes: number, endBytes: number): AsyncGenerator<StatuslineEvent> {
  if (startBytes >= endBytes) return
  const stream = createReadStream(eventPath, { encoding: 'utf8', start: startBytes, end: endBytes - 1 })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  let lineNumber = 0
  for await (const line of lines) {
    lineNumber += 1
    if (!line.trim()) continue
    yield parseStatuslineEvent(line, lineNumber)
  }
}

function parseStatuslineEvent(line: string, lineNumber: number): StatuslineEvent {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (error) {
    throw new Error(`Malformed Antigravity statusline JSON at line ${lineNumber}`)
  }
  if (!isRecord(parsed)) {
    throw new Error(`Invalid Antigravity statusline event at line ${lineNumber}: expected object`)
  }
  for (const key of Object.keys(parsed)) {
    if (sensitiveKeys.has(key)) {
      throw new Error(`Invalid Antigravity statusline event at line ${lineNumber}: sensitive field ${key} must not be persisted`)
    }
  }
  if (parsed.schemaVersion !== eventSchemaVersion) {
    throw new Error(`Invalid Antigravity statusline event at line ${lineNumber}: unsupported schemaVersion`)
  }
  const usage = isRecord(parsed.usage) ? parsed.usage : null
  if (!usage) {
    throw new Error(`Invalid Antigravity statusline event at line ${lineNumber}: missing usage`)
  }
  const event = {
    capturedAt: readIsoDateTime(parsed.capturedAt, lineNumber),
    conversationHash: readHash(parsed.conversationHash, 'conversationHash', lineNumber),
    model: readString(parsed.model, 'model', lineNumber),
    inputTokens: readToken(usage.inputTokens, 'inputTokens', lineNumber),
    outputTokens: readToken(usage.outputTokens, 'outputTokens', lineNumber),
    cacheCreationTokens: readToken(usage.cacheCreationTokens, 'cacheCreationTokens', lineNumber),
    cacheReadTokens: readToken(usage.cacheReadTokens, 'cacheReadTokens', lineNumber)
  }
  if (event.inputTokens + event.outputTokens + event.cacheCreationTokens + event.cacheReadTokens === 0) {
    throw new Error(`Invalid Antigravity statusline event at line ${lineNumber}: usage is empty`)
  }
  return event
}

function buildSnapshot(input: {
  event: StatuslineEvent
  timezone: string
  collectedAt: string
  cursor: Awaited<ReturnType<typeof readCursor>>
}) {
  const usageDate = formatDate(new Date(input.event.capturedAt), input.timezone)
  const sessionKey = usageSessionKey(input.event, usageDate)
  const sessionEntry = input.cursor.files[sessionKey]
  if (!sessionEntry) {
    input.cursor.files[sessionKey] = newCursorEntry({
      snapshots: [],
      marker: sessionKey,
      mtimeMs: Date.parse(input.event.capturedAt),
      pendingUpload: true
    })
  }

  return usageSnapshotSchema.parse({
    source,
    usageDate,
    timezone: input.timezone,
    model: input.event.model,
    inputTokens: input.event.inputTokens,
    outputTokens: input.event.outputTokens,
    cacheCreationTokens: input.event.cacheCreationTokens,
    cacheReadTokens: input.event.cacheReadTokens,
    totalTokens: input.event.inputTokens + input.event.outputTokens + input.event.cacheCreationTokens + input.event.cacheReadTokens,
    costUsd: 0,
    sessionCount: sessionEntry ? 0 : 1,
    collectedAt: input.collectedAt
  })
}

function pushCachedSnapshots(
  snapshots: UsageSnapshot[],
  entry: CursorEntry,
  collectedAt: string,
  emittedKeys: Set<string>,
  eventKey: string
) {
  if (emittedKeys.has(eventKey)) return
  for (const snapshot of entry.snapshots) {
    snapshots.push({ ...snapshot, collectedAt })
  }
  emittedKeys.add(eventKey)
}

function pushPendingCursorSnapshots(
  snapshots: UsageSnapshot[],
  cursor: Awaited<ReturnType<typeof readCursor>>,
  collectedAt: string,
  emittedKeys: Set<string>
) {
  for (const [eventKey, entry] of Object.entries(cursor.files)) {
    if (!entry.pendingUpload || entry.snapshots.length === 0) continue
    pushCachedSnapshots(snapshots, entry, collectedAt, emittedKeys, eventKey)
  }
}

function newCursorEntry(input: {
  snapshots: Array<Omit<UsageSnapshot, 'collectedAt'>>
  marker: string
  mtimeMs: number
  pendingUpload: boolean
}): CursorEntry {
  return {
    size: 0,
    mtimeMs: Number.isFinite(input.mtimeMs) ? input.mtimeMs : 0,
    sha256: hash(input.marker),
    snapshots: input.snapshots,
    missingCost: true,
    pendingUpload: input.pendingUpload,
    updatedAt: new Date().toISOString()
  }
}

function usageEventKey(event: StatuslineEvent) {
  return [
    'event',
    event.conversationHash,
    event.model,
    event.inputTokens,
    event.outputTokens,
    event.cacheCreationTokens,
    event.cacheReadTokens
  ].join('\0')
}

function usageSessionKey(event: StatuslineEvent, usageDate: string) {
  return ['session', usageDate, event.model, event.conversationHash].join('\0')
}

function scanStartOffset(value: number | undefined, currentSize: number) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > currentSize) return 0
  return value
}

function readEventSizeBytes(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Invalid Antigravity CLI statusline log size')
  }
  return value
}

function pruneCursor(cursor: Awaited<ReturnType<typeof readCursor>>, nowMs: number) {
  if (!Number.isFinite(nowMs)) return
  const cutoff = nowMs - cursorRetentionMs
  for (const [key, entry] of Object.entries(cursor.files)) {
    if (entry.pendingUpload) continue
    if (entry.mtimeMs >= cutoff) continue
    delete cursor.files[key]
  }
}

function readStateDir() {
  return process.env.TOKENBOARD_STATE_DIR || process.env.TOKENBOARD_CONFIG_DIR || join(homedir(), '.tokenboard')
}

function readIsoDateTime(value: unknown, lineNumber: number): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid Antigravity statusline event at line ${lineNumber}: capturedAt must be a string`)
  }
  const time = Date.parse(value)
  if (!Number.isFinite(time)) {
    throw new Error(`Invalid Antigravity statusline event at line ${lineNumber}: capturedAt must be an ISO datetime`)
  }
  return value
}

function readHash(value: unknown, field: string, lineNumber: number): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`Invalid Antigravity statusline event at line ${lineNumber}: ${field} must be a hash`)
  }
  return value
}

function readString(value: unknown, field: string, lineNumber: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxModelLength) {
    throw new Error(`Invalid Antigravity statusline event at line ${lineNumber}: ${field} must be a non-empty string`)
  }
  return value
}

function readToken(value: unknown, field: string, lineNumber: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maxTokenValue) {
    throw new Error(`Invalid Antigravity statusline event at line ${lineNumber}: ${field} must be a bounded nonnegative integer`)
  }
  return value
}

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
