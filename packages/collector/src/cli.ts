import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UsageSnapshot } from '@tokenboard/usage-core'
import { errorMessage } from './error-message'
import { collectAntigravityCliUsage } from './providers/antigravity-cli'
import {
  collectAntigravityIdeUsage,
  collectAntigravityUsage,
  isAntigravityPartialUsageError
} from './providers/antigravity-gui'
import { isUnavailableLanguageServerError } from './providers/antigravity-gui-environment'
import { collectClaudeCodeUsage } from './providers/claude-code'
import { collectCodexUsage } from './providers/codex'
import { collectDeepSeekHarnessUsage } from './providers/deepseek-harness'
import { collectGrokBuildUsage } from './providers/grok-build'
import { collectOpenCodeUsage } from './providers/opencode'
import { collectPiUsage } from './providers/pi'
import { clearPendingUploadCursors, warmHookCursorHighWater } from './providers/session-cursor'
import { withCursorLock } from './providers/session-cursor-store'
import { uploadSnapshots } from './upload'

type CliCommand = 'preview' | 'sync' | 'warm-hooks'
type CliSource =
  | 'claude-code'
  | 'codex'
  | 'antigravity-cli'
  | 'antigravity'
  | 'antigravity-ide'
  | 'opencode'
  | 'pi'
  | 'grok-build'
  | 'deepseek-harness'
  | 'all'
type ConcreteCliSource = Exclude<CliSource, 'all'>

type CliEnv = Partial<Record<string, string>>
type SourceFailure = {
  fatal: boolean
  source: ConcreteCliSource
  message: string
}

type CollectOptionalSourceOptions = {
  deferFailure?: boolean
  failFast?: boolean
  failOnNonUnavailable?: boolean
  ignoreUnavailable?: boolean
}

type CollectionContext = {
  timezone: string
  since: string
  cursorScope?: string
  deps: CliDeps
  env: CliEnv
}

type CliDeps = {
  stdout: (line: string) => void
  stderr: (line: string) => void
  collectClaudeCodeUsage: typeof collectClaudeCodeUsage
  collectCodexUsage: typeof collectCodexUsage
  collectAntigravityCliUsage?: typeof collectAntigravityCliUsage
  collectAntigravityUsage?: typeof collectAntigravityUsage
  collectAntigravityIdeUsage?: typeof collectAntigravityIdeUsage
  collectOpenCodeUsage?: typeof collectOpenCodeUsage
  collectPiUsage?: typeof collectPiUsage
  collectGrokBuildUsage?: typeof collectGrokBuildUsage
  collectDeepSeekHarnessUsage?: typeof collectDeepSeekHarnessUsage
  uploadSnapshots: typeof uploadSnapshots
  clearPendingUploadCursors?: typeof clearPendingUploadCursors
  warmHookCursorHighWater?: typeof warmHookCursorHighWater
  withCursorLock?: typeof withCursorLock
}

const defaultDeps: CliDeps = {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
  collectClaudeCodeUsage,
  collectCodexUsage,
  collectAntigravityCliUsage,
  collectAntigravityUsage,
  collectAntigravityIdeUsage,
  collectOpenCodeUsage,
  collectPiUsage,
  collectGrokBuildUsage,
  collectDeepSeekHarnessUsage,
  uploadSnapshots,
  clearPendingUploadCursors,
  warmHookCursorHighWater,
  withCursorLock
}

