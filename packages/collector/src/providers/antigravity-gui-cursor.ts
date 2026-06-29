import { usageSnapshotSchema, type UsageSnapshot } from '@tokenboard/usage-core'
import { formatDate } from './session-jsonl-parser-utils'
import {
  readCursor,
  stripCollectedAt,
  type CursorEntry
} from './session-cursor-store'
import { hash, type AntigravityUsageEvent } from './antigravity-gui-parser'
import type { AntigravityCascadeRef } from './antigravity-gui-client'
import type { AntigravityGuiSource } from './antigravity-gui'

type AntigravityGuiCursor = Awaited<ReturnType<typeof readCursor>>

export function pushGuiUsageEvent(input: {
  event: AntigravityUsageEvent
  cursor: AntigravityGuiCursor
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

export function pushPendingGuiCursorSnapshots(
  snapshots: UsageSnapshot[],
  cursor: AntigravityGuiCursor,
  collectedAt: string,
  emittedKeys: Set<string>
) {
  for (const [eventKey, entry] of Object.entries(cursor.files)) {
    if (!entry.pendingUpload || entry.snapshots.length === 0) continue
    pushCachedSnapshots(snapshots, entry, collectedAt, emittedKeys, eventKey)
  }
}

export function shouldRequestCascade(input: {
  cascade: AntigravityCascadeRef
  cursor: AntigravityGuiCursor
  source: AntigravityGuiSource
}) {
  const entry = input.cursor.files[cascadeCursorKey(input.source, input.cascade.id)]
  return !entry || entry.mtimeMs !== input.cascade.mtimeMs || entry.size !== input.cascade.size
}

export function markCascadeProcessed(input: {
  cascade: AntigravityCascadeRef
  cursor: AntigravityGuiCursor
  source: AntigravityGuiSource
}) {
  const key = cascadeCursorKey(input.source, input.cascade.id)
  input.cursor.files[key] = newCursorEntry({
    snapshots: [],
    marker: key,
    mtimeMs: input.cascade.mtimeMs,
    pendingUpload: false,
    size: input.cascade.size
  })
}

function buildSnapshot(input: {
  event: AntigravityUsageEvent
  cursor: AntigravityGuiCursor
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

function newCursorEntry(input: {
  snapshots: Array<Omit<UsageSnapshot, 'collectedAt'>>
  marker: string
  mtimeMs: number
  pendingUpload: boolean
  size?: number
}): CursorEntry {
  return {
    size: input.size ?? 0,
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

function cascadeCursorKey(source: AntigravityGuiSource, cascadeId: string) {
  return ['cascade', source, hash(cascadeId)].join('\0')
}

function usageSessionKey(event: AntigravityUsageEvent, usageDate: string, source: AntigravityGuiSource) {
  return ['session', source, usageDate, event.model, event.cascadeHash].join('\0')
}
