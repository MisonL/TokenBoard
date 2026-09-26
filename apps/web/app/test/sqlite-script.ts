import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

export type SqliteScriptResult = {
  stdout: string
  stderr: string
  status: number
}

type SqliteBinding = null | number | bigint | string | Uint8Array
type SqliteRow = Record<string, unknown>

type RunnerState = {
  mode: 'list' | 'json' | 'tabs' | 'csv'
  parameters: Map<number, SqliteBinding>
  explainQueryPlan: boolean
}

export function runSqliteScript(
  dbPath: string,
  input: string,
  options: { foreignKeys?: boolean; deferForeignKeys?: boolean } = {}
): SqliteScriptResult {
  const database = new DatabaseSync(dbPath, {
    enableForeignKeyConstraints: options.foreignKeys === true
  })
  const state: RunnerState = {
    mode: 'list',
    parameters: new Map(),
    explainQueryPlan: false
  }
  const output: string[] = []

  try {
    if (options.deferForeignKeys) database.exec('PRAGMA defer_foreign_keys = ON;')
    executeInput(database, input, state, output)
    return { stdout: output.join(''), stderr: '', status: 0 }
  } catch (error) {
    return {
      stdout: output.join(''),
      stderr: error instanceof Error ? error.message : String(error),
      status: 1
    }
  } finally {
    database.close()
  }
}

function executeInput(database: DatabaseSync, input: string, state: RunnerState, output: string[]) {
  let sqlBuffer = ''

  const flush = () => {
    const sql = sqlBuffer
    sqlBuffer = ''
    if (!sql.trim()) return
    for (const statement of splitSqlStatements(sql)) {
      executeStatement(database, statement, state, output)
    }
  }

  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('.read ')) {
      flush()
      const path = parseShellPath(trimmed.slice('.read '.length))
      executeInput(database, readFileSync(path, 'utf8'), state, output)
      continue
    }
    if (trimmed === '.mode json') {
      flush()
      state.mode = 'json'
      continue
    }
    if (trimmed === '.mode list' || trimmed === '.mode tabs' || trimmed === '.mode csv') {
      flush()
      state.mode = trimmed.slice('.mode '.length) as 'list' | 'tabs' | 'csv'
      continue
    }
    if (trimmed === '.eqp on') {
      flush()
      state.explainQueryPlan = true
      continue
    }
    if (trimmed === '.eqp off') {
      flush()
      state.explainQueryPlan = false
      continue
    }
    if (trimmed === '.bail on' || trimmed === '.bail off') continue
    if (trimmed === '.parameter init') {
      flush()
      state.parameters.clear()
      continue
    }
    const parameterCommand = /^\.parameter\s+set\s+\?(\d+)\s+(.+)$/i.exec(trimmed)
    if (parameterCommand) {
      flush()
      state.parameters.set(Number(parameterCommand[1]), parseShellValue(parameterCommand[2]))
      continue
    }
    sqlBuffer += `${line}\n`
  }

  flush()
}

function executeStatement(database: DatabaseSync, rawStatement: string, state: RunnerState, output: string[]) {
  const statement = stripSqlComments(rawStatement).trim()
  if (!statement) return

  const parameterInsert =
    /^INSERT\s+INTO\s+temp\.sqlite_parameters\s*\(\s*key\s*,\s*value\s*\)\s*VALUES\s*\(\s*'\?(\d+)'\s*,\s*(.+)\s*\)$/is.exec(
      statement
    )
  if (parameterInsert) {
    state.parameters.set(Number(parameterInsert[1]), parseSqlLiteral(parameterInsert[2]))
    return
  }
  if (/^DELETE\s+FROM\s+temp\.sqlite_parameters$/i.test(statement)) {
    state.parameters.clear()
    return
  }

  const bindings = bindingsForStatement(statement, state.parameters)
  const rows =
    state.explainQueryPlan && isExplainableQuery(statement)
      ? database.prepare(`EXPLAIN QUERY PLAN ${statement}`).all(...bindings)
      : database.prepare(statement).all(...bindings)

  if (rows.length === 0 && state.mode === 'json' && isQueryStatement(statement)) {
    output.push('[]\n')
    return
  }
  if (rows.length === 0) return

  if (state.mode === 'json') {
    output.push(`${JSON.stringify(rows)}\n`)
    return
  }
  const separator = state.mode === 'tabs' ? '\t' : '|'
  for (const row of rows as SqliteRow[]) {
    const values = Object.values(row).map(formatSqliteValue)
    output.push(`${state.mode === 'csv' ? values.map(formatCsvValue).join(',') : values.join(separator)}\n`)
  }
}

function stripSqlComments(input: string) {
  let output = ''
  let quote: "'" | '"' | '`' | ']' | null = null
  let lineComment = false
  let blockComment = false

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    const next = input[index + 1]

    if (lineComment) {
      if (char === '\n') {
        output += char
        lineComment = false
      }
      continue
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        output += ' '
        index += 1
        blockComment = false
      } else if (char === '\n') {
        output += '\n'
      }
      continue
    }
    if (quote) {
      output += char
      if (quote === ']' && char === ']') quote = null
      else if (quote !== ']' && char === quote) {
        if (next === quote) {
          output += next
          index += 1
        } else {
          quote = null
        }
      }
      continue
    }
    if (char === '-' && next === '-') {
      output += ' '
      index += 1
      lineComment = true
      continue
    }
    if (char === '/' && next === '*') {
      output += ' '
      index += 1
      blockComment = true
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      output += char
      continue
    }
    if (char === '[') {
      quote = ']'
      output += char
      continue
    }
    output += char
  }

  return output
}

