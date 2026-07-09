import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { promisify } from 'node:util'
import type { AntigravityUsageEvent } from './antigravity-gui-parser'
import { parseAntigravityGeneratorMetadataBlobEvents } from './antigravity-history-protobuf'

const execFileAsync = promisify(execFile)
const maxSqliteOutputBytes = 128 * 1024 * 1024
const sqliteTimeoutMs = 15_000
const defaultMaxDbFiles = 64
const generatorMetadataRowsPageSize = 500
const cascadeIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
type StatFile = (filePath: string) => Promise<{ mtimeMs: number }>

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
}): Promise<AntigravityDbUsageResult> {
  const dbFiles = await listDbFiles(
    input.conversationDir,
    normalizeMaxDbFiles(input.maxDbFiles),
    input.statFile ?? stat
  )
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
    for await (const row of readGeneratorMetadataRows(dbFile.filePath, {
      sqliteBin: input.sqliteBin,
      lastSeenRowIndex
    })) {
      const events = parseAntigravityGeneratorMetadataBlobEvents(row.data, {
        cascadeId,
        rowIndex: row.index,
        fallbackCreatedAt
      })
      result.lastReadRowIndexByCascade?.set(cascadeId, row.index)
      result.events.push(...events.map((event) => withLegacyCascadeAlias(event, cascadeId)))
    }
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

async function listDbFiles(
  conversationDir: string,
  maxDbFiles: number | null,
  statFile: StatFile
) {
  let entries
  try {
    entries = await readdir(conversationDir, { withFileTypes: true })
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new Error(`Antigravity conversations directory not found: ${conversationDir}`)
    }
    throw error
  }
  const candidates = (await Promise.all(entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => extname(name) === '.db' && cascadeIdPattern.test(basename(name, '.db')))
    .map((name) => readDbFileCandidate(join(conversationDir, name), statFile))))
    .filter((candidate): candidate is { filePath: string; mtimeMs: number } => candidate !== null)
  const sorted = candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || a.filePath.localeCompare(b.filePath))
  const selected = maxDbFiles === null ? sorted : sorted.slice(0, maxDbFiles)
  return selected
}

async function readDbFileCandidate(filePath: string, statFile: StatFile) {
  try {
    return { filePath, mtimeMs: (await statFile(filePath)).mtimeMs }
  } catch {
    return null
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
