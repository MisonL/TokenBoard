import type { CursorEntry } from './session-cursor-store'

type HistoryOccurrence = {
  eventHash: string
  key: string
  mtimeMs: number
}

type HistoryOccurrenceBucket = {
  occurrences: HistoryOccurrence[]
}

export type CliHistoryOccurrenceIndex = {
  buckets: Map<string, HistoryOccurrenceBucket>
  claimed: Set<string>
}

export function buildCliHistoryOccurrenceIndex(cursor: { files: Record<string, CursorEntry> }) {
  const index: CliHistoryOccurrenceIndex = { buckets: new Map(), claimed: new Set() }
  for (const [key, entry] of Object.entries(cursor.files)) {
    const parsed = parseHistoryOccurrenceKey(key)
    if (!parsed || cursor.files[historyOccurrenceClaimKey(parsed.eventHash)]) continue
    const bucket = index.buckets.get(parsed.signature) ?? { occurrences: [] }
    index.buckets.set(parsed.signature, bucket)
    bucket.occurrences.push({ eventHash: parsed.eventHash, key, mtimeMs: entry.mtimeMs })
  }
  for (const bucket of index.buckets.values()) {
    bucket.occurrences.sort((left, right) => left.mtimeMs - right.mtimeMs || left.key.localeCompare(right.key))
  }
  return index
}

export function takeIndexedHistoryOccurrence(input: {
  index: CliHistoryOccurrenceIndex
  statuslineKeys: string[]
  capturedAt: string
}) {
  const capturedAtMs = Date.parse(input.capturedAt)
  let selected: HistoryOccurrence | undefined
  let selectedDelay = Number.POSITIVE_INFINITY
  for (const statuslineKey of input.statuslineKeys) {
    const bucket = input.index.buckets.get(statuslineKey)
    if (!bucket) continue
    for (const occurrence of bucket.occurrences) {
      if (input.index.claimed.has(occurrence.eventHash)) continue
      const delay = capturedAtMs - occurrence.mtimeMs
      if (delay < 0 || delay > historyStatuslineMatchWindowMs || delay >= selectedDelay) continue
      selected = occurrence
      selectedDelay = delay
    }
  }
  if (!selected) return undefined
  input.index.claimed.add(selected.eventHash)
  return selected.eventHash
}

export function historyOccurrenceKey(statuslineKey: string, eventHash: string) {
  return [historyOccurrencePrefix, statuslineKey, eventHash].join('\0')
}

export function historyOccurrenceClaimKey(eventHash: string) {
  return [historyOccurrenceClaimPrefix, eventHash].join('\0')
}

export function shouldTrackHistoryOccurrence(historyAt: string, collectedAt: string) {
  const ageMs = Date.parse(collectedAt) - Date.parse(historyAt)
  return ageMs >= 0 && ageMs <= historyStatuslineMatchWindowMs
}

function parseHistoryOccurrenceKey(key: string) {
  if (!key.startsWith(`${historyOccurrencePrefix}\0`)) return undefined
  const separator = key.lastIndexOf('\0')
  const eventHash = key.slice(separator + 1)
  if (!/^[a-f0-9]{64}$/.test(eventHash)) return undefined
  const signature = key.slice(historyOccurrencePrefix.length + 1, separator)
  return signature ? { eventHash, signature } : undefined
}

const historyOccurrencePrefix = 'history-occurrence'
const historyOccurrenceClaimPrefix = 'statusline-history-claim'
const historyStatuslineMatchWindowMs = 30_000
