import { join } from 'node:path'
import type { UsageSnapshot } from '@tokenboard/usage-core'
import {
  cursorFileName,
  readCursor,
  withCursorLock,
  writeCursor
} from './session-cursor-store'
import { mergeSnapshots } from './session-cursor'
import {
  createAntigravityLanguageServerClient,
  listAntigravityCascades,
  type AntigravityCascadeRef,
  type AntigravityGeneratorMetadataRequest
} from './antigravity-gui-client'
import { parseGeneratorMetadata } from './antigravity-gui-parser'
import { readAntigravityDbUsageEvents, type AntigravityDbUsageResult } from './antigravity-history-db'
import {
  hasDbCascadeRowsProcessed,
  lastSeenDbRowIndexByCascadeHash,
  markDbCascadeRowsProcessed,
  markCascadeProcessed,
  pushCompleteGuiCursorSnapshots,
  pushGuiUsageEvent,
  shouldRequestCascade
} from './antigravity-gui-cursor'
import {
  defaultConversationDir, errorMessage, isUnavailableDbError,
  isUnavailableLanguageServerError, readStateDir
} from './antigravity-gui-environment'

export type AntigravityGuiSource = 'antigravity' | 'antigravity-ide'

export type CollectAntigravityGuiUsageOptions = {
  source: AntigravityGuiSource
  timezone?: string
  collectedAt?: string
  stateDir?: string
  cursorScope?: string
  conversationDir?: string
  languageServerPath?: string
  overrideIdeVersion?: string
  listCascadeIds?: () => Promise<string[]>
  listCascades?: () => Promise<AntigravityCascadeRef[]>
  requestGeneratorMetadata?: (input: AntigravityGeneratorMetadataRequest) => Promise<unknown>
  readDbUsageEvents?: (input?: {
    lastSeenRowIndexByCascadeHash?: Map<string, number>
    maxDbFiles?: number | null
  }) => Promise<AntigravityDbUsageResult>
  maxLanguageServerCascades?: number
  maxDbFiles?: number | null
}

const defaultMaxLanguageServerCascades = 12

export class AntigravityPartialUsageError extends Error {
  readonly snapshots: UsageSnapshot[]

  constructor(message: string, snapshots: UsageSnapshot[], cause?: unknown) {
    super(message)
    this.name = 'AntigravityPartialUsageError'
    this.snapshots = snapshots
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', { value: cause, configurable: true })
    }
  }
}

export function isAntigravityPartialUsageError(error: unknown): error is AntigravityPartialUsageError {
  return error instanceof AntigravityPartialUsageError
}

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
  const cursorPath = join(stateDir, cursorFileName(options.source, options.cursorScope))
  return withCursorLock(cursorPath, () => collectAntigravityGuiUsageLocked({
    options, timezone, collectedAt, cursorPath
  }))
}

async function collectAntigravityGuiUsageLocked(input: {
  options: CollectAntigravityGuiUsageOptions
  timezone: string
  collectedAt: string
  cursorPath: string
}) {
  const { options, timezone, collectedAt, cursorPath } = input
  const cursor = await readCursor(cursorPath, options.source)
  const snapshots: UsageSnapshot[] = []
  const emittedKeys = new Set<string>()

  const { usage: localDbUsage, error: localDbError } = await readLocalDbUsage(options, cursor)
  for (const event of localDbUsage.events) {
    pushGuiUsageEvent({ event, cursor, snapshots, emittedKeys, timezone, collectedAt, source: options.source })
  }

  if (localDbError && !isUnavailableDbError(localDbError)) {
    throw localDbError
  }

  const uncapturedCascades = await listUncapturedLanguageServerCascades({ options, cursor, localDbUsage })
  if (uncapturedCascades.length > 0) {
    await collectLanguageServerUsage({
      options, cursor, cursorPath, snapshots, emittedKeys, timezone, collectedAt,
      localDbUsage, uncapturedCascades
    })
  }

  markDbCascadeRowsProcessed({
    cursor,
    source: options.source,
    lastReadRowIndexByCascade: localDbUsage.lastReadRowIndexByCascade
  })
  pushCompleteGuiCursorSnapshots(snapshots, cursor, collectedAt, emittedKeys)
  await writeCursor(cursorPath, cursor)
  return mergeSnapshots(snapshots)
}

