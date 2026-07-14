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

export type CliStatuslineOccurrenceIndex = Map<string, OccurrenceBucket>

export function buildCliStatuslineOccurrenceIndex(cursor: { files: Record<string, CursorEntry> }) {
  const index: CliStatuslineOccurrenceIndex = new Map()
  for (const [key, entry] of Object.entries(cursor.files)) {
    if (!key.startsWith(occurrencePrefix) || entry.snapshots.length === 0) continue
    const separator = key.lastIndexOf('\0')
    const signature = key.slice(occurrencePrefix.length, separator)
    const bucket = index.get(signature) ?? newOccurrenceBucket()
    index.set(signature, bucket)
    if (cursor.files[historyStatuslineClaimKey(key)]) continue
    bucket.available.add(key)
    bucket.mtimeByKey.set(key, entry.mtimeMs)
    bucket.ordered.push(key)
    const byTime = bucket.byMtime.get(entry.mtimeMs) ?? []
    byTime.push(key)
    bucket.byMtime.set(entry.mtimeMs, byTime)
  }
  for (const bucket of index.values()) {
    bucket.ordered.sort((left, right) => (
      bucket.mtimeByKey.get(left)! - bucket.mtimeByKey.get(right)! || left.localeCompare(right)
    ))
  }
  return index
}

export function hasIndexedStatuslineOccurrences(
  index: CliStatuslineOccurrenceIndex,
  statuslineKey: string
) {
  return index.has(statuslineKey)
}

export function takeIndexedStatuslineOccurrence(
  event: StatuslineEvent,
  statuslineKeys: string[],
  index: CliStatuslineOccurrenceIndex
) {
  const capturedAtMs = Date.parse(event.capturedAt)
  for (const statuslineKey of statuslineKeys) {
    const bucket = index.get(statuslineKey)
    if (!bucket) continue
    const exact = takeExactOccurrence(bucket, capturedAtMs)
    if (exact) return exact
  }
  const selected = earliestAvailableOccurrence(statuslineKeys, index)
  return selected ? claimOccurrence(selected.bucket, selected.key) : undefined
}

function takeExactOccurrence(bucket: OccurrenceBucket, mtimeMs: number) {
  const keys = bucket.byMtime.get(mtimeMs)
  if (!keys) return undefined
  let index = bucket.byMtimeIndex.get(mtimeMs) ?? 0
  while (index < keys.length && !bucket.available.has(keys[index])) index += 1
  bucket.byMtimeIndex.set(mtimeMs, index + 1)
  const key = keys[index]
  return key ? claimOccurrence(bucket, key) : undefined
}

function earliestAvailableOccurrence(
  statuslineKeys: string[],
  index: CliStatuslineOccurrenceIndex
) {
  let selected: { bucket: OccurrenceBucket; key: string } | undefined
  for (const statuslineKey of statuslineKeys) {
    const bucket = index.get(statuslineKey)
    if (!bucket) continue
    while (bucket.nextIndex < bucket.ordered.length && !bucket.available.has(bucket.ordered[bucket.nextIndex])) {
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

function claimOccurrence(bucket: OccurrenceBucket, key: string) {
  bucket.available.delete(key)
  return key
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
