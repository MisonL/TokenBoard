import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { opendir, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { promisify } from 'node:util'
import type { AntigravityUsageEvent } from './antigravity-gui-parser'
import { parseAntigravityGeneratorMetadataBlobEvents } from './antigravity-history-protobuf'
import {
  beginAntigravityFileScan,
  listAntigravityDirectoryFileNames,
  markAntigravityFileScanned,
  pruneAntigravityFileScanState,
  removeAntigravityFileScanEntry,
  selectAntigravityFileScanIds,
  type AntigravityDirectoryEntry,
  type AntigravityFileScanState
} from './antigravity-file-scan'

const execFileAsync = promisify(execFile)
const maxSqliteOutputBytes = 128 * 1024 * 1024
const sqliteTimeoutMs = 15_000
const defaultMaxDbFiles = 64
const generatorMetadataRowsPageSize = 500
const cascadeIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
type StatFile = (filePath: string) => Promise<{ mtimeMs: number; size?: number }>
type ListFiles = (directoryPath: string) => AsyncIterable<AntigravityDirectoryEntry>

const nodeListFiles: ListFiles = async function * (directoryPath) {
  const directory = await opendir(directoryPath)
  try {
    while (true) {
      const entry = await directory.read()
      if (!entry) break
      yield entry
    }
  } finally {
    await directory.close()
  }
}

export type AntigravityDbUsageResult = {
  cascadeIds: Set<string>
  events: AntigravityUsageEvent[]
  lastReadRowIndexByCascade?: Map<string, number>
}

export async function readAntigravityDbUsageEvents(input: {
  conversationDir: string
  sqliteBin?: string
  lastSeenRowIndexByCascadeHash?: Map<string, number>
  maxDbFiles?: number | null
  statFile?: StatFile
  listFiles?: ListFiles
  scanState?: AntigravityFileScanState
}): Promise<AntigravityDbUsageResult> {
  const dbFiles = await listDbFiles({
    conversationDir: input.conversationDir,
    maxDbFiles: normalizeMaxDbFiles(input.maxDbFiles),
    statFile: input.statFile ?? stat,
    listFiles: input.listFiles ?? nodeListFiles,
    lastSeenRowIndexByCascadeHash: input.lastSeenRowIndexByCascadeHash ?? new Map(),
    scanState: input.scanState
  })
  const result: AntigravityDbUsageResult = {
    cascadeIds: new Set(),
    events: [],
    lastReadRowIndexByCascade: new Map()
  }
  for (const dbFile of dbFiles) {
    const cascadeId = basename(dbFile.filePath, '.db')
    const fallbackCreatedAt = new Date(dbFile.mtimeMs).toISOString()
    const beforeCount = result.events.length
    const lastSeenRowIndex = input.lastSeenRowIndexByCascadeHash?.get(hash(cascadeId))
    let lastReadRowIndex = normalizeLastSeenRowIndex(lastSeenRowIndex)
    for await (const row of readGeneratorMetadataRows(dbFile.filePath, {
      sqliteBin: input.sqliteBin,
      lastSeenRowIndex
    })) {
      const events = parseAntigravityGeneratorMetadataBlobEvents(row.data, {
        cascadeId,
        rowIndex: row.index,
        fallbackCreatedAt
      })
      lastReadRowIndex = row.index
      result.events.push(...events.map((event) => withLegacyCascadeAlias(event, cascadeId)))
    }
    result.lastReadRowIndexByCascade?.set(cascadeId, lastReadRowIndex)
    if (result.events.length > beforeCount) {
      result.cascadeIds.add(cascadeId)
    }
  }
  return result
}

function withLegacyCascadeAlias(event: AntigravityUsageEvent, cascadeId: string): AntigravityUsageEvent {
  const legacyHash = legacyAntigravityCliConversationHash(cascadeId)
  if (legacyHash === event.cascadeHash) return event
  return {
    ...event,
    cascadeHashAliases: [...(event.cascadeHashAliases ?? []), legacyHash]
  }
}

function legacyAntigravityCliConversationHash(value: string) {
  return createHash('sha256')
    .update('tokenboard-antigravity-cli\0')
    .update(value)
    .digest('hex')
}

async function listDbFiles(input: {
  conversationDir: string
  maxDbFiles: number | null
  statFile: StatFile
  listFiles: ListFiles
  lastSeenRowIndexByCascadeHash: Map<string, number>
  scanState?: AntigravityFileScanState
}) {
  let names
  try {
    names = (await listAntigravityDirectoryFileNames(input.listFiles(input.conversationDir)))
      .filter((name) => extname(name) === '.db' && cascadeIdPattern.test(basename(name, '.db')))
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new Error(`Antigravity conversations directory not found: ${input.conversationDir}`)
    }
    throw error
  }
  if (input.maxDbFiles === null) {
    const candidates = (await Promise.all(names
      .map((name) => readDbFileCandidate(join(input.conversationDir, name), input.statFile))))
      .filter((candidate): candidate is { filePath: string; mtimeMs: number; size: number } => candidate !== null)
    return sortDbCandidates(candidates)
  }
  const scanState = input.scanState ?? { nextSequence: 0, files: {} }
  const checkedSequence = beginAntigravityFileScan(scanState)
  const scanLimit = Math.min(512, Math.max(16, input.maxDbFiles * 8))
  const ids = names.map((name) => basename(name, '.db'))
  pruneAntigravityFileScanState(scanState, ids)
  const scanIds = selectAntigravityFileScanIds(ids, scanState, scanLimit)
  for (const id of scanIds) {
    const filePath = join(input.conversationDir, `${id}.db`)
    const candidate = await readDbFileCandidate(filePath, input.statFile)
    if (!candidate) {
      removeAntigravityFileScanEntry(scanState, id)
      continue
    }
    markAntigravityFileScanned(scanState, id, {
      mtimeMs: candidate.mtimeMs,
      size: candidate.size,
      hasDatabaseFile: true
    }, checkedSequence)
  }
  const candidates = ids
    .map((id) => {
      const entry = scanState.files[hash(id)]
      return entry ? { filePath: join(input.conversationDir, `${id}.db`), mtimeMs: entry.mtimeMs, size: entry.size } : null
    })
    .filter((candidate): candidate is { filePath: string; mtimeMs: number; size: number } => candidate !== null)
  const sorted = sortDbCandidates(candidates)
  const unread = sorted.filter((candidate) => !hasDbRowCursor(candidate.filePath, input.lastSeenRowIndexByCascadeHash))
  const processed = sorted.filter((candidate) => hasDbRowCursor(candidate.filePath, input.lastSeenRowIndexByCascadeHash))
  return [...unread, ...processed].slice(0, input.maxDbFiles)
}

