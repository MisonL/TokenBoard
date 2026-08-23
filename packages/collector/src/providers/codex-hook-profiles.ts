import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { UsageSnapshot } from '@tokenboard/usage-core'
import {
  collectHookIncremental,
  readStateDir,
  type HookIncrementalResult,
  type HookPendingSnapshotEntry,
  type HookReconciliationFileEntry
} from './hook-incremental'
import {
  cursorFileName,
  readCursor,
  withCursorLock,
  writeCursor,
  type CursorEntry
} from './session-cursor-store'

type CodexHookProfileInput = {
  codexHomes: string[]
  stateDir?: string
  stderr?: (line: string) => void
  timezone: string
  collectedAt: string
}

export type CodexHookProfilesResult = {
  changed: boolean
  rangeArgs: string[]
  changedDates: string[]
  changedKeys: Array<{ usageDate: string; model: string }>
  cachedSnapshots: UsageSnapshot[]
}

export type CodexHookCursorPlan = {
  cursorNames: string[]
  cursorScopes: Array<string | undefined>
  usesProfileCursors: boolean
}

export async function collectCodexHookProfiles(
  input: CodexHookProfileInput
): Promise<CodexHookProfilesResult> {
  const stateDir = input.stateDir ?? readStateDir()
  const plan = await resolveCodexHookCursorPlan({ codexHomes: input.codexHomes, stateDir })
  const hasLegacyPending = plan.usesProfileCursors && await migrateLegacyCodexHookCursor({
    codexHomes: input.codexHomes,
    stateDir
  })
  const incrementals = await Promise.all(input.codexHomes.map((codexHome, index) =>
    collectHookIncremental({
      source: 'codex',
      sessionsDir: join(codexHome, 'sessions'),
      cursorName: plan.cursorNames[index],
      cursorProfileHash: codexHookProfileHash(codexHome),
      stateDir,
      stderr: input.stderr,
      timezone: input.timezone,
      collectedAt: input.collectedAt,
      includePendingSnapshotEntries: true,
      includeReconciliationFileEntries: true
    })
  ))
  if (hasLegacyPending) {
    incrementals.push(await collectHookIncremental({
      source: 'codex',
      sessionsDir: '',
      cursorName: 'codex-cursor.json',
      stateDir,
      stderr: input.stderr,
      timezone: input.timezone,
      collectedAt: input.collectedAt,
      includePendingSnapshotEntries: true,
      includeReconciliationFileEntries: true,
      skipSessionScan: true
    }))
  }
  return mergeCodexHookIncrementals(incrementals)
}

export function codexHookProfileCursorName(codexHome: string) {
  return cursorFileName('codex', resolve(codexHome))
}

export function codexHookProfileHash(codexHome: string) {
  return createHash('sha256').update(resolve(codexHome)).digest('hex')
}

export async function resolveCodexHookCursorPlan(input: {
  codexHomes: string[]
  stateDir: string
}): Promise<CodexHookCursorPlan> {
  const [legacyCursor, hasProfileCursor] = await Promise.all([
    readLegacyCodexHookCursor(input.stateDir),
    Promise.all(input.codexHomes.map((codexHome) =>
      isRegularFile(join(input.stateDir, codexHookProfileCursorName(codexHome)))
    ))
  ])
  const activeProfileHash = input.codexHomes.length === 1
    ? codexHookProfileHash(input.codexHomes[0])
    : undefined
  const legacyBelongsToActiveProfile = legacyCursor?.codexHookProfileHash === activeProfileHash
  const usesProfileCursors = input.codexHomes.length > 1 ||
    hasProfileCursor.some(Boolean) ||
    (legacyCursor !== null && !legacyBelongsToActiveProfile)
  return {
    cursorNames: usesProfileCursors
      ? input.codexHomes.map(codexHookProfileCursorName)
      : ['codex-cursor.json'],
    cursorScopes: usesProfileCursors ? input.codexHomes : [undefined],
    usesProfileCursors
  }
}

async function readLegacyCodexHookCursor(stateDir: string) {
  const cursorPath = join(stateDir, 'codex-cursor.json')
  if (!await isRegularFile(cursorPath)) return null
  return readCursor(cursorPath, 'codex')
}