export async function runCollectorCli(
  args: string[],
  env: CliEnv = process.env,
  deps: CliDeps = defaultDeps
): Promise<number> {
  try {
    const options = parseArgs(args, env)
    if (deps.withCursorLock && env.TOKENBOARD_COLLECTOR_LOCK_HELD !== '1') {
      return await deps.withCursorLock(
        join(resolveStateDir(env), 'collector-run'),
        () => runCollectorCli(args, { ...env, TOKENBOARD_COLLECTOR_LOCK_HELD: '1' }, deps)
      )
    }
    const startedAtMs = Date.now()

    if (options.command === 'warm-hooks') {
      const sources = expandSources(options.source)
      await warmHookCursors(sources, deps, env, startedAtMs, 'all')
      deps.stdout(JSON.stringify({ warmed: sources }, null, 2))
      return 0
    }

    if (options.command === 'sync') {
      const missing = [
        options.endpoint ? null : 'TOKENBOARD_ENDPOINT',
        options.uploadToken ? null : 'TOKENBOARD_UPLOAD_TOKEN'
      ].filter((value): value is string => Boolean(value))
      if (missing.length > 0) {
        deps.stderr(`Missing required config for sync: ${missing.join(', ')}`)
        return 1
      }
    }

    const collectionStartedAtMs = startedAtMs
    const cursorScope = options.command === 'sync' ? cursorScopeFromEndpoint(options.endpoint) : undefined
    const collectionContext = { timezone: options.timezone, since: options.since, cursorScope, deps, env }
    const collection = await collectSnapshots(options.source, collectionContext)
    const hasFatalSourceFailure = collection.sourceFailures.some((failure) => failure.fatal)
    const shouldFailForSourceErrors = (options.failOnSourceError || options.source !== 'all') &&
      collection.sourceFailures.length > 0
    const collectionFailed = hasFatalSourceFailure || shouldFailForSourceErrors

    if (options.command === 'preview') {
      deps.stdout(JSON.stringify(collection.snapshots, null, 2))
      if (collectionFailed) {
        deps.stderr(`One or more sources failed: ${formatSourceFailures(collection.sourceFailures)}`)
        return 1
      }
      return 0
    }

    const result = await deps.uploadSnapshots(
      {
        endpoint: options.endpoint,
        uploadToken: options.uploadToken,
        timezone: options.timezone
      },
      collection.snapshots
    )
    await ackUploadCursors({
      collectedSources: collection.collectedSources,
      cursorScope,
      since: options.since,
      timezone: options.timezone,
      deps,
      env
    })
    await warmHookCursors(collection.collectedSources, deps, env, collectionStartedAtMs, options.since)
    deps.stdout(JSON.stringify(result, null, 2))
    if (collectionFailed) {
      deps.stderr(`One or more sources failed: ${formatSourceFailures(collection.sourceFailures)}`)
      return 1
    }
    return 0
  } catch (error) {
    deps.stderr(errorMessage(error))
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
    // Only Claude Code and Codex install notification hooks; every other source
    // has no hook cursor to warm and must not fall through to the Claude path.
    if (source !== 'claude-code' && source !== 'codex') continue
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
    since: flags.since ?? (env.TOKENBOARD_SINCE || env.TOKENBOARD_DEFAULT_SINCE || ''),
    failOnSourceError: env.TOKENBOARD_FAIL_ON_SOURCE_ERROR === '1'
  }
}

async function collectSnapshots(source: CliSource, context: CollectionContext) {
  if (source === 'all') {
    return collectAllSnapshots(context)
  }

  const snapshots: UsageSnapshot[] = []
  const collectedSources: CliSource[] = []
  const sourceFailures: SourceFailure[] = []
  await collectOptionalSource(
    source,
    () => collectSingleSource(source, context),
    snapshots,
    collectedSources,
    sourceFailures,
    context.deps,
    { failFast: true }
  )

  return { snapshots, collectedSources, sourceFailures }
}

async function collectAllSnapshots(context: CollectionContext) {
  const { cursorScope, deps, env, since, timezone } = context
  const snapshots: UsageSnapshot[] = []
  const collectedSources: CliSource[] = []
  const sourceFailures: SourceFailure[] = []
  const hookMode = env.TOKENBOARD_HOOK_MODE === '1'
  const failFast = hookMode
  const standardContext = { timezone, since, stderr: deps.stderr }
  await collectOptionalSource('claude-code', () => deps.collectClaudeCodeUsage(standardContext), snapshots, collectedSources, sourceFailures, deps, { failFast })
  await collectOptionalSource('codex', () => deps.collectCodexUsage(standardContext), snapshots, collectedSources, sourceFailures, deps, { failFast })
  if (hookMode) {
    return { snapshots, collectedSources, sourceFailures }
  }
  const antigravityOptions = { deferFailure: true, failFast, failOnNonUnavailable: true, ignoreUnavailable: true }
  const antigravityContext = { timezone, since, stateDir: resolveStateDir(env), cursorScope }
  await collectOptionalSource('antigravity-cli', () => readAntigravityCollector(deps)(antigravityContext), snapshots, collectedSources, sourceFailures, deps, antigravityOptions)
  await collectOptionalSource('antigravity', () => readAntigravityGuiCollector(deps)(antigravityContext), snapshots, collectedSources, sourceFailures, deps, antigravityOptions)
  await collectOptionalSource('antigravity-ide', () => readAntigravityIdeCollector(deps)(antigravityContext), snapshots, collectedSources, sourceFailures, deps, antigravityOptions)
  // Tools most users do not have installed: a missing local store is reported as
  // unavailable and skipped rather than failing the whole run.
  const optionalSourceOptions = { deferFailure: true, failFast, failOnNonUnavailable: true, ignoreUnavailable: true }
  await collectOptionalSource('opencode', () => readOpenCodeCollector(deps)(standardContext), snapshots, collectedSources, sourceFailures, deps, optionalSourceOptions)
  await collectOptionalSource('pi', () => readPiCollector(deps)(standardContext), snapshots, collectedSources, sourceFailures, deps, optionalSourceOptions)
  await collectOptionalSource('grok-build', () => readGrokBuildCollector(deps)(standardContext), snapshots, collectedSources, sourceFailures, deps, optionalSourceOptions)
  await collectOptionalSource('deepseek-harness', () => readDeepSeekHarnessCollector(deps)(standardContext), snapshots, collectedSources, sourceFailures, deps, optionalSourceOptions)
  return { snapshots, collectedSources, sourceFailures }
}

