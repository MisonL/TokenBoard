import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UsageSnapshot } from '@tokenboard/usage-core'
import type { CollectorConfig } from './config'
import { collectAntigravityCliUsage } from './providers/antigravity-cli'
import { collectAntigravityIdeUsage, collectAntigravityUsage } from './providers/antigravity-gui'
import { collectClaudeCodeUsage } from './providers/claude-code'
import { collectCodexUsage } from './providers/codex'
import { clearPendingUploadCursors, warmHookCursorHighWater } from './providers/session-cursor'
import { uploadSnapshots } from './upload'

type CliCommand = 'preview' | 'sync' | 'warm-hooks'
type CliSource = 'claude-code' | 'codex' | 'antigravity-cli' | 'antigravity' | 'antigravity-ide' | 'all'
type ConcreteCliSource = Exclude<CliSource, 'all'>

type CliEnv = Partial<Record<string, string>>
type SourceFailure = {
  source: ConcreteCliSource
  message: string
}

type CollectOptionalSourceOptions = {
  failFast?: boolean
  ignoreUnavailable?: boolean
}

type CliDeps = {
  stdout: (line: string) => void
  stderr: (line: string) => void
  collectClaudeCodeUsage: typeof collectClaudeCodeUsage
  collectCodexUsage: typeof collectCodexUsage
  collectAntigravityCliUsage?: typeof collectAntigravityCliUsage
  collectAntigravityUsage?: typeof collectAntigravityUsage
  collectAntigravityIdeUsage?: typeof collectAntigravityIdeUsage
  uploadSnapshots: typeof uploadSnapshots
  clearPendingUploadCursors?: typeof clearPendingUploadCursors
  warmHookCursorHighWater?: typeof warmHookCursorHighWater
}

const defaultDeps: CliDeps = {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
  collectClaudeCodeUsage,
  collectCodexUsage,
  collectAntigravityCliUsage,
  collectAntigravityUsage,
  collectAntigravityIdeUsage,
  uploadSnapshots,
  clearPendingUploadCursors,
  warmHookCursorHighWater
}

export async function runCollectorCli(
  args: string[],
  env: CliEnv = process.env,
  deps: CliDeps = defaultDeps
) {
  try {
    const options = parseArgs(args, env)
    const startedAtMs = Date.now()

    if (options.command === 'warm-hooks') {
      const sources = expandSources(options.source)
      await warmHookCursors(sources, deps, env, startedAtMs, 'all')
      deps.stdout(JSON.stringify({ warmed: sources }, null, 2))
      return 0
    }

    const collectionStartedAtMs = startedAtMs
    const collection = await collectSnapshots(options.source, options.timezone, deps, env)

    if (options.command === 'preview') {
      deps.stdout(JSON.stringify(collection.snapshots, null, 2))
      return 0
    }

    const missing = [
      options.endpoint ? null : 'TOKENBOARD_ENDPOINT',
      options.uploadToken ? null : 'TOKENBOARD_UPLOAD_TOKEN'
    ].filter((value): value is string => Boolean(value))

    if (missing.length > 0) {
      deps.stderr(`Missing required config for sync: ${missing.join(', ')}`)
      return 1
    }

    const result = await deps.uploadSnapshots(
      {
        endpoint: options.endpoint,
        uploadToken: options.uploadToken,
        timezone: options.timezone
      },
      collection.snapshots
    )
    await ackUploadCursors(collection.collectedSources, deps, env)
    await warmHookCursors(collection.collectedSources, deps, env, collectionStartedAtMs, options.since)
    deps.stdout(JSON.stringify(result, null, 2))
    if (options.failOnSourceError && collection.sourceFailures.length > 0) {
      deps.stderr(`One or more sources failed: ${formatSourceFailures(collection.sourceFailures)}`)
      return 1
    }
    return 0
  } catch (error) {
    deps.stderr(error instanceof Error ? error.message : String(error))
    return 1
  }
}

function expandSources(source: CliSource): ConcreteCliSource[] {
  return source === 'all'
    ? ['claude-code', 'codex', 'antigravity-cli']
    : [source]
}