async function migrateLegacyCodexHookCursor(input: { codexHomes: string[]; stateDir: string }) {
  const legacyCursorPath = join(input.stateDir, 'codex-cursor.json')
  if (!await isRegularFile(legacyCursorPath)) return false
  return withCursorLock(legacyCursorPath, async () => {
    const legacy = await readCursor(legacyCursorPath, 'codex')
    const persistedMatches = await matchingPersistedLegacyEntries({
      codexHomes: input.codexHomes,
      stateDir: input.stateDir,
      legacy
    })
    let changed = false
    for (const [relativePath, entry] of Object.entries(legacy.files)) {
      if (persistedMatches.has(relativePath)) {
        delete legacy.files[relativePath]
        changed = true
        continue
      }
      const matchingHomes = await matchingCodexHomes({
        codexHomes: input.codexHomes,
        relativePath,
        entry
      })
      if (matchingHomes.length === 0) {
        if (!entry.pendingUpload) {
          delete legacy.files[relativePath]
          changed = true
        }
        continue
      }
      for (const codexHome of matchingHomes) {
        await copyLegacyCursorEntry({ codexHome, relativePath, entry, stateDir: input.stateDir })
      }
      delete legacy.files[relativePath]
      changed = true
    }
    if (changed) await writeCursor(legacyCursorPath, legacy)
    return Object.values(legacy.files).some((entry) => entry.pendingUpload)
  })
}

async function matchingPersistedLegacyEntries(input: {
  codexHomes: string[]
  stateDir: string
  legacy: Awaited<ReturnType<typeof readCursor>>
}) {
  const matches = new Set<string>()
  for (const codexHome of input.codexHomes) {
    const cursorPath = join(input.stateDir, codexHookProfileCursorName(codexHome))
    if (!await isRegularFile(cursorPath)) continue
    await withCursorLock(cursorPath, async () => {
      const cursor = await readCursor(cursorPath, 'codex')
      for (const [relativePath, legacyEntry] of Object.entries(input.legacy.files)) {
        if (!isSha256(legacyEntry.sha256)) continue
        if (cursor.files[relativePath]?.sha256 === legacyEntry.sha256) {
          matches.add(relativePath)
        }
      }
    })
  }
  return matches
}

async function copyLegacyCursorEntry(input: {
  codexHome: string
  relativePath: string
  entry: CursorEntry
  stateDir: string
}) {
  const cursorPath = join(input.stateDir, codexHookProfileCursorName(input.codexHome))
  await withCursorLock(cursorPath, async () => {
    const cursor = await readCursor(cursorPath, 'codex')
    if (cursor.files[input.relativePath]) return
    cursor.files[input.relativePath] = copyCursorEntry(input.entry)
    await writeCursor(cursorPath, cursor)
  })
}

async function matchingCodexHomes(input: {
  codexHomes: string[]
  relativePath: string
  entry: CursorEntry
}) {
  if (!isSha256(input.entry.sha256)) return []
  const matches = await Promise.all(input.codexHomes.map(async (codexHome) => {
    const sessionPath = resolveSessionPath(codexHome, input.relativePath)
    return await matchesLegacySessionContent(sessionPath, input.entry) ? codexHome : null
  }))
  return matches.filter((codexHome): codexHome is string => codexHome !== null)
}

function resolveSessionPath(codexHome: string, relativePath: string) {
  const sessionsDir = join(codexHome, 'sessions')
  const sessionPath = resolve(sessionsDir, relativePath)
  if (!isPathInside(sessionsDir, sessionPath)) {
    throw new Error('Invalid legacy Codex cursor session path')
  }
  return sessionPath
}

async function matchesLegacySessionContent(sessionPath: string, entry: CursorEntry) {
  const details = await lstat(sessionPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw new Error(`Unable to inspect legacy Codex session file: ${error.message}`, { cause: error })
  })
  if (details?.isSymbolicLink()) {
    throw new Error(`Unable to inspect legacy Codex session file: symbolic links are not supported`)
  }
  if (!details?.isFile() || details.size < entry.size || !Number.isSafeInteger(entry.size) || entry.size < 0) {
    return false
  }
  const hash = createHash('sha256')
  if (entry.size > 0) {
    for await (const chunk of createReadStream(sessionPath, { start: 0, end: entry.size - 1 })) {
      hash.update(chunk)
    }
  }
  const after = await lstat(sessionPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw new Error(`Unable to inspect legacy Codex session file: ${error.message}`, { cause: error })
  })
  if (!after || !sameSessionFileMetadata(details, after)) {
    throw new Error('Legacy Codex session file changed while matching profile cursors; retry the sync')
  }
  return hash.digest('hex') === entry.sha256
}

