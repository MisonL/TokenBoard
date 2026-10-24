import { DatabaseSync } from 'node:sqlite'
import { runSqliteScript } from './sqlite-script'

type SqliteRow = Record<string, unknown>

type SqlitePreparedStatement = {
  sql: string
  bindings: unknown[]
  first: <T>() => Promise<T | null>
  all: <T>() => Promise<{ results: T[] }>
  run: () => Promise<D1Result>
}

export function createSqliteD1(dbPath: string): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            sql,
            bindings: values,
            first: async <T>() => {
              return runPreparedSql(dbPath, wrapFirstQuery(sql), values)[0] as T | null
            },
            all: async <T>() => {
              return { results: runPreparedSql(dbPath, sql, values) as T[] }
            },
            run: async () => {
              const database = new DatabaseSync(dbPath, { enableForeignKeyConstraints: false })
              try {
                return runPreparedStatement(database, sql, values)
              } finally {
                database.close()
              }
            }
          } as SqlitePreparedStatement
        }
      }
    },
    batch: async (statements: SqlitePreparedStatement[]) => {
      return runPreparedSqlBatch(dbPath, statements)
    }
  } as unknown as D1Database
}

export function runSql(dbPath: string, input: string) {
  const result = runSqliteScript(dbPath, input)
  if (result.status !== 0) {
    throw new Error(`sqlite failed: ${result.stderr}\nSQL:\n${input}`)
  }
  return result.stdout
}

function runPreparedSql(dbPath: string, sql: string, bindings: unknown[]) {
  const database = new DatabaseSync(dbPath, { enableForeignKeyConstraints: false, readBigInts: true })
  try {
    return parseRows(database.prepare(sql).all(...(normalizeBindings(bindings) as never[])))
  } finally {
    database.close()
  }
}

function runPreparedSqlBatch(dbPath: string, statements: SqlitePreparedStatement[]) {
  const database = new DatabaseSync(dbPath, { enableForeignKeyConstraints: false, readBigInts: true })
  try {
    database.exec('BEGIN IMMEDIATE;')
    const results = statements.map((statement) => {
      return runPreparedStatement(database, statement.sql, statement.bindings)
    })
    database.exec('COMMIT;')
    return results
  } catch (error) {
    try {
      database.exec('ROLLBACK;')
    } catch {
      // Preserve the original batch error when rollback is already complete.
    }
    throw error
  } finally {
    database.close()
  }
}

function runPreparedStatement(database: DatabaseSync, sql: string, bindings: unknown[]) {
  const normalizedBindings = normalizeBindings(bindings) as never[]
  const statement = database.prepare(sql)
  if (statementReturnsRows(sql)) {
    const rows = parseRows(statement.all(...normalizedBindings))
    return {
      success: true,
      results: rows,
      meta: { changes: hasReturningClause(sql) ? rows.length : 0 }
    } as D1Result
  }

  const result = statement.run(...normalizedBindings)
  return { success: true, meta: { changes: Number(result.changes) } } as D1Result
}

function wrapFirstQuery(sql: string) {
  if (/\bRETURNING\b/i.test(sql)) return sql
  return `SELECT * FROM (${sql.trim().replace(/;\s*$/, '')}) LIMIT 1`
}

function parseRows(rows: SqliteRow[]) {
  return rows.map((row) => {
    const parsed: SqliteRow = {}
    const entries = Object.entries(row)
    if (entries.length === 1 && entries[0]?.[0].startsWith('COUNT(')) {
      parsed.value = normalizeSqliteValue(entries[0][1])
      return parsed
    }
    for (const [key, value] of entries) {
      parsed[key] = normalizeSqliteValue(value)
    }
    return parsed
  })
}

function statementReturnsRows(sql: string) {
  const normalized = sql.trim()
  return /^(?:SELECT|VALUES|PRAGMA|EXPLAIN)\b/i.test(normalized) || hasReturningClause(sql)
}

function hasReturningClause(sql: string) {
  return /\bRETURNING\b/i.test(sql)
}

function normalizeSqliteValue(value: unknown) {
  if (typeof value !== 'bigint') return value
  return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : value
}

function normalizeBindings(values: unknown[]) {
  return values.map((value) => {
    if (value === undefined) {
      throw new Error('Unsupported sqlite test binding type: undefined')
    }
    if (typeof value === 'boolean') return value ? 1 : 0
    if (typeof value === 'number' && !Number.isFinite(value)) return null
    if (
      value === null ||
      typeof value === 'number' ||
      typeof value === 'bigint' ||
      typeof value === 'string' ||
      value instanceof Uint8Array
    ) {
      return value
    }
    throw new Error(`Unsupported sqlite test binding type: ${typeof value}`)
  })
}
