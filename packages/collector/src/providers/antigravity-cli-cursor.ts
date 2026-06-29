import { createHash } from 'node:crypto'
import { usageSnapshotSchema, type UsageSnapshot } from '@tokenboard/usage-core'
import { formatDate } from './session-jsonl-parser-utils'
import {
  readCursor,
  stripCollectedAt,
  type CursorEntry
} from './session-cursor-store'
import type { StatuslineEvent } from './antigravity-cli-statusline'

const source = 'antigravity-cli'

type AntigravityCliCursor = Awaited<ReturnType<typeof readCursor>>

export function pushCliUsageEvent(input: {
  event: StatuslineEvent
  cursor: AntigravityCliCursor
  snapshots: UsageSnapshot[]
  emittedKeys: Set<string>
  timezone: string
  collectedAt: string
}) {
  const eventKeys = usageEventKeys(input.event)
  const primaryKey = eventKeys[0]
  const existingKey = findExistingEventKey(input.event, eventKeys, input.cursor)
  const existing = existingKey ? input.cursor.files[existingKey] : undefined
  if (existing && existingKey) {
    if (existing.pendingUpload) {
      pushCachedSnapshots(input.snapshots, existing, input.collectedAt, input.emittedKeys, existingKey)
    }
    if (input.event.eventHash && existingKey !== primaryKey) {
      markHistoryEventCoveredByStatusline({
        cursor: input.cursor,
        event: input.event,
        primaryKey,
        statuslineKey: existingKey
      })
    }
    return
  }

  const snapshot = buildSnapshot(input)
  input.cursor.files[primaryKey] = newCursorEntry({
    snapshots: [stripCollectedAt(snapshot)],
    marker: primaryKey,
    mtimeMs: Date.parse(input.event.capturedAt),
    pendingUpload: true
  })
  for (const aliasKey of eventKeys.slice(1)) {
    input.cursor.files[aliasKey] ??= newCursorEntry({
      snapshots: [],
      marker: aliasKey,
      mtimeMs: Date.parse(input.event.capturedAt),
      pendingUpload: false
    })
  }
  input.snapshots.push(snapshot)
  input.emittedKeys.add(primaryKey)
}

export function pushPendingCliCursorSnapshots(
  snapshots: UsageSnapshot[],
  cursor: AntigravityCliCursor,
  collectedAt: string,
  emittedKeys: Set<string>
) {
  for (const [eventKey, entry] of Object.entries(cursor.files)) {
    if (!entry.pendingUpload || entry.snapshots.length === 0) continue
    pushCachedSnapshots(snapshots, entry, collectedAt, emittedKeys, eventKey)
  }
}

function buildSnapshot(input: {
  event: StatuslineEvent
  timezone: string
  collectedAt: string
  cursor: AntigravityCliCursor
}) {
  const usageDate = formatDate(new Date(input.event.capturedAt), input.timezone)
  const sessionKeys = usageSessionKeys(input.event, usageDate)
  const sessionKey = sessionKeys[0]
  const existingSessionKey = sessionKeys.find((key) => input.cursor.files[key])
  const sessionEntry = existingSessionKey ? input.cursor.files[existingSessionKey] : undefined
  if (!sessionEntry) {
    input.cursor.files[sessionKey] = newCursorEntry({
      snapshots: [],
      marker: sessionKey,
      mtimeMs: Date.parse(input.event.capturedAt),
      pendingUpload: true
    })
    for (const aliasKey of sessionKeys.slice(1)) {
      input.cursor.files[aliasKey] ??= newCursorEntry({
        snapshots: [],
        marker: aliasKey,
        mtimeMs: Date.parse(input.event.capturedAt),
        pendingUpload: false
      })
    }
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

function findExistingEventKey(
  event: StatuslineEvent,
  eventKeys: string[],
  cursor: AntigravityCliCursor
) {
  const primaryKey = eventKeys[0]
  if (cursor.files[primaryKey]) return primaryKey
  for (const key of eventKeys.slice(1)) {
    const entry = cursor.files[key]
    if (!entry) continue
    if (!event.eventHash) return key
    if (entry.snapshots.length > 0 && !cursor.files[historyStatuslineClaimKey(key)]) return key
  }
  return undefined
}

function markHistoryEventCoveredByStatusline(input: {
  cursor: AntigravityCliCursor
  event: StatuslineEvent
  primaryKey: string
  statuslineKey: string
}) {
  input.cursor.files[input.primaryKey] ??= newCursorEntry({
    snapshots: [],
    marker: input.primaryKey,
    mtimeMs: Date.parse(input.event.capturedAt),
    pendingUpload: false
  })
  const claimKey = historyStatuslineClaimKey(input.statuslineKey)
  input.cursor.files[claimKey] ??= newCursorEntry({
    snapshots: [],
    marker: claimKey,
    mtimeMs: Date.parse(input.event.capturedAt),
    pendingUpload: false
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

function usageEventKeys(event: StatuslineEvent) {
  const legacyKey = statuslineEventKey(event, event.conversationHash)
  const aliasKeys = (event.conversationHashAliases ?? [])
    .filter((hash) => hash !== event.conversationHash)
    .map((hash) => statuslineEventKey(event, hash))
  if (event.eventHash) {
    return [['history-event', event.conversationHash, event.eventHash].join('\0'), legacyKey, ...aliasKeys]
  }
  return [legacyKey, ...aliasKeys]
}

function statuslineEventKey(event: StatuslineEvent, conversationHash: string) {
  return [
    'event',
    conversationHash,
    event.model,
    event.inputTokens,
    event.outputTokens,
    event.cacheCreationTokens,
    event.cacheReadTokens
  ].join('\0')
}

function usageSessionKeys(event: StatuslineEvent, usageDate: string) {
  const primaryKey = usageSessionKey(event, usageDate, event.conversationHash)
  const aliasKeys = (event.conversationHashAliases ?? [])
    .filter((hash) => hash !== event.conversationHash)
    .map((hash) => usageSessionKey(event, usageDate, hash))
  return [primaryKey, ...aliasKeys]
}

function usageSessionKey(event: StatuslineEvent, usageDate: string, conversationHash: string) {
  return ['session', usageDate, event.model, conversationHash].join('\0')
}

function historyStatuslineClaimKey(statuslineKey: string) {
  return ['history-statusline-claim', statuslineKey].join('\0')
}

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex')
}
