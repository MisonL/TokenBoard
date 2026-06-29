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
  markCascadeProcessed,
  pushGuiUsageEvent,
  pushPendingGuiCursorSnapshots,
  shouldRequestCascade
} from './antigravity-gui-cursor'

export type AntigravityGuiSource = 'antigravity' | 'antigravity-ide'

export type CollectAntigravityGuiUsageOptions = {
  source: AntigravityGuiSource
  timezone?: string
  collectedAt?: string
  stateDir?: string
  conversationDir?: string
  languageServerPath?: string
  overrideIdeVersion?: string
  listCascadeIds?: () => Promise<string[]>
  listCascades?: () => Promise<AntigravityCascadeRef[]>
  requestGeneratorMetadata?: (input: AntigravityGeneratorMetadataRequest) => Promise<unknown>
  readDbUsageEvents?: () => Promise<AntigravityDbUsageResult>
  maxLanguageServerCascades?: number
}

const defaultMaxLanguageServerCascades = 12

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
  const cursorPath = join(stateDir, cursorFileName(options.source))
  const cursor = await readCursor(cursorPath, options.source)
  const snapshots: UsageSnapshot[] = []
  const emittedKeys = new Set<string>()
  pushPendingGuiCursorSnapshots(snapshots, cursor, collectedAt, emittedKeys)

  const { usage: localDbUsage, error: localDbError } = await readLocalDbUsage(options)
  for (const event of localDbUsage.events) {
    pushGuiUsageEvent({ event, cursor, snapshots, emittedKeys, timezone, collectedAt, source: options.source })
  }

  if (localDbError && !isUnavailableDbError(localDbError)) {
    throw localDbError
  }

  const uncapturedCascades = await listUncapturedLanguageServerCascades({ options, cursor, localDbUsage })
  if (uncapturedCascades.length > 0) {
    const request = await createRequestContext(options)
    try {
      for (const cascade of uncapturedCascades) {
        const response = await request.requestGeneratorMetadata({ source: options.source, cascadeId: cascade.id })
        let hasUsableEvents = false
        for (const event of parseGeneratorMetadata(response, cascade.id)) {
          hasUsableEvents = true
          pushGuiUsageEvent({ event, cursor, snapshots, emittedKeys, timezone, collectedAt, source: options.source })
        }
        if (hasUsableEvents) {
          markCascadeProcessed({ cascade, cursor, source: options.source })
        }
      }
    } finally {
      await request.close()
    }
  }

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
    includeCascade: (cascade) => shouldRequestLanguageServerCascade({
      cascade,
      cursor: input.cursor,
      localDbUsage: input.localDbUsage,
      source: options.source
    })
  })
}

function shouldRequestLanguageServerCascade(input: {
  cascade: AntigravityCascadeRef
  cursor: Awaited<ReturnType<typeof readCursor>>
  localDbUsage: AntigravityDbUsageResult
  source: AntigravityGuiSource
}) {
  return !input.localDbUsage.cascadeIds.has(input.cascade.id) &&
    shouldRequestCascade({ cascade: input.cascade, cursor: input.cursor, source: input.source })
}

async function readLocalDbUsage(options: CollectAntigravityGuiUsageOptions): Promise<{
  usage: AntigravityDbUsageResult
  error?: unknown
}> {
  try {
    return {
      usage: await readLocalDbUsageOrThrow(options)
    }
  } catch (error) {
    return {
      usage: { cascadeIds: new Set<string>(), events: [] },
      error
    }
  }
}

async function readLocalDbUsageOrThrow(options: CollectAntigravityGuiUsageOptions) {
  if (options.readDbUsageEvents) return options.readDbUsageEvents()
  if (options.requestGeneratorMetadata) {
    return { cascadeIds: new Set<string>(), events: [] }
  }
  return readAntigravityDbUsageEvents({
    conversationDir: options.conversationDir ?? defaultConversationDir(options.source)
  })
}

function isUnavailableDbError(error: unknown) {
  if (!(error instanceof Error)) return false
  return error.message.startsWith('Antigravity SQLite reader unavailable:') ||
    error.message.startsWith('Antigravity conversations directory not found:')
}

function readStateDir() {
  return process.env.TOKENBOARD_STATE_DIR || process.env.TOKENBOARD_CONFIG_DIR || join(homedir(), '.tokenboard')
}

function defaultConversationDir(source: AntigravityGuiSource) {
  return join(homedir(), '.gemini', source, 'conversations')
}
