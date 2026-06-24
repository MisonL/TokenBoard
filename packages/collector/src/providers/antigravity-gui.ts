import { homedir } from 'node:os'
import { join } from 'node:path'
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
import {
  createAntigravityLanguageServerClient,
  listAntigravityCascadeIds,
  type AntigravityGeneratorMetadataRequest
} from './antigravity-gui-client'
import {
  hash,
  parseGeneratorMetadata,
  type AntigravityUsageEvent
} from './antigravity-gui-parser'

export type AntigravityGuiSource = 'antigravity' | 'antigravity-ide'

export type CollectAntigravityGuiUsageOptions = {
  source: AntigravityGuiSource
  timezone?: string
  collectedAt?: string
  stateDir?: string
  conversationDir?: string
  languageServerPath?: string
  overrideIdeVersion?: string
  listCascadeIds?: () => Promise<string[]>
  requestGeneratorMetadata?: (input: AntigravityGeneratorMetadataRequest) => Promise<unknown>
}

const cursorRetentionMs = 45 * 24 * 60 * 60 * 1000

export function collectAntigravityUsage(options: Omit<CollectAntigravityGuiUsageOptions, 'source'> = {}) {
  return collectAntigravityGuiUsage({ ...options, source: 'antigravity' })
}

export function collectAntigravityIdeUsage(options: Omit<CollectAntigravityGuiUsageOptions, 'source'> = {}) {
  return collectAntigravityGuiUsage({ ...options, source: 'antigravity-ide' })
}

export async function collectAntigravityGuiUsage(
  options: CollectAntigravityGuiUsageOptions
): Promise<UsageSnapshot[]> {
  const timezone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const collectedAt = options.collectedAt ?? new Date().toISOString()
  const stateDir = options.stateDir ?? readStateDir()
  const cursorPath = join(stateDir, cursorFileName(options.source))
  const cursor = await readCursor(cursorPath, options.source)
  const snapshots: UsageSnapshot[] = []
  const emittedKeys = new Set<string>()
  pushPendingCursorSnapshots(snapshots, cursor, collectedAt, emittedKeys)

  const request = await createRequestContext(options)
  try {
    for (const cascadeId of await request.listCascadeIds()) {
      const response = await request.requestGeneratorMetadata({ source: options.source, cascadeId })
      for (const event of parseGeneratorMetadata(response, cascadeId)) {
        pushUsageEvent({ event, cursor, snapshots, emittedKeys, timezone, collectedAt, source: options.source })
      }
    }
  } finally {
    await request.close()
  }

  pruneCursor(cursor, Date.parse(collectedAt))
  await writeCursor(cursorPath, cursor)
  return mergeSnapshots(snapshots)
}

async function createRequestContext(options: CollectAntigravityGuiUsageOptions) {
  const listCascadeIds = options.listCascadeIds ?? (() => listAntigravityCascadeIds(options))
  if (options.requestGeneratorMetadata) {
    return {
      listCascadeIds,
      requestGeneratorMetadata: options.requestGeneratorMetadata,
      close: async () => undefined
    }
  }
  const client = await createAntigravityLanguageServerClient(options)
  return { listCascadeIds, requestGeneratorMetadata: client.requestGeneratorMetadata, close: client.close }
}

function pushUsageEvent(input: {
  event: AntigravityUsageEvent
  cursor: Awaited<ReturnType<typeof readCursor>>
  snapshots: UsageSnapshot[]
  emittedKeys: Set<string>
  timezone: string
  collectedAt: string
  source: AntigravityGuiSource
}) {
  const eventKey = usageEventKey(input.event)
  const existing = input.cursor.files[eventKey]
  if (existing) {
    if (existing.pendingUpload) pushCachedSnapshots(input.snapshots, existing, input.collectedAt, input.emittedKeys, eventKey)
    return
  }
  const snapshot = buildSnapshot(input)
  input.cursor.files[eventKey] = newCursorEntry({
    snapshots: [stripCollectedAt(snapshot)],
    marker: eventKey,
    mtimeMs: Date.parse(input.event.createdAt),
    pendingUpload: true
  })
  input.snapshots.push(snapshot)
  input.emittedKeys.add(eventKey)
}

function buildSnapshot(input: {
  event: AntigravityUsageEvent
  cursor: Awaited<ReturnType<typeof readCursor>>
  timezone: string
  collectedAt: string
  source: AntigravityGuiSource
}) {
  const usageDate = formatDate(new Date(input.event.createdAt), input.timezone)
  const sessionKey = usageSessionKey(input.event, usageDate, input.source)
  const sessionEntry = input.cursor.files[sessionKey]
  if (!sessionEntry) {
    input.cursor.files[sessionKey] = newCursorEntry({
      snapshots: [],
      marker: sessionKey,
      mtimeMs: Date.parse(input.event.createdAt),
      pendingUpload: true
    })
  }
  return usageSnapshotSchema.parse({
    source: input.source,
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
  snapshots.push(...entry.snapshots.map((snapshot) => ({ ...snapshot, collectedAt })))
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

function usageEventKey(event: AntigravityUsageEvent) {
  return ['event', event.cascadeHash, event.eventHash].join('\0')
}

function usageSessionKey(event: AntigravityUsageEvent, usageDate: string, source: AntigravityGuiSource) {
  return ['session', source, usageDate, event.model, event.cascadeHash].join('\0')
}

function pruneCursor(cursor: Awaited<ReturnType<typeof readCursor>>, nowMs: number) {
  if (!Number.isFinite(nowMs)) return
  const cutoff = nowMs - cursorRetentionMs
  for (const [key, entry] of Object.entries(cursor.files)) {
    if (entry.pendingUpload || entry.mtimeMs >= cutoff) continue
    delete cursor.files[key]
  }
}

function readStateDir() {
  return process.env.TOKENBOARD_STATE_DIR || process.env.TOKENBOARD_CONFIG_DIR || join(homedir(), '.tokenboard')
}
