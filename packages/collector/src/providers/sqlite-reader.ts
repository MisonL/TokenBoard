import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { errorMessage } from '../error-message'

const execFileAsync = promisify(execFile)
const maxSqliteOutputBytes = 64 * 1024 * 1024
const defaultTimeoutMs = 20_000

/** Injectable reader so tests can drive the query layer without a `sqlite3` binary. */
export type RunSqliteQuery = (dbFile: string, sql: string) => Promise<string>

export type SqliteQueryOptions = {
  sqliteBin?: string
  runQuery?: RunSqliteQuery
  timeoutMs?: number
  /** Names the tool in error messages, e.g. `OpenCode`. */
  label: string
}

export function resolveSqliteBin(sqliteBin?: string) {
  return sqliteBin ?? process.env.TOKENBOARD_SQLITE_BIN ?? 'sqlite3'
}

/**
 * Run one read-only query and return each result row as a parsed JSON object.
 *
 * The query must project scalar columns only. Callers narrow rows inside SQL
 * (`json_extract`) rather than reading blobs into the collector, so prompt and
 * path fields in a source database never enter this process.
 *
 * Uses `-readonly` so a query can never mutate the tool's own database, and
 * `-json` so values survive without delimiter-escaping guesswork.
 */
export async function querySqliteJsonRows(
  dbFile: string,
  sql: string,
  options: SqliteQueryOptions
): Promise<Record<string, unknown>[]> {
  const sqliteBin = resolveSqliteBin(options.sqliteBin)
  let stdout: string
  try {
    stdout = options.runQuery
      ? await options.runQuery(dbFile, sql)
      : (await execFileAsync(sqliteBin, ['-readonly', '-json', '-batch', dbFile, sql], {
          maxBuffer: maxSqliteOutputBytes,
          timeout: options.timeoutMs ?? defaultTimeoutMs,
          killSignal: 'SIGKILL'
        })).stdout
  } catch (error) {
    if (isMissingBinaryError(error)) {
      throw new Error(`${options.label} SQLite reader unavailable: ${sqliteBin} not found`)
    }
    throw new Error(
      `Failed to read ${options.label} SQLite data from ${dbFile}: ${errorMessage(error)}`
    )
  }
  return parseSqliteJsonRows(stdout, dbFile, options.label)
}

/** `sqlite3 -json` prints nothing for an empty result and a JSON array otherwise. */
export function parseSqliteJsonRows(stdout: string, dbFile: string, label: string) {
  const trimmed = stdout.trim()
  if (!trimmed) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (error) {
    throw new Error(`Invalid ${label} SQLite JSON output from ${dbFile}: ${errorMessage(error)}`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Unexpected ${label} SQLite JSON output from ${dbFile}`)
  }
  return parsed.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`Unexpected ${label} SQLite JSON row from ${dbFile}`)
    }
    return row as Record<string, unknown>
  })
}

/**
 * Latest mtime across a SQLite database and its WAL sidecar.
 *
 * A database in WAL mode commits into `-wal` first and only updates the main
 * file at checkpoint, so watching the main file alone misses usage written
 * since the last checkpoint.
 */
export async function sqliteDatabaseMtimeMs(
  dbFile: string,
  statFile: (path: string) => Promise<{ mtimeMs: number }>
) {
  const main = await statFile(dbFile)
  let latest = main.mtimeMs
  for (const sidecar of [`${dbFile}-wal`, `${dbFile}-shm`]) {
    try {
      const stats = await statFile(sidecar)
      latest = Math.max(latest, stats.mtimeMs)
    } catch (error) {
      if (!isMissingFileError(error)) throw error
    }
  }
  return latest
}

export function isMissingFileError(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function isMissingBinaryError(error: unknown) {
  if (!(error instanceof Error) || !('code' in error)) return false
  return error.code === 'ENOENT'
}