async function collectLanguageServerUsage(input: {
  options: CollectAntigravityGuiUsageOptions
  cursor: Awaited<ReturnType<typeof readCursor>>
  cursorPath: string
  snapshots: UsageSnapshot[]
  emittedKeys: Set<string>
  timezone: string
  collectedAt: string
  localDbUsage: AntigravityDbUsageResult
  uncapturedCascades: AntigravityCascadeRef[]
}) {
  let request
  let collectionFailed = false
  let collectionError: unknown
  const cleanupErrors: unknown[] = []
  try {
    request = await createRequestContext(input.options)
    await requestLanguageServerUsage(input, request)
  } catch (error) {
    collectionFailed = true
    collectionError = error
    await preservePartialGuiUsage(input, cleanupErrors)
  } finally {
    try {
      await request?.close()
    } catch (closeError) {
      cleanupErrors.push(closeError)
    }
  }
  if (collectionFailed) {
    throw guiCollectionError(collectionError, input.snapshots, cleanupErrors)
  }
  if (cleanupErrors.length > 0) throw cleanupErrors[0]
}

async function requestLanguageServerUsage(
  input: Parameters<typeof collectLanguageServerUsage>[0],
  request: Awaited<ReturnType<typeof createRequestContext>>
) {
  for (const cascade of input.uncapturedCascades) {
    const response = await request.requestGeneratorMetadata({ source: input.options.source, cascadeId: cascade.id })
    let hasUsableEvents = false
    for (const event of parseGeneratorMetadata(response, cascade.id)) {
      hasUsableEvents = true
      pushGuiUsageEvent({
        event,
        cursor: input.cursor,
        snapshots: input.snapshots,
        emittedKeys: input.emittedKeys,
        timezone: input.timezone,
        collectedAt: input.collectedAt,
        source: input.options.source
      })
    }
    if (!hasUsableEvents) continue
    markCascadeProcessed({ cascade, cursor: input.cursor, source: input.options.source })
    await writeCursor(input.cursorPath, input.cursor)
  }
}

async function preservePartialGuiUsage(
  input: Parameters<typeof collectLanguageServerUsage>[0],
  cleanupErrors: unknown[]
) {
  try {
    markDbCascadeRowsProcessed({
      cursor: input.cursor,
      source: input.options.source,
      lastReadRowIndexByCascade: input.localDbUsage.lastReadRowIndexByCascade
    })
    pushCompleteGuiCursorSnapshots(input.snapshots, input.cursor, input.collectedAt, input.emittedKeys)
    await writeCursor(input.cursorPath, input.cursor)
  } catch (cleanupError) {
    cleanupErrors.push(cleanupError)
  }
}

function guiCollectionError(
  error: unknown,
  snapshots: UsageSnapshot[],
  cleanupErrors: unknown[]
) {
  const cause = cleanupErrorCause(cleanupErrors)
  if (snapshots.length > 0 && isUnavailableLanguageServerError(error)) {
    return new AntigravityPartialUsageError(
      `Antigravity language server unavailable after DB history was collected: ${errorMessage(error)}`,
      mergeSnapshots(snapshots),
      cause
    )
  }
  if (!(error instanceof Error) || cause === undefined) return error
  attachCleanupCause(error, cause)
  return error
}

function attachCleanupCause(error: Error, cause: unknown) {
  const existingCause = (error as Error & { cause?: unknown }).cause
  const combinedCause = existingCause === undefined
    ? cause
    : new AggregateError([existingCause, cause], 'Antigravity collection cleanup failed')
  try {
    Object.defineProperty(error, 'cause', { value: combinedCause, configurable: true })
  } catch {
    // Preserve the primary error even if a third-party error object is immutable.
  }
}

function cleanupErrorCause(errors: unknown[]) {
  if (errors.length === 0) return undefined
  if (errors.length === 1) return errors[0]
  return new AggregateError(errors, 'Antigravity collection cleanup failed')
}

async function createRequestContext(options: CollectAntigravityGuiUsageOptions) {
  if (options.requestGeneratorMetadata) {
    return {
      requestGeneratorMetadata: options.requestGeneratorMetadata,
      close: async () => undefined
    }
  }
  const client = await createAntigravityLanguageServerClient(options)
  return { requestGeneratorMetadata: client.requestGeneratorMetadata, close: client.close }
}

async function listUncapturedLanguageServerCascades(input: {
  options: CollectAntigravityGuiUsageOptions
  cursor: Awaited<ReturnType<typeof readCursor>>
  localDbUsage: AntigravityDbUsageResult
}) {
  const maxCascades = normalizeMaxLanguageServerCascades(input.options.maxLanguageServerCascades)
  const cascades = await readLanguageServerCascadeRefs({ ...input, maxCascades })
  markDbCascadeRowsProcessed({
    coveredCascadeIds: input.localDbUsage.cascadeIds,
    coveredCascades: cascades,
    cursor: input.cursor,
    source: input.options.source
  })
  return cascades
    .filter((cascade) => shouldRequestLanguageServerCascade({
      cascade,
      cursor: input.cursor,
      localDbUsage: input.localDbUsage,
      source: input.options.source
    }))
    .slice(0, maxCascades)
}

