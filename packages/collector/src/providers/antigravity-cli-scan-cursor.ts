import { createHash } from 'node:crypto'
import type { CursorState } from './session-cursor-store'
import { isReusableAntigravityHistoryScope } from './antigravity-since'

export function readCliStatuslineScanStart(input: {
  cursor: CursorState
  eventSizeBytes: number
  generation?: string
  previousGeneration?: string
  retainedFromOffsetBytes?: number
  compactLineage?: boolean
  headerBytes?: number
  historyScope: string
}) {
  if (input.historyScope === 'all') {
    if (input.generation === input.cursor.lastScanGeneration) {
      return scanStartOffset(input.cursor.lastScanOffsetBytes, input.eventSizeBytes)
    }
    const translated = translatePreviousGenerationOffset({
      ...input,
      previousOffsetBytes: input.cursor.lastScanOffsetBytes,
      matchesPreviousGeneration: lineageMatches({
        ...input,
        previousGenerationHash: generationHash(input.cursor.lastScanGeneration)
      })
    })
    return translated ?? 0
  }

  const candidate = latestReusableBoundedScan(input.cursor, input.historyScope)
  if (!candidate) return 0
  if (candidate.entry.sha256 === generationHash(input.generation)) {
    return scanStartOffset(candidate.entry.size, input.eventSizeBytes)
  }
  const translated = translatePreviousGenerationOffset({
    ...input,
    previousOffsetBytes: candidate.entry.size,
    matchesPreviousGeneration: lineageMatches({
      ...input,
      previousGenerationHash: candidate.entry.sha256
    })
  })
  return translated ?? 0
}

function lineageMatches(input: {
  generation?: string
  previousGeneration?: string
  retainedFromOffsetBytes?: number
  compactLineage?: boolean
  previousGenerationHash: string
}) {
  if (!input.compactLineage) {
    return input.previousGenerationHash === generationHash(input.previousGeneration)
  }
  if (input.generation === undefined || input.retainedFromOffsetBytes === undefined) return false
  return input.generation === deriveCompactedGeneration(
    input.previousGenerationHash,
    input.retainedFromOffsetBytes
  )
}

function deriveCompactedGeneration(previousGenerationHash: string, retainedFromOffsetBytes: number) {
  return createHash('sha256')
    .update(previousGenerationHash)
    .update('\0')
    .update(String(retainedFromOffsetBytes))
    .digest('hex')
    .slice(0, 32)
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

function translatePreviousGenerationOffset(input: {
  eventSizeBytes: number
  retainedFromOffsetBytes?: number
  headerBytes?: number
  previousOffsetBytes?: number
  matchesPreviousGeneration: boolean
}) {
  if (!input.matchesPreviousGeneration || input.previousOffsetBytes === undefined ||
      input.retainedFromOffsetBytes === undefined || input.headerBytes === undefined ||
      !Number.isSafeInteger(input.previousOffsetBytes) || input.previousOffsetBytes < 0) return null
  if (!Number.isSafeInteger(input.retainedFromOffsetBytes) || input.retainedFromOffsetBytes < 0 ||
      !Number.isSafeInteger(input.headerBytes) || input.headerBytes < 0) return null
  if (input.previousOffsetBytes < input.retainedFromOffsetBytes) return 0
  return scanStartOffset(
    input.headerBytes + input.previousOffsetBytes - input.retainedFromOffsetBytes,
    input.eventSizeBytes
  )
}

function generationHash(generation?: string) {
  return createHash('sha256').update(generation ?? 'legacy').digest('hex')
}

const boundedScanPrefix = 'statusline-scan\0since:'
