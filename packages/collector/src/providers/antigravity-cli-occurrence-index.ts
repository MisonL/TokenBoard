import type { CursorEntry } from './session-cursor-store'
import type { StatuslineEvent } from './antigravity-cli-statusline'

type OccurrenceBucket = {
  available: Set<string>
  byMtime: Map<number, string[]>
  byMtimeIndex: Map<number, number>
  mtimeByKey: Map<string, number>
  ordered: string[]
  nextIndex: number
}

export type CliStatuslineOccurrenceIndex = {
  crossSource: Map<string, OccurrenceBucket>
  byModel: Map<string, OccurrenceBucket>
  claimed: Set<string>
}

export function buildCliStatuslineOccurrenceIndex(cursor: { files: Record<string, CursorEntry> }) {
  const index: CliStatuslineOccurrenceIndex = {
    crossSource: new Map(),
    byModel: new Map(),
    claimed: new Set()
  }
  for (const [key, entry] of Object.entries(cursor.files)) {
    if (entry.snapshots.length === 0) continue
    const signature = storedStatuslineSignature(key)
    if (!signature) continue
    const available = !cursor.files[historyStatuslineClaimKey(key)]
    addOccurrence(index.crossSource, normalizeStatuslineDedupeKey(signature), key, entry, available)
    if (signature.startsWith('event\0')) {
      addOccurrence(index.byModel, signature, key, entry, available)
    }
  }
  for (const bucket of [...index.crossSource.values(), ...index.byModel.values()]) {
    bucket.ordered.sort((left, right) => (
      bucket.mtimeByKey.get(left)! - bucket.mtimeByKey.get(right)! || left.localeCompare(right)
    ))
  }
  return index
}

function addOccurrence(
  buckets: Map<string, OccurrenceBucket>,
  signature: string,
  key: string,
  entry: CursorEntry,
  available: boolean
) {
  const bucket = buckets.get(signature) ?? newOccurrenceBucket()
  buckets.set(signature, bucket)
  if (!available) return
  bucket.available.add(key)
  bucket.mtimeByKey.set(key, entry.mtimeMs)
  bucket.ordered.push(key)
  const byTime = bucket.byMtime.get(entry.mtimeMs) ?? []
  byTime.push(key)
  bucket.byMtime.set(entry.mtimeMs, byTime)
}

export function hasIndexedStatuslineOccurrences(
  index: CliStatuslineOccurrenceIndex,
  statuslineKey: string
) {
  return index.crossSource.has(normalizeStatuslineDedupeKey(statuslineKey))
}

export function takeIndexedStatuslineOccurrence(
  event: StatuslineEvent,
  statuslineKeys: string[],
  index: CliStatuslineOccurrenceIndex
) {
  const capturedAtMs = Date.parse(event.capturedAt)
  const normalizedKeys = [...new Set(statuslineKeys.map(normalizeStatuslineDedupeKey))]
  for (const statuslineKey of normalizedKeys) {
    const bucket = index.crossSource.get(statuslineKey)
    if (!bucket) continue
    const nearest = takeNearestOccurrence(index, bucket, capturedAtMs)
    if (nearest) return nearest
  }
  const modelKeys = [...new Set(statuslineKeys.filter((key) => key.startsWith('event\0')))]
  const selected = earliestAvailableOccurrence(modelKeys, index.byModel, index.claimed)
  return selected ? claimOccurrence(index, selected.bucket, selected.key) : undefined
}