async function warmHookCursors(
  collectedSources: CliSource[],
  deps: CliDeps,
  env: CliEnv = process.env,
  highWaterMs = Date.now(),
  since = ''
) {
  if (env.TOKENBOARD_HOOK_MODE === '1') return
  if (since !== 'all') return
  const stateDir = resolveStateDir(env)
  for (const source of collectedSources.filter((item) => item !== 'all')) {
    if (source.startsWith('antigravity')) continue
    const sessionsDir = source === 'codex'
      ? join(env.CODEX_HOME || join(homedir(), '.codex'), 'sessions')
      : join(env.CLAUDE_CONFIG_DIR || env.CLAUDE_HOME || join(homedir(), '.claude'), 'projects')
    await deps.warmHookCursorHighWater?.({ stateDir, source, sessionsDir, highWaterMs })
  }
}

function parseArgs(args: string[], env: CliEnv) {
  const command = readCommand(args[0])
  const flags = readFlags(args.slice(1))
  const source = readSource(flags.source ?? env.TOKENBOARD_SOURCE ?? 'all')
  const timezone = flags.timezone ?? env.TOKENBOARD_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone

  return {
    command,
    source,
    timezone,
    endpoint: flags.endpoint ?? env.TOKENBOARD_ENDPOINT ?? '',
    uploadToken: flags.token ?? env.TOKENBOARD_UPLOAD_TOKEN ?? '',
    since: env.TOKENBOARD_SINCE ?? env.TOKENBOARD_DEFAULT_SINCE ?? '',
    failOnSourceError: env.TOKENBOARD_FAIL_ON_SOURCE_ERROR === '1'
  }
}

async function collectSnapshots(source: CliSource, timezone: string, deps: CliDeps, env: CliEnv = process.env) {
  if (source === 'all') {
    return collectAllSnapshots(timezone, deps, env)
  }

  const snapshots: UsageSnapshot[] = []
  const collectedSources: CliSource[] = []
  const sourceFailures: SourceFailure[] = []
  if (source === 'claude-code') {
    snapshots.push(...(await deps.collectClaudeCodeUsage({ timezone, stderr: deps.stderr })))
    collectedSources.push(source)
  }

  if (source === 'codex') {
    snapshots.push(...(await deps.collectCodexUsage({ timezone, stderr: deps.stderr })))
    collectedSources.push(source)
  }

  if (source === 'antigravity-cli') {
    snapshots.push(...(await readAntigravityCollector(deps)({ timezone, stateDir: resolveStateDir(env) })))
    collectedSources.push(source)
  }

  if (source === 'antigravity') {
    snapshots.push(...(await readAntigravityGuiCollector(deps)({ timezone, stateDir: resolveStateDir(env) })))
    collectedSources.push(source)
  }

  if (source === 'antigravity-ide') {
    snapshots.push(...(await readAntigravityIdeCollector(deps)({ timezone, stateDir: resolveStateDir(env) })))
    collectedSources.push(source)
  }

  return { snapshots, collectedSources, sourceFailures }
}

async function collectAllSnapshots(timezone: string, deps: CliDeps, env: CliEnv = process.env) {
  const snapshots: UsageSnapshot[] = []
  const collectedSources: CliSource[] = []
  const sourceFailures: SourceFailure[] = []
  const hookMode = env.TOKENBOARD_HOOK_MODE === '1'
  const failFast = hookMode
  await collectOptionalSource('claude-code', () => deps.collectClaudeCodeUsage({ timezone, stderr: deps.stderr }), snapshots, collectedSources, sourceFailures, deps, { failFast })
  await collectOptionalSource('codex', () => deps.collectCodexUsage({ timezone, stderr: deps.stderr }), snapshots, collectedSources, sourceFailures, deps, { failFast })
  if (hookMode) {
    return { snapshots, collectedSources, sourceFailures }
  }
  await collectOptionalSource('antigravity-cli', () => readAntigravityCollector(deps)({ timezone, stateDir: resolveStateDir(env) }), snapshots, collectedSources, sourceFailures, deps, { failFast, ignoreUnavailable: true })
  await collectOptionalSource('antigravity', () => readAntigravityGuiCollector(deps)({ timezone, stateDir: resolveStateDir(env) }), snapshots, collectedSources, sourceFailures, deps, { failFast, ignoreUnavailable: true })
  await collectOptionalSource('antigravity-ide', () => readAntigravityIdeCollector(deps)({ timezone, stateDir: resolveStateDir(env) }), snapshots, collectedSources, sourceFailures, deps, { failFast, ignoreUnavailable: true })
  return { snapshots, collectedSources, sourceFailures }
}

