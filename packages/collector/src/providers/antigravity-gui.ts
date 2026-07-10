import { homedir } from 'node:os'
import { join } from 'node:path'
import type { UsageSnapshot } from '@tokenboard/usage-core'
import {
  cursorFileName,
  readCursor,
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

  constructor(message: string, snapshots: UsageSnapshot[]) {
    super(message)
    this.name = 'AntigravityPartialUsageError'
    this.snapshots = snapshots
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
    let request
    try {
      request = await createRequestContext(options)
      for (const cascade of uncapturedCascades) {
        const response = await request.requestGeneratorMetadata({ source: options.source, cascadeId: cascade.id })
        let hasUsableEvents = false
        for (const event of parseGeneratorMetadata(response, cascade.id)) {
          hasUsableEvents = true
          pushGuiUsageEvent({ event, cursor, snapshots, emittedKeys, timezone, collectedAt, source: options.source })
        }
        if (hasUsableEvents) {
          markCascadeProcessed({ cascade, cursor, source: options.source })
          await writeCursor(cursorPath, cursor)
        }
      }
    } catch (error) {
      pushCompleteGuiCursorSnapshots(snapshots, cursor, collectedAt, emittedKeys)
      await writeCursor(cursorPath, cursor)
      if (snapshots.length > 0 && isUnavailableLanguageServerError(error)) {
        throw new AntigravityPartialUsageError(
          `Antigravity language server unavailable after DB history was collected: ${errorMessage(error)}`,
          mergeSnapshots(snapshots)
        )
      }
      throw error
    } finally {
      await request?.close()
    }
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
  return !input.localDbUsage.cascadeIds.has(input.cascade.id) &&
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

function isUnavailableDbError(error: unknown) {
  if (!(error instanceof Error)) return false
  return error.message.startsWith('Antigravity SQLite reader unavailable:') ||
    error.message.startsWith('Antigravity conversations directory not found:')
}

function isUnavailableLanguageServerError(error: unknown) {
  if (!(error instanceof Error)) return false
  return error.message.includes('Antigravity language server exited before it was ready') ||
    error.message.includes('Timed out starting Antigravity language server') ||
    error.message.match(/^spawn .*(Antigravity.*language_server|tokenboard-antigravity-language-server) ENOENT/) !== null
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function readStateDir() {
  return process.env.TOKENBOARD_STATE_DIR || process.env.TOKENBOARD_CONFIG_DIR || join(homedir(), '.tokenboard')
}

function defaultConversationDir(source: AntigravityGuiSource) {
  return join(homedir(), '.gemini', source, 'conversations')
}
