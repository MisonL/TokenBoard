import { createHash } from 'node:crypto'
import type { CursorState } from './session-cursor-store'
import { isReusableAntigravityHistoryScope } from './antigravity-since'

export function readCliStatuslineScanStart(input: {
  cursor: CursorState
  eventSizeBytes: number
  generation?: string
  historyScope: string
}) {
  if (input.historyScope === 'all') {
    const generationChanged = input.generation !== input.cursor.lastScanGeneration &&
      (input.generation !== undefined || input.cursor.lastScanGeneration !== undefined)
    return generationChanged ? 0 : scanStartOffset(input.cursor.lastScanOffsetBytes, input.eventSizeBytes)
  }

  const candidate = latestReusableBoundedScan(input.cursor, input.historyScope)
  if (!candidate || candidate.entry.sha256 !== generationHash(input.generation)) return 0
  return scanStartOffset(candidate.entry.size, input.eventSizeBytes)
}

export function markCliStatuslineScanComplete(input: {
  cursor: CursorState
  eventSizeBytes: number
  generation?: string
  historyScope: string
  collectedAt: string
}) {
  if (input.historyScope === 'all') {
    input.cursor.lastScanOffsetBytes = input.eventSizeBytes
    input.cursor.lastScanGeneration = input.generation
    return
  }

  const key = boundedScanKey(input.historyScope)
  for (const existingKey of Object.keys(input.cursor.files)) {
    if (existingKey.startsWith(boundedScanPrefix) && existingKey !== key) {
      delete input.cursor.files[existingKey]
    }
  }
  input.cursor.files[key] = {
    size: input.eventSizeBytes,
    mtimeMs: Date.parse(input.collectedAt),
    sha256: generationHash(input.generation),
    snapshots: [],
    missingCost: true,
    pendingUpload: false,
    updatedAt: new Date().toISOString()
  }
}

function latestReusableBoundedScan(cursor: CursorState, historyScope: string) {
  return Object.entries(cursor.files)
    .filter(([key]) => key.startsWith(boundedScanPrefix))
    .map(([key, entry]) => ({ scope: key.slice(boundedScanPrefix.length), entry }))
    .filter((candidate) => isReusableAntigravityHistoryScope(candidate.scope, historyScope))
    .sort((left, right) => right.scope.localeCompare(left.scope))[0]
}

function boundedScanKey(historyScope: string) {
  return `${boundedScanPrefix}${historyScope}`
}

function scanStartOffset(value: number | undefined, currentSize: number) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > currentSize) return 0
  return value
}

function generationHash(generation?: string) {
  return createHash('sha256').update(generation ?? 'legacy').digest('hex')
}

const boundedScanPrefix = 'statusline-scan\0since:'