function takeNearestOccurrence(index: CliStatuslineOccurrenceIndex, bucket: OccurrenceBucket, mtimeMs: number) {
  const keys = bucket.byMtime.get(mtimeMs)
  if (keys) {
    let offset = bucket.byMtimeIndex.get(mtimeMs) ?? 0
    while (offset < keys.length && !isAvailable(index, bucket, keys[offset])) offset += 1
    bucket.byMtimeIndex.set(mtimeMs, offset + 1)
    const key = keys[offset]
    if (key) return claimOccurrence(index, bucket, key)
  }
  let nearest: string | undefined
  let nearestDistance = Number.POSITIVE_INFINITY
  for (const key of bucket.available) {
    if (index.claimed.has(key)) continue
    const statuslineAtMs = bucket.mtimeByKey.get(key) ?? Number.POSITIVE_INFINITY
    const distance = statuslineAtMs - mtimeMs
    if (isWithinCrossSourceMatchWindow(statuslineAtMs, mtimeMs) && distance < nearestDistance) {
      nearest = key
      nearestDistance = distance
    }
  }
  return nearest ? claimOccurrence(index, bucket, nearest) : undefined
}

function earliestAvailableOccurrence(
  statuslineKeys: string[],
  buckets: Map<string, OccurrenceBucket>,
  claimed: Set<string>
) {
  let selected: { bucket: OccurrenceBucket; key: string } | undefined
  for (const statuslineKey of statuslineKeys) {
    const bucket = buckets.get(statuslineKey)
    if (!bucket) continue
    while (
      bucket.nextIndex < bucket.ordered.length &&
      (!bucket.available.has(bucket.ordered[bucket.nextIndex]) || claimed.has(bucket.ordered[bucket.nextIndex]))
    ) {
      bucket.nextIndex += 1
    }
    const key = bucket.ordered[bucket.nextIndex]
    if (key && (!selected || occurrenceMtime(bucket, key) < occurrenceMtime(selected.bucket, selected.key))) {
      selected = { bucket, key }
    }
  }
  return selected
}

function occurrenceMtime(bucket: OccurrenceBucket, key: string) {
  return bucket.mtimeByKey.get(key) ?? Number.POSITIVE_INFINITY
}

function claimOccurrence(index: CliStatuslineOccurrenceIndex, bucket: OccurrenceBucket, key: string) {
  index.claimed.add(key)
  bucket.available.delete(key)
  return key
}

function isAvailable(index: CliStatuslineOccurrenceIndex, bucket: OccurrenceBucket, key: string) {
  return bucket.available.has(key) && !index.claimed.has(key)
}

function newOccurrenceBucket(): OccurrenceBucket {
  return {
    available: new Set(),
    byMtime: new Map(),
    byMtimeIndex: new Map(),
    mtimeByKey: new Map(),
    ordered: [],
    nextIndex: 0
  }
}

export function historyStatuslineClaimKey(statuslineKey: string) {
  return ['history-statusline-claim', statuslineKey].join('\0')
}

const occurrencePrefix = 'statusline-occurrence\0'
const crossSourceMatchWindowMs = 30_000

export function isWithinCrossSourceMatchWindow(statuslineAtMs: number, historyAtMs: number) {
  const delayMs = statuslineAtMs - historyAtMs
  return delayMs >= 0 && delayMs <= crossSourceMatchWindowMs
}

export function statuslineDedupeKey(event: StatuslineEvent, conversationHash: string) {
  return [
    dedupeKeyPrefix,
    conversationHash,
    event.inputTokens,
    event.outputTokens,
    event.cacheCreationTokens,
    event.cacheReadTokens
  ].join('\0')
}

export function normalizeStatuslineDedupeKey(key: string) {
  if (key.startsWith(`${dedupeKeyPrefix}\0`)) return key
  const parts = key.split('\0')
  if (parts[0] !== 'event' || parts.length < 7) return key
  return [dedupeKeyPrefix, parts[1], ...parts.slice(-4)].join('\0')
}

function storedStatuslineSignature(key: string) {
  if (key.startsWith(occurrencePrefix)) {
    const separator = key.lastIndexOf('\0')
    if (separator <= occurrencePrefix.length) return undefined
    return key.slice(occurrencePrefix.length, separator)
  }
  if (key.startsWith('event\0') || key.startsWith(`${dedupeKeyPrefix}\0`)) {
    return key
  }
  return undefined
}

const dedupeKeyPrefix = 'event-v2'