function readAntigravityCollector(deps: CliDeps) {
  return deps.collectAntigravityCliUsage ?? noopAntigravityCollector
}

function readAntigravityGuiCollector(deps: CliDeps) {
  return deps.collectAntigravityUsage ?? noopAntigravityCollector
}

function readAntigravityIdeCollector(deps: CliDeps) {
  return deps.collectAntigravityIdeUsage ?? noopAntigravityCollector
}

async function noopAntigravityCollector(): Promise<UsageSnapshot[]> {
  return []
}

async function collectOptionalSource(
  source: ConcreteCliSource,
  collect: () => Promise<UsageSnapshot[]>,
  snapshots: UsageSnapshot[],
  collectedSources: CliSource[],
  sourceFailures: SourceFailure[],
  deps: CliDeps,
  options: CollectOptionalSourceOptions = {}
) {
  try {
    snapshots.push(...(await collect()))
    collectedSources.push(source)
  } catch (error) {
    const message = errorMessage(error)
    if (options.ignoreUnavailable && isOptionalSourceUnavailable(source, message)) {
      deps.stderr(`Skipping ${source} source: ${message}`)
      return
    }
    if (options.failFast) throw error
    sourceFailures.push({ source, message })
    deps.stderr(`Skipping ${source} source: ${message}`)
  }
}

async function ackUploadCursors(
  collectedSources: CliSource[],
  deps: CliDeps,
  env: CliEnv = process.env
) {
  const stateDir = resolveStateDir(env)

  const sources = collectedSources.filter((source) => source !== 'all')
  for (const source of sources) {
    if (!shouldAckCursor(source, env)) continue
    await deps.clearPendingUploadCursors?.({ stateDir, source })
  }
}

function shouldAckCursor(source: ConcreteCliSource, env: CliEnv) {
  if (source.startsWith('antigravity')) return true
  return env.TOKENBOARD_HOOK_MODE === '1'
}

function resolveStateDir(env: CliEnv = process.env) {
  return env.TOKENBOARD_STATE_DIR || env.TOKENBOARD_CONFIG_DIR || join(homedir(), '.tokenboard')
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function formatSourceFailures(failures: SourceFailure[]) {
  return failures.map((failure) => `${failure.source}: ${failure.message}`).join('; ')
}

function isOptionalSourceUnavailable(source: ConcreteCliSource, message: string) {
  if (!source.startsWith('antigravity')) return false
  return message.includes('statusline log not found') ||
    message.includes('Antigravity SQLite reader unavailable') ||
    message.includes('Antigravity language server exited before it was ready') ||
    message.includes('Timed out starting Antigravity language server') ||
    message.match(/^spawn \S*Antigravity[^ ]*language_server ENOENT/) !== null ||
    message.match(/^spawn \S*tokenboard-antigravity-language-server ENOENT/) !== null ||
    message.includes('Antigravity conversations directory not found') ||
    message.includes('No Antigravity conversations found')
}

function readCommand(value: string | undefined): CliCommand {
  if (value === 'preview' || value === 'sync' || value === 'warm-hooks') {
    return value
  }

  throw new Error('Usage: tokenboard <preview|sync|warm-hooks> [--source claude-code|codex|antigravity-cli|antigravity|antigravity-ide|all]')
}

function readSource(value: string): CliSource {
  if (
    value === 'claude-code' ||
    value === 'codex' ||
    value === 'antigravity-cli' ||
    value === 'antigravity' ||
    value === 'antigravity-ide' ||
    value === 'all'
  ) {
    return value
  }

  throw new Error(`Invalid source: ${value}`)
}

function readFlags(args: string[]) {
  const flags: Record<string, string> = {}

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg.startsWith('--')) {
      continue
    }

    const key = arg.slice(2)
    const value = args[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`)
    }

    flags[key] = value
    index += 1
  }

  return flags
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exitCode = await runCollectorCli(process.argv.slice(2))
  process.exitCode = exitCode
}