function readOpenCodeCollector(deps: CliDeps) {
  return deps.collectOpenCodeUsage ?? noopCollector
}

function readPiCollector(deps: CliDeps) {
  return deps.collectPiUsage ?? noopCollector
}

function readGrokBuildCollector(deps: CliDeps) {
  return deps.collectGrokBuildUsage ?? noopCollector
}

function readDeepSeekHarnessCollector(deps: CliDeps) {
  return deps.collectDeepSeekHarnessUsage ?? noopCollector
}

async function noopCollector(): Promise<UsageSnapshot[]> {
  return []
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

function collectSingleSource(
  source: ConcreteCliSource,
  context: CollectionContext
) {
  const { cursorScope, deps, env, since, timezone } = context
  const standardContext = { timezone, since, stderr: deps.stderr }
  if (source === 'claude-code') return deps.collectClaudeCodeUsage(standardContext)
  if (source === 'codex') return deps.collectCodexUsage(standardContext)
  if (source === 'opencode') return readOpenCodeCollector(deps)(standardContext)
  if (source === 'pi') return readPiCollector(deps)(standardContext)
  if (source === 'grok-build') return readGrokBuildCollector(deps)(standardContext)
  if (source === 'deepseek-harness') return readDeepSeekHarnessCollector(deps)(standardContext)
  const antigravityContext = { timezone, since, stateDir: resolveStateDir(env), cursorScope }
  if (source === 'antigravity-cli') return readAntigravityCollector(deps)(antigravityContext)
  if (source === 'antigravity') return readAntigravityGuiCollector(deps)(antigravityContext)
  return readAntigravityIdeCollector(deps)(antigravityContext)
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
    if (isAntigravityPartialUsageError(error)) {
      snapshots.push(...error.snapshots)
      collectedSources.push(source)
      sourceFailures.push({ source, message: sourceFailureMessage(source, 'partial', message), fatal: error.fatal })
      deps.stderr(formatAntigravityDiagnostic(source, 'partial', message))
      return
    }
    if (options.ignoreUnavailable && isOptionalSourceUnavailable(source, message)) {
      deps.stderr(source.startsWith('antigravity')
        ? formatAntigravityDiagnostic(source, 'unavailable', message)
        : `Skipping unavailable ${source} source: ${message}`)
      return
    }
    if (options.failFast || (options.failOnNonUnavailable && !options.deferFailure)) {
      throw safeSourceError(source, error, message)
    }
    const fatal = Boolean(options.failOnNonUnavailable)
    sourceFailures.push({
      source,
      message: source.startsWith('antigravity') ? sourceFailureMessage(source, 'failed', message) : message,
      fatal
    })
    if (source.startsWith('antigravity')) {
      deps.stderr(formatAntigravityDiagnostic(source, 'failed', message))
      return
    }
    deps.stderr(`Skipping ${source} source: ${message}`)
  }
}

async function ackUploadCursors(input: {
  collectedSources: CliSource[]
  cursorScope?: string
  since: string
  timezone: string
  deps: CliDeps
  env: CliEnv
}) {
  const stateDir = resolveStateDir(input.env)

  const sources = input.collectedSources.filter((source) => source !== 'all')
  for (const source of sources) {
    if (!shouldAckCursor(source, input.env)) continue
    try {
      await input.deps.clearPendingUploadCursors?.({
        stateDir,
        source,
        cursorScope: source.startsWith('antigravity') ? input.cursorScope : undefined,
        since: source.startsWith('antigravity') ? input.since : undefined,
        timezone: source.startsWith('antigravity') ? input.timezone : undefined
      })
    } catch (error) {
      throw safeSourceError(source, error, errorMessage(error))
    }
  }
}