function sortDbCandidates(candidates: Array<{ filePath: string; mtimeMs: number; size: number }>) {
  return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || a.filePath.localeCompare(b.filePath))
}

function hasDbRowCursor(filePath: string, lastSeenRowIndexByCascadeHash: Map<string, number>) {
  return lastSeenRowIndexByCascadeHash.has(hash(basename(filePath, '.db')))
}

async function readDbFileCandidate(filePath: string, statFile: StatFile) {
  try {
    const info = await statFile(filePath)
    return { filePath, mtimeMs: info.mtimeMs, size: info.size ?? 0 }
  } catch (error) {
    if (isMissingFileError(error)) return null
    throw error
  }
}

function normalizeMaxDbFiles(value: number | null | undefined) {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) return defaultMaxDbFiles
  return Math.min(Math.max(Math.trunc(value), 1), defaultMaxDbFiles)
}

async function * readGeneratorMetadataRows(
  dbFile: string,
  options: {
    sqliteBin?: string
    lastSeenRowIndex?: number
  } = {}
) {
  const sqliteBin = options.sqliteBin ?? process.env.TOKENBOARD_SQLITE_BIN ?? 'sqlite3'
  let lastSeenRowIndex = normalizeLastSeenRowIndex(options.lastSeenRowIndex)
  while (true) {
    const rows = await readGeneratorMetadataRowPage(dbFile, {
      sqliteBin,
      lastSeenRowIndex
    })
    if (rows.length === 0) return
    for (const row of rows) {
      yield row
    }
    const nextLastSeenRowIndex = rows[rows.length - 1]?.index
    if (nextLastSeenRowIndex === undefined || rows.length < generatorMetadataRowsPageSize) return
    if (nextLastSeenRowIndex <= lastSeenRowIndex) {
      throw new Error(`Antigravity SQLite metadata cursor did not advance for ${dbFile}`)
    }
    lastSeenRowIndex = nextLastSeenRowIndex
  }
}

async function readGeneratorMetadataRowPage(
  dbFile: string,
  options: {
    sqliteBin: string
    lastSeenRowIndex: number
  }
) {
  const sql = `select idx, hex(data) from gen_metadata where idx > ${options.lastSeenRowIndex} order by idx limit ${generatorMetadataRowsPageSize}`
  let stdout
  try {
    stdout = (await execFileAsync(options.sqliteBin, ['-batch', dbFile, sql], {
      maxBuffer: maxSqliteOutputBytes,
      timeout: sqliteTimeoutMs,
      killSignal: 'SIGKILL'
    })).stdout
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new Error(`Antigravity SQLite reader unavailable: ${options.sqliteBin} not found`)
    }
    throw new Error(`Failed to read Antigravity SQLite metadata from ${dbFile}: ${errorMessage(error)}`)
  }
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => parseSqliteRow(line, dbFile))
}

function normalizeLastSeenRowIndex(value: number | undefined) {
  if (value === undefined) return -1
  if (!Number.isSafeInteger(value) || value < -1) return -1
  return value
}

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function parseSqliteRow(line: string, dbFile: string) {
  const delimiter = line.indexOf('|')
  if (delimiter <= 0) {
    throw new Error(`Invalid Antigravity SQLite metadata row in ${dbFile}`)
  }
  const index = Number.parseInt(line.slice(0, delimiter), 10)
  const hex = line.slice(delimiter + 1)
  if (!Number.isSafeInteger(index) || !/^[0-9A-F]*$/.test(hex)) {
    throw new Error(`Invalid Antigravity SQLite metadata row in ${dbFile}`)
  }
  return { index, data: Buffer.from(hex, 'hex') }
}

function isMissingFileError(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