function copyCursorEntry(entry: CursorEntry): CursorEntry {
  return {
    ...entry,
    snapshots: entry.snapshots.map((snapshot) => ({ ...snapshot }))
  }
}

async function isRegularFile(path: string) {
  const details = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw new Error(`Unable to inspect legacy Codex cursor: ${error.message}`, { cause: error })
  })
  if (details?.isSymbolicLink()) {
    throw new Error(`Unable to inspect legacy Codex cursor: symbolic links are not supported`)
  }
  return details?.isFile() ?? false
}

function sameSessionFileMetadata(
  left: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
  right: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }
) {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
}

function isPathInside(parent: string, child: string) {
  const path = relative(parent, child)
  return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)
}

function isSha256(value: string) {
  return /^[a-f0-9]{64}$/.test(value)
}

function mergeCodexHookIncrementals(incrementals: HookIncrementalResult[]): CodexHookProfilesResult {
  const changedDates = new Set<string>()
  const changedKeys = new Map<string, { usageDate: string; model: string }>()
  const pendingSnapshotEntries: HookPendingSnapshotEntry[] = []
  const reconciliationFileEntries = new Set<string>()
  for (const incremental of incrementals) {
    for (const date of incremental.changedDates) changedDates.add(date)
    for (const key of incremental.changedKeys) {
      changedKeys.set(snapshotKey(key), key)
    }
    pendingSnapshotEntries.push(...(incremental.pendingSnapshotEntries ?? []))
    for (const entry of incremental.reconciliationFileEntries ?? []) {
      reconciliationFileEntries.add(reconciliationFileKey(entry))
    }
  }
  const dates = [...changedDates].sort()
  return {
    changed: incrementals.some((incremental) => incremental.changed),
    rangeArgs: dateRangeArgs(dates),
    changedDates: dates,
    changedKeys: [...changedKeys.values()].sort(compareSnapshotKeys),
    cachedSnapshots: deduplicateCopiedPendingSnapshots(pendingSnapshotEntries.filter((entry) =>
      !isPendingSnapshotReconciled(entry, reconciliationFileEntries)
    ))
  }
}

function isPendingSnapshotReconciled(
  entry: HookPendingSnapshotEntry,
  reconciliationFileEntries: ReadonlySet<string>
) {
  return reconciliationFileEntries.has(reconciliationFileKey(entry))
}

function deduplicateCopiedPendingSnapshots(entries: HookPendingSnapshotEntry[]) {
  const snapshots = new Map<string, UsageSnapshot>()
  for (const entry of entries) {
    const key = copiedPendingSnapshotKey(entry)
    snapshots.set(key, entry.snapshot)
  }
  return [...snapshots.values()].sort((left, right) =>
    left.usageDate.localeCompare(right.usageDate) || left.model.localeCompare(right.model)
  )
}

function copiedPendingSnapshotKey(entry: HookPendingSnapshotEntry) {
  const snapshot = entry.snapshot
  return [
    entry.relativePath,
    entry.sha256,
    snapshot.source,
    snapshot.usageDate,
    snapshot.timezone,
    snapshot.model,
    snapshot.inputTokens,
    snapshot.outputTokens,
    snapshot.cacheCreationTokens,
    snapshot.cacheReadTokens,
    snapshot.totalTokens,
    snapshot.costUsd,
    snapshot.sessionCount
  ].join('\0')
}

function reconciliationFileKey(entry: HookReconciliationFileEntry) {
  return [entry.relativePath, entry.sha256].join('\0')
}

function dateRangeArgs(dates: string[]) {
  if (dates.length === 0) return []
  return [
    '--since',
    dates[0].replaceAll('-', ''),
    '--until',
    dates[dates.length - 1].replaceAll('-', '')
  ]
}

function snapshotKey(input: { usageDate: string; model: string }) {
  return `${input.usageDate}\0${input.model}`
}

function compareSnapshotKeys(
  left: { usageDate: string; model: string },
  right: { usageDate: string; model: string }
) {
  return left.usageDate.localeCompare(right.usageDate) || left.model.localeCompare(right.model)
}