function shouldAckCursor(source: ConcreteCliSource, env: CliEnv) {
  if (source.startsWith('antigravity')) return true
  return env.TOKENBOARD_HOOK_MODE === '1'
}

function resolveStateDir(env: CliEnv = process.env) {
  return env.TOKENBOARD_STATE_DIR || env.TOKENBOARD_CONFIG_DIR || join(homedir(), '.tokenboard')
}

function cursorScopeFromEndpoint(endpoint: string) {
  return endpoint ? new URL(endpoint).origin : undefined
}

function formatAntigravityDiagnostic(
  source: ConcreteCliSource,
  status: 'unavailable' | 'partial' | 'failed',
  message: string
) {
  return `Antigravity collection: source=${source} status=${status} category=${antigravityErrorCategory(message)}`
}

function sourceFailureMessage(
  source: ConcreteCliSource,
  status: 'partial' | 'failed',
  message: string
) {
  if (!source.startsWith('antigravity')) return message
  return `status=${status} category=${antigravityErrorCategory(message)}`
}

function safeSourceError(source: ConcreteCliSource, error: unknown, message: string) {
  if (!source.startsWith('antigravity')) return error
  return new Error(formatAntigravityDiagnostic(source, 'failed', message), { cause: error })
}

function antigravityErrorCategory(message: string) {
  if (message.toLowerCase().includes('cursor')) return 'cursor-state-failed'
  if (message.includes('statusline log not found')) return 'statusline-unavailable'
  if (message.includes('Antigravity SQLite reader unavailable')) return 'sqlite-reader-unavailable'
  if (message.includes('Antigravity conversations directory not found') ||
      message.includes('No Antigravity conversations found')) return 'history-unavailable'
  if (message.includes('Antigravity language server unavailable after DB history was collected') ||
      isUnavailableLanguageServerError(new Error(message))) {
    return 'language-server-unavailable'
  }
  if (message.includes('Invalid Antigravity')) return 'invalid-metadata'
  if (message.includes('Failed to read Antigravity SQLite metadata')) return 'sqlite-read-failed'
  if (message.includes('Failed to read Antigravity metadata')) return 'metadata-read-failed'
  return 'collection-failed'
}

function formatSourceFailures(failures: SourceFailure[]) {
  return failures.map((failure) => `${failure.source}: ${failure.message}`).join('; ')
}

function isOptionalSourceUnavailable(source: ConcreteCliSource, message: string) {
  if (source === 'opencode') {
    return message.includes('OpenCode database not found') ||
      message.includes('OpenCode SQLite reader unavailable')
  }
  if (source === 'pi') return message.includes('No Pi sessions found')
  if (source === 'grok-build') return message.includes('No Grok Build sessions found')
  if (source === 'deepseek-harness') return message.includes('No DeepSeek Harness sessions found')
  if (!source.startsWith('antigravity')) return false
  return message.includes('statusline log not found') ||
    message.includes('Antigravity SQLite reader unavailable') ||
    message.includes('Antigravity language server exited before it was ready') ||
    message.includes('Timed out starting Antigravity language server') ||
    message.match(/^spawn .*(Antigravity.*language_server|tokenboard-antigravity-language-server) ENOENT/) !== null ||
    message.includes('Antigravity conversations directory not found') ||
    message.includes('No Antigravity conversations found')
}

function readCommand(value: string | undefined): CliCommand {
  if (value === 'preview' || value === 'sync' || value === 'warm-hooks') {
    return value
  }

  throw new Error('Usage: tokenboard <preview|sync|warm-hooks> [--source claude-code|codex|antigravity-cli|antigravity|antigravity-ide|opencode|pi|grok-build|deepseek-harness|all]')
}

function readSource(value: string): CliSource {
  if (
    value === 'claude-code' ||
    value === 'codex' ||
    value === 'antigravity-cli' ||
    value === 'antigravity' ||
    value === 'antigravity-ide' ||
    value === 'opencode' ||
    value === 'pi' ||
    value === 'grok-build' ||
    value === 'deepseek-harness' ||
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
