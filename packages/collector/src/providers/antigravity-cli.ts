import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
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
import { pushCliUsageEvent, pushPendingCliCursorSnapshots } from './antigravity-cli-cursor'

const source = 'antigravity-cli'
const statuslineFileName = 'antigravity-cli-statusline.jsonl'

export type CollectAntigravityCliUsageOptions = {
  timezone?: string
  collectedAt?: string
  stateDir?: string
  eventPath?: string
  conversationDir?: string
  readDbUsageEvents?: () => Promise<AntigravityDbUsageResult>
}

export async function collectAntigravityCliUsage(
  options: CollectAntigravityCliUsageOptions = {}
): Promise<UsageSnapshot[]> {
  const timezone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const collectedAt = options.collectedAt ?? new Date().toISOString()
  const stateDir = options.stateDir ?? readStateDir()
  const eventPath = options.eventPath ?? process.env.TOKENBOARD_ANTIGRAVITY_STATUSLINE_LOG ?? join(stateDir, statuslineFileName)
  const eventStats = await readEventStats(eventPath)

  const cursorPath = join(stateDir, cursorFileName(source))
  const cursor = await readCursor(cursorPath, source)
  const emittedKeys = new Set<string>()
  const snapshots: UsageSnapshot[] = []
  pushPendingCliCursorSnapshots(snapshots, cursor, collectedAt, emittedKeys)

  if (eventStats) {
    const eventSizeBytes = readEventSizeBytes(eventStats.size)
    const scanStartBytes = scanStartOffset(cursor.lastScanOffsetBytes, eventSizeBytes)
    for await (const event of readStatuslineEvents(eventPath, scanStartBytes, eventSizeBytes)) {
      pushCliUsageEvent({ event, cursor, snapshots, emittedKeys, timezone, collectedAt })
    }
    cursor.lastScanOffsetBytes = eventSizeBytes
  }

  const localDbUsage = await readOptionalLocalDbUsage(options, Boolean(eventStats))
  for (const event of localDbUsage.events.map(historyEvent)) {
    pushCliUsageEvent({ event, cursor, snapshots, emittedKeys, timezone, collectedAt })
  }

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

async function readLocalDbUsage(options: CollectAntigravityCliUsageOptions) {
  if (options.readDbUsageEvents) return options.readDbUsageEvents()
  return readAntigravityDbUsageEvents({
    conversationDir: options.conversationDir ?? defaultConversationDir()
  })
}

async function readOptionalLocalDbUsage(options: CollectAntigravityCliUsageOptions, statuslineAvailable: boolean) {
  try {
    return await readLocalDbUsage(options)
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
    yield parseStatuslineEvent(line, lineNumber)
  }
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
