import { createHash } from 'node:crypto'
import { usageSnapshotSchema, type UsageSnapshot } from '@tokenboard/usage-core'
import { formatDate } from './session-jsonl-parser-utils'
import {
  readCursor,
  stripCollectedAt,
  type CursorEntry,
  type CursorSnapshot
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
  if (!input.event.eventHash) {
    pushStatuslineUsageEvent(input)
    return
  }
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

function pushStatuslineUsageEvent(input: {
  event: StatuslineEvent
  cursor: AntigravityCliCursor
  snapshots: UsageSnapshot[]
  emittedKeys: Set<string>
  timezone: string
  collectedAt: string
}) {
  const legacyKeys = usageEventKeys(input.event)
  const coveredKey = legacyKeys.find((key) => {
    const entry = input.cursor.files[key]
    return entry && !isStatuslineAlias(entry, key)
  })
  if (coveredKey) {
    const covered = input.cursor.files[coveredKey]
    if (covered?.pendingUpload) {
      pushCachedSnapshots(input.snapshots, covered, input.collectedAt, input.emittedKeys, coveredKey)
    }
    return
  }
  const occurrenceKey = statuslineOccurrenceKey(input.event)
  const existing = input.cursor.files[occurrenceKey]
  if (existing) {
    if (existing.pendingUpload) {
      pushCachedSnapshots(input.snapshots, existing, input.collectedAt, input.emittedKeys, occurrenceKey)
    }
    return
  }

  const signature = statuslineEventKey(input.event, input.event.conversationHash)
  const headKeys = statuslineHeadKeys(input.event)
  if (headKeys.some((key) => input.cursor.files[key]?.sha256 === hash(signature))) return

  const snapshot = buildSnapshot(input)
  input.cursor.files[occurrenceKey] = newCursorEntry({
    snapshots: [stripCollectedAt(snapshot)],
    marker: occurrenceKey,
    mtimeMs: Date.parse(input.event.capturedAt),
    pendingUpload: true
  })
  for (const aliasKey of legacyKeys) {
    input.cursor.files[aliasKey] ??= newCursorEntry({
      snapshots: [],
      marker: statuslineAliasMarker(aliasKey),
      mtimeMs: Date.parse(input.event.capturedAt),
      pendingUpload: false
    })
  }
  for (const headKey of headKeys) {
    input.cursor.files[headKey] = newCursorEntry({
      snapshots: [],
      marker: signature,
      mtimeMs: Date.parse(input.event.capturedAt),
      pendingUpload: false
    })
  }
  input.snapshots.push(snapshot)
  input.emittedKeys.add(occurrenceKey)
}

export function pushCompleteCliCursorSnapshots(
  snapshots: UsageSnapshot[],
  cursor: AntigravityCliCursor,
  collectedAt: string,
  emittedKeys: Set<string>
) {
  const dirtyGroups = new Set<string>()
  for (const [eventKey, entry] of Object.entries(cursor.files)) {
    if (!entry.pendingUpload || entry.snapshots.length === 0) continue
    for (const snapshot of entry.snapshots) {
      dirtyGroups.add(snapshotGroupKey(snapshot))
    }
  }

  for (const snapshot of snapshots) {
    dirtyGroups.add(snapshotGroupKey(snapshot))
  }

  for (const [eventKey, entry] of Object.entries(cursor.files)) {
    if (entry.snapshots.length === 0) continue
    if (!entry.snapshots.some((snapshot) => dirtyGroups.has(snapshotGroupKey(snapshot)))) continue
    pushCachedSnapshots(snapshots, entry, collectedAt, emittedKeys, eventKey)
  }
}

export function lastSeenCliDbRowIndexByCascadeHash(input: {
  cursor: AntigravityCliCursor
}) {
  // Keys are sha256(cascadeId), matching antigravity-history-db cursor lookups.
  const indexes = new Map<string, number>()
  for (const [key, entry] of Object.entries(input.cursor.files)) {
    if (!key.startsWith(cliDbCascadeCursorPrefix)) continue
    indexes.set(key.slice(cliDbCascadeCursorPrefix.length), entry.mtimeMs)
  }
  return indexes
}

export function markCliDbRowsProcessed(input: {
  cursor: AntigravityCliCursor
  lastReadRowIndexByCascade?: Map<string, number>
}) {
  for (const [cascadeId, rowIndex] of input.lastReadRowIndexByCascade ?? []) {
    const key = cliDbCascadeCursorKey(cascadeId)
    input.cursor.files[key] = newCursorEntry({
      snapshots: [],
      marker: key,
      mtimeMs: rowIndex,
      pendingUpload: false
    })
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
  const occurrenceKey = findUnclaimedStatuslineOccurrence(event, eventKeys.slice(1), cursor)
  if (occurrenceKey) return occurrenceKey
  for (const key of eventKeys.slice(1)) {
    const entry = cursor.files[key]
    if (!entry) continue
    if (hasStatuslineOccurrences(key, cursor)) continue
    if (!event.eventHash) return key
    if (
      (entry.snapshots.length > 0 || isStatuslineAlias(entry, key)) &&
      !cursor.files[historyStatuslineClaimKey(key)]
    ) return key
  }
  return undefined
}

function hasStatuslineOccurrences(statuslineKey: string, cursor: AntigravityCliCursor) {
  const prefix = `statusline-occurrence\0${statuslineKey}\0`
  return Object.keys(cursor.files).some((key) => key.startsWith(prefix))
}

function findUnclaimedStatuslineOccurrence(
  event: StatuslineEvent,
  statuslineKeys: string[],
  cursor: AntigravityCliCursor
) {
  const candidates = statuslineKeys.flatMap((statuslineKey) => {
    const prefix = `statusline-occurrence\0${statuslineKey}\0`
    return Object.entries(cursor.files)
      .filter(([key, entry]) => (
        key.startsWith(prefix) &&
        entry.snapshots.length > 0 &&
        !cursor.files[historyStatuslineClaimKey(key)]
      ))
  })
  const exact = candidates.find(([key]) => key.endsWith(`\0${event.capturedAt}`))
  if (exact) return exact[0]
  candidates.sort((left, right) => left[1].mtimeMs - right[1].mtimeMs || left[0].localeCompare(right[0]))
  return candidates[0]?.[0]
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

function statuslineOccurrenceKey(event: StatuslineEvent) {
  return ['statusline-occurrence', statuslineEventKey(event, event.conversationHash), event.capturedAt].join('\0')
}

function statuslineHeadKeys(event: StatuslineEvent) {
  return [event.conversationHash, ...(event.conversationHashAliases ?? [])]
    .map((conversationHash) => ['statusline-head', conversationHash].join('\0'))
}

function statuslineAliasMarker(key: string) {
  return ['statusline-alias', key].join('\0')
}

function isStatuslineAlias(entry: CursorEntry, key: string) {
  return entry.sha256 === hash(statuslineAliasMarker(key))
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

const cliDbCascadeCursorPrefix = ['db-row', source, ''].join('\0')

function cliDbCascadeCursorKey(cascadeId: string) {
  return `${cliDbCascadeCursorPrefix}${hash(cascadeId)}`
}

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function snapshotGroupKey(snapshot: CursorSnapshot | UsageSnapshot) {
  return [
    snapshot.source,
    snapshot.usageDate,
    snapshot.timezone,
    snapshot.model
  ].join('\0')
}