function bindingsForStatement(statement: string, parameters: Map<number, SqliteBinding>) {
  let maxParameter = 0
  let parameterCount = 0
  let quote: "'" | '"' | '`' | ']' | null = null
  let lineComment = false
  let blockComment = false

  for (let index = 0; index < statement.length; index += 1) {
    const char = statement[index]
    const next = statement[index + 1]

    if (lineComment) {
      if (char === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        index += 1
        blockComment = false
      }
      continue
    }
    if (quote) {
      if (quote === ']' && char === ']') quote = null
      else if (quote !== ']' && char === quote) {
        if (next === quote) index += 1
        else quote = null
      }
      continue
    }
    if (char === '-' && next === '-') {
      index += 1
      lineComment = true
      continue
    }
    if (char === '/' && next === '*') {
      index += 1
      blockComment = true
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      continue
    }
    if (char === '[') {
      quote = ']'
      continue
    }
    if (char !== '?') continue

    const numbered = /^\?(\d+)/.exec(statement.slice(index))
    if (numbered) {
      const slot = Number(numbered[1])
      if (Number.isSafeInteger(slot) && slot > maxParameter) maxParameter = slot
      index += numbered[1].length
      parameterCount += 1
      continue
    }
    maxParameter += 1
    parameterCount += 1
  }

  if (parameterCount === 0) return []
  return Array.from({ length: maxParameter }, (_, index) => parameters.get(index + 1) ?? null)
}

function isQueryStatement(statement: string) {
  return /^(?:SELECT|PRAGMA|EXPLAIN|VALUES|WITH)\b/i.test(statement)
}

function isExplainableQuery(statement: string) {
  return isQueryStatement(statement) && !/^EXPLAIN\b/i.test(statement)
}

function splitSqlStatements(input: string) {
  const statements: string[] = []
  let current = ''
  let quote: "'" | '"' | '`' | ']' | null = null
  let lineComment = false
  let blockComment = false

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    const next = input[index + 1]

    if (lineComment) {
      current += char
      if (char === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      current += char
      if (char === '*' && next === '/') {
        current += next
        index += 1
        blockComment = false
      }
      continue
    }
    if (!quote && char === '-' && next === '-') {
      current += '--'
      index += 1
      lineComment = true
      continue
    }
    if (!quote && char === '/' && next === '*') {
      current += '/*'
      index += 1
      blockComment = true
      continue
    }
    if (quote) {
      current += char
      if (quote === ']' && char === ']') quote = null
      else if (quote !== ']' && char === quote) {
        if (input[index + 1] === quote) {
          current += input[index + 1]
          index += 1
        } else {
          quote = null
        }
      }
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      current += char
      continue
    }
    if (char === '[') {
      quote = ']'
      current += char
      continue
    }
    if (char === ';' && !isInsideCreateTrigger(current)) {
      if (current.trim()) statements.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current.trim()) statements.push(current)
  return statements
}

function isInsideCreateTrigger(statement: string) {
  if (!/^\s*CREATE\s+TRIGGER\b/i.test(statement)) return false
  let blockDepth = 0
  let caseDepth = 0
  for (const keyword of sqlKeywords(statement)) {
    if (keyword === 'BEGIN') blockDepth += 1
    if (keyword === 'CASE') caseDepth += 1
    if (keyword === 'END') {
      if (caseDepth > 0) caseDepth -= 1
      else blockDepth = Math.max(blockDepth - 1, 0)
    }
  }
  return blockDepth > 0
}

function sqlKeywords(input: string) {
  const keywords: string[] = []
  let quote: "'" | '"' | '`' | ']' | null = null
  let lineComment = false
  let blockComment = false

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    const next = input[index + 1]

    if (lineComment) {
      if (char === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        index += 1
        blockComment = false
      }
      continue
    }
    if (quote) {
      if (quote === ']' && char === ']') quote = null
      else if (quote !== ']' && char === quote) {
        if (next === quote) index += 1
        else quote = null
      }
      continue
    }
    if (char === '-' && next === '-') {
      index += 1
      lineComment = true
      continue
    }
    if (char === '/' && next === '*') {
      index += 1
      blockComment = true
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      continue
    }
    if (char === '[') {
      quote = ']'
      continue
    }
    if (!/[A-Za-z_]/.test(char)) continue
    let end = index + 1
    while (/[A-Za-z0-9_]/.test(input[end] ?? '')) end += 1
    keywords.push(input.slice(index, end).toUpperCase())
    index = end - 1
  }
  return keywords
}

function parseShellPath(value: string) {
  const trimmed = value.trim()
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replaceAll("''", "'")
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1).replaceAll('\\"', '"')
  return trimmed
}

function parseShellValue(value: string): SqliteBinding {
  const trimmed = value.trim()
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replaceAll("''", "'")
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1).replaceAll('\\"', '"')
  return parseSqlLiteral(trimmed)
}

function parseSqlLiteral(value: string): SqliteBinding {
  const trimmed = value.trim().replace(/;$/, '').trim()
  if (trimmed.toLowerCase() === 'null') return null
  if (/^-?(?:\d+|\d*\.\d+)$/.test(trimmed)) return Number(trimmed)
  const text = /^CAST\(X'([0-9a-f]*)'\s+AS\s+TEXT\)$/i.exec(trimmed)
  if (text) return Buffer.from(text[1], 'hex').toString('utf8')
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replaceAll("''", "'")
  return trimmed
}

function formatSqliteValue(value: unknown) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex')
  return String(value)
}

function formatCsvValue(value: string) {
  if (!/[",\r\n]/.test(value)) return value
  return `"${value.replaceAll('"', '""')}"`
}