function normalizeMaxLanguageServerCascades(value: number | undefined) {
  if (value === undefined) return defaultMaxLanguageServerCascades
  if (!Number.isFinite(value) || value < 0) return defaultMaxLanguageServerCascades
  return Math.floor(value)
}

async function readLanguageServerCascadeRefs(input: {
  options: CollectAntigravityGuiUsageOptions
  cursor: Awaited<ReturnType<typeof readCursor>>
  localDbUsage: AntigravityDbUsageResult
  maxCascades: number
}) {
  const { options } = input
  if (options.listCascades) return options.listCascades()
  if (options.listCascadeIds) {
    const ids = await options.listCascadeIds()
    return ids.map((id) => ({ id, mtimeMs: 0, size: 0 }))
  }
  return listAntigravityCascades({
    ...options,
    limit: input.maxCascades,
    requiredCascadeIds: requiredLanguageServerCascadeIds({
      cursor: input.cursor,
      localDbUsage: input.localDbUsage,
      source: options.source
    }),
    includeCascade: (cascade) => {
      if (input.localDbUsage.cascadeIds.has(cascade.id)) {
        markDbCascadeRowsProcessed({
          coveredCascadeIds: input.localDbUsage.cascadeIds,
          coveredCascades: [cascade],
          cursor: input.cursor,
          source: options.source
        })
      }
      return shouldRequestLanguageServerCascade({
        cascade,
        cursor: input.cursor,
        localDbUsage: input.localDbUsage,
        source: options.source
      })
    }
  })
}

function requiredLanguageServerCascadeIds(input: {
  cursor: Awaited<ReturnType<typeof readCursor>>
  localDbUsage: AntigravityDbUsageResult
  source: AntigravityGuiSource
}) {
  return new Set([
    ...input.localDbUsage.cascadeIds,
    ...(input.localDbUsage.lastReadRowIndexByCascade?.keys() ?? [])
  ])
}

function shouldRequestLanguageServerCascade(input: {
  cascade: AntigravityCascadeRef
  cursor: Awaited<ReturnType<typeof readCursor>>
  localDbUsage: AntigravityDbUsageResult
  source: AntigravityGuiSource
}) {
  const databaseScanPending = input.cascade.hasDatabaseFile &&
    !input.localDbUsage.lastReadRowIndexByCascade?.has(input.cascade.id)
  return !databaseScanPending &&
    !input.localDbUsage.cascadeIds.has(input.cascade.id) &&
    !hasDbCascadeRowsProcessed({
      cascade: input.cascade,
      cursor: input.cursor,
      source: input.source
    }) &&
    shouldRequestCascade({ cascade: input.cascade, cursor: input.cursor, source: input.source })
}

async function readLocalDbUsage(
  options: CollectAntigravityGuiUsageOptions,
  cursor: Awaited<ReturnType<typeof readCursor>>
): Promise<{
  usage: AntigravityDbUsageResult
  error?: unknown
}> {
  try {
    return {
      usage: await readLocalDbUsageOrThrow(options, cursor)
    }
  } catch (error) {
    return {
      usage: { cascadeIds: new Set<string>(), events: [] },
      error
    }
  }
}

async function readLocalDbUsageOrThrow(
  options: CollectAntigravityGuiUsageOptions,
  cursor: Awaited<ReturnType<typeof readCursor>>
) {
  if (options.readDbUsageEvents) {
    return options.readDbUsageEvents({
      lastSeenRowIndexByCascadeHash: lastSeenDbRowIndexByCascadeHash({ cursor, source: options.source }),
      maxDbFiles: resolveMaxDbFiles(options.maxDbFiles)
    })
  }
  if (options.requestGeneratorMetadata) {
    return { cascadeIds: new Set<string>(), events: [] }
  }
  return readAntigravityDbUsageEvents({
    conversationDir: options.conversationDir ?? defaultConversationDir(options.source),
    lastSeenRowIndexByCascadeHash: lastSeenDbRowIndexByCascadeHash({ cursor, source: options.source }),
    maxDbFiles: resolveMaxDbFiles(options.maxDbFiles)
  })
}

function resolveMaxDbFiles(value: number | null | undefined) {
  return value === undefined ? defaultMaxDbFilesForCurrentRun() : value
}

function defaultMaxDbFilesForCurrentRun() {
  const since = process.env.TOKENBOARD_SINCE || process.env.TOKENBOARD_DEFAULT_SINCE || ''
  return since === 'all' ? null : undefined
}
