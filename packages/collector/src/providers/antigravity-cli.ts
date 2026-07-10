import { createReadStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { UsageSnapshot } from '@tokenboard/usage-core'
import {
  cursorFileName,
  readCursor,
  writeCursor
} from './session-cursor-store'
import { mergeSnapshots } from './session-cursor'
import { readAntigravityDbUsageEvents, type AntigravityDbUsageResult } from './antigravity-history-db'
import type { AntigravityUsageEvent } from './antigravity-gui-parser'
import { parseStatuslineEvent, type StatuslineEvent } from './antigravity-cli-statusline'
import {
  lastSeenCliDbRowIndexByCascadeHash,
  markCliDbRowsProcessed,
  pushCliUsageEvent,
  pushCompleteCliCursorSnapshots
} from './antigravity-cli-cursor'

const source = 'antigravity-cli'
const statuslineFileName = 'antigravity-cli-statusline.jsonl'
const statuslineLogSchemaVersion = 'antigravity-statusline-log/v1'
const statuslineLogHeaderBytes = 512

export type CollectAntigravityCliUsageOptions = {
  timezone?: string
  collectedAt?: string
  stateDir?: string
  eventPath?: string
  conversationDir?: string
  cursorScope?: string
  maxDbFiles?: number | null
  readDbUsageEvents?: (input: {
    lastSeenRowIndexByCascadeHash: Map<string, number>
    maxDbFiles?: number | null
  }) => Promise<AntigravityDbUsageResult>
}

export async function collectAntigravityCliUsage(
  options: CollectAntigravityCliUsageOptions = {}
): Promise<UsageSnapshot[]> {
  const timezone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const collectedAt = options.collectedAt ?? new Date().toISOString()
  const stateDir = options.stateDir ?? readStateDir()
  const eventPath = options.eventPath ?? process.env.TOKENBOARD_ANTIGRAVITY_STATUSLINE_LOG ?? join(stateDir, statuslineFileName)
  const eventStats = await readEventStats(eventPath)

  const cursorPath = join(stateDir, cursorFileName(source, options.cursorScope))
  const cursor = await readCursor(cursorPath, source)
  const emittedKeys = new Set<string>()
  const snapshots: UsageSnapshot[] = []

  if (eventStats) {
    const eventSizeBytes = readEventSizeBytes(eventStats.size)
    const generation = await readStatuslineLogGeneration(eventPath, eventSizeBytes)
    const generationChanged = generation !== cursor.lastScanGeneration &&
      (generation !== undefined || cursor.lastScanGeneration !== undefined)
    const scanStartBytes = generationChanged
      ? 0
      : scanStartOffset(cursor.lastScanOffsetBytes, eventSizeBytes)
    for await (const event of readStatuslineEvents(eventPath, scanStartBytes, eventSizeBytes)) {
      pushCliUsageEvent({ event, cursor, snapshots, emittedKeys, timezone, collectedAt })
    }
    cursor.lastScanOffsetBytes = eventSizeBytes
    cursor.lastScanGeneration = generation
  }

  const localDbUsage = await readOptionalLocalDbUsage(options, Boolean(eventStats), cursor)
  for (const event of localDbUsage.events.map(historyEvent)) {
    pushCliUsageEvent({ event, cursor, snapshots, emittedKeys, timezone, collectedAt })
  }
  markCliDbRowsProcessed({
    cursor,
    lastReadRowIndexByCascade: localDbUsage.lastReadRowIndexByCascade
  })

  pushCompleteCliCursorSnapshots(snapshots, cursor, collectedAt, emittedKeys)
  await writeCursor(cursorPath, cursor)
  return mergeSnapshots(snapshots)
}

async function readEventStats(eventPath: string) {
  try {
    return await stat(eventPath)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

async function readLocalDbUsage(
  options: CollectAntigravityCliUsageOptions,
  cursor: Awaited<ReturnType<typeof readCursor>>
) {
  const lastSeenRowIndexByCascadeHash = lastSeenCliDbRowIndexByCascadeHash({ cursor })
  if (options.readDbUsageEvents) {
    return options.readDbUsageEvents({
      lastSeenRowIndexByCascadeHash,
      maxDbFiles: resolveMaxDbFiles(options.maxDbFiles)
    })
  }
  return readAntigravityDbUsageEvents({
    conversationDir: options.conversationDir ?? defaultConversationDir(),
    lastSeenRowIndexByCascadeHash,
    maxDbFiles: resolveMaxDbFiles(options.maxDbFiles)
  })
}

function resolveMaxDbFiles(value: number | null | undefined) {
  return value === undefined ? defaultMaxDbFilesForCurrentRun() : value
}

function defaultMaxDbFilesForCurrentRun() {
  const since = process.env.TOKENBOARD_SINCE || process.env.TOKENBOARD_DEFAULT_SINCE || ''
  return since === 'all' ? null : undefined
}

async function readOptionalLocalDbUsage(
  options: CollectAntigravityCliUsageOptions,
  statuslineAvailable: boolean,
  cursor: Awaited<ReturnType<typeof readCursor>>
) {
  try {
    return await readLocalDbUsage(options, cursor)
  } catch (error) {
    if (statuslineAvailable && isUnavailableDbError(error)) {
      return { cascadeIds: new Set<string>(), events: [] }
    }
    throw error
  }
}

function isUnavailableDbError(error: unknown) {
  if (!(error instanceof Error)) return false
  return error.message.startsWith('Antigravity SQLite reader unavailable:') ||
    error.message.startsWith('Antigravity conversations directory not found:')
}

function historyEvent(event: AntigravityUsageEvent): StatuslineEvent {
  return {
    capturedAt: event.createdAt,
    conversationHash: event.cascadeHash,
    conversationHashAliases: event.cascadeHashAliases,
    eventHash: event.eventHash,
    model: event.model,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cacheCreationTokens: event.cacheCreationTokens,
    cacheReadTokens: event.cacheReadTokens
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
    if (isStatuslineLogHeader(line)) continue
    yield parseStatuslineEvent(line, lineNumber)
  }
}

async function readStatuslineLogGeneration(eventPath: string, sizeBytes: number) {
  if (sizeBytes === 0) return undefined
  const file = await open(eventPath, 'r')
  try {
    const buffer = Buffer.alloc(Math.min(statuslineLogHeaderBytes, sizeBytes))
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    const firstLine = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/, 1)[0]
    const header = parseStatuslineLogHeader(firstLine)
    return header?.generation
  } finally {
    await file.close()
  }
}

function isStatuslineLogHeader(line: string) {
  return parseStatuslineLogHeader(line) !== null
}

function parseStatuslineLogHeader(line: string) {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as { schemaVersion?: unknown; generation?: unknown }
  if (candidate.schemaVersion !== statuslineLogSchemaVersion) return null
  if (typeof candidate.generation !== 'string' || !/^[a-f0-9]{32}$/.test(candidate.generation)) {
    throw new Error('Invalid Antigravity statusline log generation')
  }
  return { generation: candidate.generation }
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

function readStateDir() {
  return process.env.TOKENBOARD_STATE_DIR || process.env.TOKENBOARD_CONFIG_DIR || join(homedir(), '.tokenboard')
}

function defaultConversationDir() {
  return join(homedir(), '.gemini', source, 'conversations')
}
