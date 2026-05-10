import { cp, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { glob } from 'node:fs/promises'

const CODEX_SESSIONS_DIR = 'sessions'
const JSONL_GLOB = '**/*.jsonl'

type CodexSessionScopeOptions = {
  codexHome?: string
  since?: string
  until?: string
  now?: Date
  batchSize?: number
}

export type CodexSessionScope = {
  codexHome: string
  cleanup: () => Promise<void>
}

export async function createCodexSessionScope(
  options: CodexSessionScopeOptions = {}
): Promise<CodexSessionScope | null> {
  const scopes: CodexSessionScope[] = []
  try {
    for await (const scope of createCodexSessionScopeBatches({
      ...options,
      batchSize: Number.MAX_SAFE_INTEGER
    })) {
      scopes.push(scope)
    }
    return scopes[0] ?? null
  } catch (error) {
    await Promise.all(scopes.map((scope) => scope.cleanup()))
    throw error
  }
}

export async function* createCodexSessionScopeBatches(
  options: CodexSessionScopeOptions = {}
): AsyncGenerator<CodexSessionScope> {
  const since = parseFilterDate(options.since, 'start')
  const until = parseFilterDate(options.until, 'end')
  const includeAll = options.since === 'all' && !until
  if (!includeAll && !since && !until) {
    return
  }

  const sourceCodexHome = resolve(options.codexHome || process.env.CODEX_HOME || join(process.env.HOME || '', '.codex'))
  const sourceSessionsDir = join(sourceCodexHome, CODEX_SESSIONS_DIR)
  const directory = await stat(sourceSessionsDir).catch(() => null)
  if (!directory?.isDirectory()) {
    return
  }

  const batchSize = normalizeBatchSize(options.batchSize)
  const batch: string[] = []
  const filter = { since, until, now: options.now || new Date() }
  const files = await glob(JSONL_GLOB, { cwd: sourceSessionsDir })
  for await (const file of files) {
    const absoluteFile = isAbsolute(file) ? file : join(sourceSessionsDir, file)
    if (!includeAll && !(await isActiveSessionFile(absoluteFile, filter))) {
      continue
    }

    batch.push(absoluteFile)
    if (batch.length >= batchSize) {
      yield await createScope(sourceSessionsDir, batch.splice(0, batch.length))
    }
  }

  if (batch.length > 0) {
    yield await createScope(sourceSessionsDir, batch)
  }
}

async function createScope(sourceSessionsDir: string, files: string[]) {
  const scopedHome = await mkdtemp(join(tmpdir(), 'tokenboard-codex-home-'))
  const scopedSessionsDir = join(scopedHome, CODEX_SESSIONS_DIR)
  await mkdir(scopedSessionsDir, { recursive: true })

  for (const file of files) {
    const relativePath = relative(sourceSessionsDir, file)
    const target = join(scopedSessionsDir, relativePath)
    await mkdir(dirname(target), { recursive: true })
    await cp(file, target)
  }

  return {
    codexHome: scopedHome,
    cleanup: () => rm(scopedHome, { recursive: true, force: true })
  }
}

function normalizeBatchSize(value: number | undefined) {
  if (!value || !Number.isFinite(value) || value < 1) {
    return 200
  }
  return Math.min(Math.floor(value), 1000)
}

async function isActiveSessionFile(
  file: string,
  options: { since?: Date; until?: Date; now: Date }
) {
  const content = await readFile(file, 'utf8').catch(() => '')
  const tokenCountActivity = readTokenCountActivity(content, options)
  if (tokenCountActivity.hasInRangeTimestamp) {
    return true
  }
  if (tokenCountActivity.hasAnyTimestamp) {
    return false
  }

  const fileStat = await stat(file).catch(() => null)
  return fileStat ? isDateInRange(fileStat.mtime, options) : false
}

function readTokenCountActivity(content: string, options: { since?: Date; until?: Date }) {
  const activity = {
    hasAnyTimestamp: false,
    hasInRangeTimestamp: false
  }

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const entry = parseJsonRecord(trimmed)
    if (!entry || entry.type !== 'event_msg') continue
    const payload = readRecord(entry.payload)
    if (payload?.type !== 'token_count') continue

    const timestamp = typeof entry.timestamp === 'string' ? new Date(entry.timestamp) : null
    if (!timestamp || Number.isNaN(timestamp.getTime())) {
      continue
    }
    activity.hasAnyTimestamp = true
    if (isDateInRange(timestamp, options)) {
      activity.hasInRangeTimestamp = true
      return activity
    }
  }

  return activity
}

function isDateInRange(date: Date, options: { since?: Date; until?: Date }) {
  if (Number.isNaN(date.getTime())) {
    return false
  }
  if (options.since && date < options.since) {
    return false
  }
  if (options.until && date > options.until) {
    return false
  }
  return true
}

function parseFilterDate(value: string | undefined, boundary: 'start' | 'end') {
  if (!value || value === 'all') {
    return undefined
  }

  const compact = value.replaceAll('-', '').trim()
  if (!/^\d{8}$/.test(compact)) {
    throw new Error(`Invalid Codex usage date filter: ${value}. Expected YYYYMMDD or YYYY-MM-DD.`)
  }

  const date = new Date(Date.UTC(
    Number.parseInt(compact.slice(0, 4), 10),
    Number.parseInt(compact.slice(4, 6), 10) - 1,
    Number.parseInt(compact.slice(6, 8), 10)
  ))
  if (boundary === 'end') {
    date.setUTCHours(23, 59, 59, 999)
  }
  return date
}

function parseJsonRecord(value: string) {
  try {
    return readRecord(JSON.parse(value))
  } catch {
    return null
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
