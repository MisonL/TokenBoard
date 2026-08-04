import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { UsageSnapshot } from '@tokenboard/usage-core'
import { runJsonCommand, type CommandRunner } from '../command'
import { errorMessage } from '../error-message'
import { normalizeCcusageDailyJson, readCcusageSessionAttribution } from '../normalize-ccusage'
import { ccusagePackageSpecifier, resolvePackageRunner, type PackageRunner } from '../package-runner'
import {
  codexCommandArgs,
  packageCommandOptions,
  readDailyTimeoutMs,
  readSessionTimeoutMs
} from './codex-command-options'
import {
  createCodexSessionScopeBatchesForFiles,
  createCodexSessionScopeBatches,
  type CodexSessionScope,
  type CodexSessionScopeFileGroup
} from './codex-session-scope'
import {
  fingerprintCodexSessionFile,
  withCodexSessionAttributionCache,
  type CodexSessionAttribution
} from './codex-session-attribution-cache'
import { applyCodexSubagentUsageCorrections } from './codex-subagent-usage'
import type { CodexSubagentUsageCacheFile } from './codex-subagent-usage-cache'
import {
  assertHookReconciliationSnapshots,
  isHookMode
} from './hook-incremental'
import { collectCodexHookProfiles } from './codex-hook-profiles'
import { resolveCodexHomes as resolveConfiguredCodexHomes } from './codex-homes'
import { projectCodexDailyCosts } from './codex-cost-projection'
import { mergeSnapshots } from './session-cursor'
import { assertValidDateFilter } from '../iso-calendar-date'

const DEFAULT_CODEX_BATCH_SIZE = 200
const MAX_CODEX_BATCH_SIZE = 1000
const boundedCodexCollectionAttempts = 2
const hookCodexCollectionAttempts = 2
const canonicalAttributionChangeMessages = new Set([
  'Codex session changed during scoped collection; retry the sync',
  'Canonical Codex session attribution is missing a bounded session row; retry the sync',
  'Codex child session changed while correcting; retry the sync'
])
const childSessionChangeMessages = new Set([
  'Codex child session changed before reading; retry the sync',
  'Codex child session changed while reading; retry the sync',
  'Codex child session changed while correcting; retry the sync',
  'Codex child session changed while fingerprinting; retry the sync'
])

export type CollectCodexUsageOptions = {
  timezone?: string
  collectedAt?: string
  since?: string
  codexHome?: string
  codexHomes?: string[]
  stateDir?: string
  runner?: CommandRunner
  stderr?: (line: string) => void
}

export async function collectCodexUsage(
  options: CollectCodexUsageOptions = {}
): Promise<UsageSnapshot[]> {
  const runner = options.runner ?? runJsonCommand
  const packageRunner = resolvePackageRunner()
  const collectedAt = options.collectedAt ?? new Date().toISOString()
  if (isHookMode()) {
    return collectCodexHookUsage({
      runner,
      packageRunner,
      options,
      collectedAt
    })
  }

  const since = options.since ?? readSince()
  const until = process.env.TOKENBOARD_UNTIL
  const rangeArgs = buildRangeArgs({ since, until })
  const codexHomes = resolveCodexHomesFromOptions(options)
  const requiresCommaSafeScope = !since && !until && codexHomes.some((home) => home.includes(','))
  const usesScopedScan = (since === 'all' && !until) || requiresCommaSafeScope
  if (usesScopedScan) {
    return collectScopedCodexUsage({
      runner,
      packageRunner,
      rangeArgs,
      since: requiresCommaSafeScope ? 'all' : since,
      until,
      options,
      collectedAt,
      codexHomes
    })
  }

  const env = { ...process.env, CODEX_HOME: codexHomes.join(',') }
  if (rangeArgs.length > 0) {
    return collectBoundedCodexUsage({
      runner,
      packageRunner,
      rangeArgs,
      since,
      until,
      options,
      collectedAt,
      codexHomes
    })
  }
  return collectCodexCcusageRange({
    runner,
    packageRunner,
    rangeArgs,
    since,
    until,
    options,
    collectedAt,
    env,
    codexHomes
  })
}

async function collectScopedCodexUsage(input: {
  runner: CommandRunner
  packageRunner: PackageRunner
  rangeArgs: string[]
  since?: string
  until?: string
  options: CollectCodexUsageOptions
  collectedAt: string
  codexHomes: string[]
  requireScope?: boolean
}) {
  const snapshots: UsageSnapshot[] = []
  let collectedScopes = 0
  for await (const scope of createCodexSessionScopeBatches({
    codexHomes: input.codexHomes,
    since: input.since,
    until: input.until,
    batchSize: readBatchSize(),
    onMissingSessionFile: (sessionPath) =>
      input.options.stderr?.(`Skipping Codex session file that disappeared before copy: ${sessionPath}`),
    onCopyFallback: input.options.stderr
  })) {
    collectedScopes += 1
    try {
      const batch = await collectScopedBatch({
        runner: input.runner,
        packageRunner: input.packageRunner,
        rangeArgs: input.rangeArgs,
        scope,
        options: input.options,
        collectedAt: input.collectedAt
      })
      snapshots.push(...batch.snapshots)
      await warmCanonicalAttributionsFromScope({
        stateDir: input.options.stateDir,
        timezone: input.options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        scope,
        sessions: batch.sessions,
        stderr: input.options.stderr
      })
    } finally {
      await scope.cleanup()
    }
  }

  if (input.requireScope && collectedScopes === 0) {
    throw new Error('Codex bounded collection cannot obtain a frozen local session scope; retry the sync')
  }

  return projectCodexDailyCosts(mergeSnapshots(snapshots))
}

async function collectCodexHookUsage(input: {
  runner: CommandRunner
  packageRunner: PackageRunner
  options: CollectCodexUsageOptions
  collectedAt: string
}) {
  for (let attempt = 0; attempt < hookCodexCollectionAttempts; attempt += 1) {
    try {
      return await collectCodexHookUsageAttempt(input)
    } catch (error) {
      if (attempt + 1 < hookCodexCollectionAttempts && isChildSessionChange(error)) {
        input.options.stderr?.('Codex child session changed; retrying hook reconciliation once')
        continue
      }
      throw error
    }
  }

  throw new Error('Codex hook reconciliation retry loop ended unexpectedly')
}

async function collectCodexHookUsageAttempt(input: {
  runner: CommandRunner
  packageRunner: PackageRunner
  options: CollectCodexUsageOptions
  collectedAt: string
}) {
  const codexHomes = resolveCodexHomesFromOptions(input.options)
  const timezone = input.options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const incremental = await collectCodexHookProfiles({
    codexHomes,
    stateDir: input.options.stateDir,
    stderr: input.options.stderr,
    timezone,
    collectedAt: input.collectedAt
  })

  if (!incremental.changed) {
    return []
  }

  const rangeArgs = withTimezoneArgs(incremental.rangeArgs, timezone)
  const snapshots = incremental.rangeArgs.length === 0
    ? []
    : await collectScopedCodexUsage({
        runner: input.runner,
        packageRunner: input.packageRunner,
        rangeArgs,
        ...hookDateBounds(incremental.changedDates),
        options: input.options,
        collectedAt: input.collectedAt,
        codexHomes,
        requireScope: true
      })
  if (incremental.rangeArgs.length > 0) {
    assertHookReconciliationSnapshots({
      sourceLabel: 'Codex',
      expectedDates: incremental.changedDates,
      expectedKeys: incremental.changedKeys,
      snapshots
    })
  }
  return mergeSnapshots([...snapshots, ...incremental.cachedSnapshots])
}

async function collectCodexCcusageRange(input: {
  runner: CommandRunner
  packageRunner: PackageRunner
  rangeArgs: string[]
  since?: string
  until?: string
  options: CollectCodexUsageOptions
  collectedAt: string
  env: NodeJS.ProcessEnv
  codexHomes?: string[]
}) {
  const json = await input.runner(
    input.packageRunner.command,
    input.packageRunner.runPackageArgs(ccusagePackageSpecifier, 'ccusage', codexCommandArgs({
      report: 'daily',
      rangeArgs: input.rangeArgs
    })),
    packageCommandOptions({
      env: input.env,
      timeoutMs: readDailyTimeoutMs(),
      stderr: input.options.stderr
    })
  )
  const sessions = await collectSessionCounts({
    runner: input.runner,
    command: input.packageRunner.command,
    args: input.packageRunner.runPackageArgs(ccusagePackageSpecifier, 'ccusage', codexCommandArgs({
      report: 'session',
      rangeArgs: input.rangeArgs
    })),
    options: packageCommandOptions({
      env: input.env,
      timeoutMs: readSessionTimeoutMs(),
      stderr: input.options.stderr
    }),
    stderr: input.options.stderr
  })

  return projectCodexDailyCosts(await normalizeAndCorrectCodexSnapshots({
    daily: json,
    sessions,
    correctionSessions: sessions,
    codexHomes: input.codexHomes ?? resolveCodexHomesFromOptions(input.options),
    options: input.options,
    collectedAt: input.collectedAt,
    includeSessionOnlySnapshots: false
  }))
}

async function collectBoundedCodexUsage(input: {
  runner: CommandRunner
  packageRunner: PackageRunner
  rangeArgs: string[]
  since?: string
  until?: string
  options: CollectCodexUsageOptions
  collectedAt: string
  codexHomes: string[]
}) {
  for (let attempt = 0; attempt < boundedCodexCollectionAttempts; attempt += 1) {
    try {
      return await collectBoundedCodexUsageAttempt(input)
    } catch (error) {
      if (attempt + 1 < boundedCodexCollectionAttempts && isCanonicalAttributionChange(error)) {
        input.options.stderr?.('Codex canonical attribution changed; retrying the bounded collection once')
        continue
      }
      throw error
    }
  }

  throw new Error('Codex bounded collection retry loop ended unexpectedly')
}

async function collectBoundedCodexUsageAttempt(input: {
  runner: CommandRunner
  packageRunner: PackageRunner
  rangeArgs: string[]
  since?: string
  until?: string
  options: CollectCodexUsageOptions
  collectedAt: string
  codexHomes: string[]
}) {
  const snapshots: UsageSnapshot[] = []
  const timezone = input.options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  let collectedScopes = 0
  let missingSessionFiles = 0
  for await (const scope of createCodexSessionScopeBatches({
    codexHomes: input.codexHomes,
    since: input.since,
    until: input.until,
    batchSize: readBatchSize(),
    onMissingSessionFile: (sessionPath) => {
      missingSessionFiles += 1
      input.options.stderr?.(`Skipping Codex session file that disappeared before bounded copy: ${sessionPath}`)
    },
    onCopyFallback: input.options.stderr
  })) {
    collectedScopes += 1
    try {
      const cachedAttributions = await readCachedCanonicalAttributions({
        stateDir: input.options.stateDir,
        timezone,
        scope
      })
      reportCodexDiagnostics(
        input.options.stderr,
        `Codex canonical attribution cache: hits=${cachedAttributions.attributions.size} misses=${cachedAttributions.missingSourceFiles.length}`
      )
      const batch = await collectFrozenBoundedCodexBatch({
        ...input,
        scope,
        timezone,
        cachedAttributions
      })
      snapshots.push(...batch.snapshots)
      await warmCanonicalAttributionsFromScope({
        stateDir: input.options.stateDir,
        timezone,
        scope,
        attributions: batch.canonicalAttributions,
        stderr: input.options.stderr
      })
    } finally {
      await scope.cleanup()
    }
  }
  if (collectedScopes === 0 && missingSessionFiles > 0) {
    throw new Error('Codex bounded collection cannot obtain a frozen local session scope; retry the sync')
  }
  return projectCodexDailyCosts(mergeSnapshots(snapshots))
}

async function collectFrozenBoundedCodexBatch(input: {
  runner: CommandRunner
  packageRunner: PackageRunner
  rangeArgs: string[]
  since?: string
  until?: string
  options: CollectCodexUsageOptions
  collectedAt: string
  scope: CodexSessionScope
  codexHomes: string[]
  timezone: string
  cachedAttributions: {
    attributions: ReadonlyMap<string, CodexSessionAttribution>
    missingSourceFiles: string[]
  }
}) {
  const env = { ...process.env, CODEX_HOME: input.scope.codexHome }
  const daily = await input.runner(
    input.packageRunner.command,
    input.packageRunner.runPackageArgs(ccusagePackageSpecifier, 'ccusage', codexCommandArgs({
      report: 'daily',
      rangeArgs: input.rangeArgs,
      singleThread: true
    })),
    packageCommandOptions({
      env,
      timeoutMs: readDailyTimeoutMs(),
      stderr: input.options.stderr
    })
  )
  const boundedSessions = await collectSessionCounts({
    runner: input.runner,
    command: input.packageRunner.command,
    args: input.packageRunner.runPackageArgs(ccusagePackageSpecifier, 'ccusage', codexCommandArgs({
      report: 'session',
      rangeArgs: input.rangeArgs,
      singleThread: true
    })),
    options: packageCommandOptions({
      env,
      timeoutMs: readSessionTimeoutMs(),
      stderr: input.options.stderr
    }),
    stderr: input.options.stderr,
    required: true
  })
  const canonicalAttributions = await collectCanonicalAttributionsForMissingFiles({
    runner: input.runner,
    packageRunner: input.packageRunner,
    options: input.options,
    codexHomes: input.codexHomes,
    scope: input.scope,
    sourceFiles: input.cachedAttributions.missingSourceFiles
  })
  const sessions = replaceScopedSessionAttributions({
    boundedSessions,
    canonicalAttributions,
    cachedAttributions: input.cachedAttributions.attributions,
    scope: input.scope,
    timezone: input.timezone,
    since: input.since,
    until: input.until
  })
  return {
    snapshots: await normalizeAndCorrectCodexSnapshots({
      daily,
      sessions,
      correctionSessions: boundedSessions,
      codexHomes: input.scope.codexHomes,
      options: input.options,
      collectedAt: input.collectedAt,
      includeSessionOnlySnapshots: true,
      subagentCacheFiles: cacheFilesForScope(input.scope)
    }),
    canonicalAttributions
  }
}

async function readCachedCanonicalAttributions(input: {
  stateDir?: string
  timezone: string
  scope: CodexSessionScope
}) {
  const sourceFiles = [...input.scope.sourceFileFingerprints.keys()]
  if (!input.stateDir || sourceFiles.length === 0) {
    return {
      attributions: new Map<string, CodexSessionAttribution>(),
      missingSourceFiles: sourceFiles
    }
  }
  const attributions = await withCodexSessionAttributionCache({
    stateDir: input.stateDir,
    timezone: input.timezone,
    callback: async (cache) => {
      const attributions = new Map<string, CodexSessionAttribution>()
      for (const [sourceFile, fingerprint] of input.scope.sourceFileFingerprints) {
        const attribution = cache.lookupByFingerprint({ filePath: sourceFile, fingerprint })
        if (attribution) attributions.set(sourceFile, attribution)
      }
      return attributions
    }
  })
  return {
    attributions,
    missingSourceFiles: sourceFiles.filter((sourceFile) => !attributions.has(sourceFile))
  }
}

async function collectCanonicalAttributionsForMissingFiles(input: {
  runner: CommandRunner
  packageRunner: PackageRunner
  options: CollectCodexUsageOptions
  codexHomes: string[]
  scope: CodexSessionScope
  sourceFiles: string[]
}) {
  const attributions = new Map<string, CodexSessionAttribution>()
  if (input.sourceFiles.length === 0) return attributions

  const groups: CodexSessionScopeFileGroup[] = input.sourceFiles.map((sourceFile) => {
    const homeIndex = input.scope.sourceFileHomeIndexes.get(sourceFile)
    const codexHome = homeIndex === undefined ? undefined : input.codexHomes[homeIndex]
    if (!codexHome) {
      throw new Error('Codex canonical attribution lost its source profile mapping')
    }
    return { files: [{ codexHome, filePath: sourceFile }] }
  })

  reportCodexDiagnostics(
    input.options.stderr,
    `Codex canonical attribution scan: files=${input.sourceFiles.length}`
  )
  if (input.sourceFiles.length === input.scope.sourceFileFingerprints.size) {
    return collectCanonicalAttributionsFromScope({
      runner: input.runner,
      packageRunner: input.packageRunner,
      options: input.options,
      scope: input.scope
    })
  }

  for await (const scope of createCodexSessionScopeBatchesForFiles({
    codexHomes: input.codexHomes,
    groups,
    batchSize: readBatchSize(),
    onMissingSessionFile: (sessionPath) =>
      input.options.stderr?.(`Skipping Codex session file that disappeared before canonical attribution: ${sessionPath}`),
    onCopyFallback: input.options.stderr
  })) {
    try {
      const scopedAttributions = await collectCanonicalAttributionsFromScope({
        runner: input.runner,
        packageRunner: input.packageRunner,
        options: input.options,
        scope
      })
      for (const [sourceFile, attribution] of scopedAttributions) attributions.set(sourceFile, attribution)
    } finally {
      await scope.cleanup()
    }
  }
  return attributions
}

async function collectCanonicalAttributionsFromScope(input: {
  runner: CommandRunner
  packageRunner: PackageRunner
  options: CollectCodexUsageOptions
  scope: CodexSessionScope
}) {
  const sessions = await collectSessionCounts({
    runner: input.runner,
    command: input.packageRunner.command,
    args: input.packageRunner.runPackageArgs(ccusagePackageSpecifier, 'ccusage', codexCommandArgs({
      report: 'session',
      singleThread: true
    })),
    options: packageCommandOptions({
      env: { ...process.env, CODEX_HOME: input.scope.codexHome },
      timeoutMs: readSessionTimeoutMs(),
      stderr: input.options.stderr
    }),
    stderr: input.options.stderr,
    required: true
  })
  const attributions = new Map<string, CodexSessionAttribution>()
  for (const row of readSessionRows(sessions)) {
    const sourceFile = resolveScopedSessionSourceFile(row, input.scope)
    const attribution = readCcusageSessionAttribution(
      row,
      input.options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    )
    if (sourceFile && attribution) attributions.set(sourceFile, attribution)
  }
  return attributions
}

function reportCodexDiagnostics(stderr: ((line: string) => void) | undefined, line: string) {
  if (process.env.TOKENBOARD_COLLECTOR_DIAGNOSTICS === '1') stderr?.(line)
}

function isCanonicalAttributionChange(error: unknown) {
  return error instanceof Error && canonicalAttributionChangeMessages.has(error.message)
}

function isChildSessionChange(error: unknown) {
  return error instanceof Error && childSessionChangeMessages.has(error.message)
}

async function normalizeAndCorrectCodexSnapshots(input: {
  daily: unknown
  sessions: unknown
  correctionSessions: unknown
  codexHomes: string[]
  options: CollectCodexUsageOptions
  collectedAt: string
  includeSessionOnlySnapshots: boolean
  subagentCacheFiles?: ReadonlyMap<string, CodexSubagentUsageCacheFile>
}) {
  const snapshots = normalizeCcusageDailyJson(input.daily, {
    source: 'codex',
    timezone: input.options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    collectedAt: input.collectedAt,
    sessions: input.sessions,
    includeSessionOnlySnapshots: input.includeSessionOnlySnapshots
  })
  return applyCodexSubagentUsageCorrections({
    snapshots,
    sessions: input.correctionSessions,
    codexHomes: input.codexHomes,
    timezone: input.options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    stderr: input.options.stderr,
    stateDir: input.options.stateDir,
    cacheFiles: input.subagentCacheFiles
  })
}

function readSessionRows(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return []
  const record = input as Record<string, unknown>
  for (const key of ['sessions', 'data', 'rows', 'items']) {
    const value = record[key]
    if (Array.isArray(value)) {
      return value.filter((row): row is Record<string, unknown> =>
        Boolean(row) && typeof row === 'object' && !Array.isArray(row)
      )
    }
  }
  return []
}

function resolveScopedSessionSourceFile(row: Record<string, unknown>, scope: CodexSessionScope) {
  for (const codexHome of scope.codexHomes) {
    for (const directory of ['sessions', 'archived_sessions']) {
      const file = resolveSessionFileFromRow(row, join(codexHome, directory))
      if (!file) continue
      const sourceFile = scope.sourceFiles.get(file)
      if (sourceFile) return sourceFile
    }
  }
  return null
}

function resolveSessionFileFromRow(row: Record<string, unknown>, root: string) {
  const directory = typeof row.directory === 'string' ? row.directory : ''
  const sessionFile = typeof row.sessionFile === 'string' ? row.sessionFile : ''
  const sessionId = typeof row.sessionId === 'string' ? row.sessionId : ''
  const name = sessionFile || sessionId
  if (!name) return null
  const filename = name.endsWith('.jsonl') ? name : `${name}.jsonl`
  const file = resolve(root, directory, filename)
  return isPathInside(root, file) ? file : null
}

function isPathInside(parent: string, child: string) {
  const relativePath = relative(parent, child)
  return !isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`)
}

function replaceScopedSessionAttributions(input: {
  boundedSessions: unknown
  canonicalAttributions: ReadonlyMap<string, CodexSessionAttribution>
  cachedAttributions: ReadonlyMap<string, CodexSessionAttribution>
  scope: CodexSessionScope
  timezone: string
  since?: string
  until?: string
}) {
  const canonicalBySourceFile = new Map(input.cachedAttributions)
  for (const [sourceFile, attribution] of input.canonicalAttributions) {
    canonicalBySourceFile.set(sourceFile, attribution)
  }
  const canonicalDateRange = {
    since: dateFilterToIso(input.since, true),
    until: dateFilterToIso(input.until)
  }
  return mapSessionRows(input.boundedSessions, (row) => {
    const sourceFile = resolveScopedSessionSourceFile(row, input.scope)
    const attribution = sourceFile ? canonicalBySourceFile.get(sourceFile) : null
    if (!attribution) {
      throw new Error('Canonical Codex session attribution is missing a bounded session row; retry the sync')
    }
    return {
      ...row,
      ...(isDateWithinCodexRange(attribution.usageDate, canonicalDateRange)
        ? { lastActivity: attribution.usageDate }
        : {}),
      models: { [attribution.model]: { totalTokens: 1 } }
    }
  })
}

function isDateWithinCodexRange(
  usageDate: string,
  range: { since: string | null; until: string | null }
) {
  return (!range.since || usageDate >= range.since) && (!range.until || usageDate <= range.until)
}

function dateFilterToIso(value: string | undefined, allowAll = false) {
  if (!value || (allowAll && value === 'all')) return null
  const compact = assertValidDateFilter(value, 'Codex bounded date').replaceAll('-', '')
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`
}

function mapSessionRows(input: unknown, transform: (row: Record<string, unknown>) => Record<string, unknown>) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  const record = input as Record<string, unknown>
  for (const key of ['sessions', 'data', 'rows', 'items']) {
    if (Array.isArray(record[key])) {
      return { ...record, [key]: record[key].map((row) =>
        row && typeof row === 'object' && !Array.isArray(row) ? transform(row as Record<string, unknown>) : row
      ) }
    }
  }
  return input
}

async function collectScopedBatch(input: {
  runner: CommandRunner
  packageRunner: PackageRunner
  rangeArgs: string[]
  scope: CodexSessionScope
  options: CollectCodexUsageOptions
  collectedAt: string
}) {
  const env = { ...process.env, CODEX_HOME: input.scope.codexHome }
  const daily = await input.runner(
    input.packageRunner.command,
    input.packageRunner.runPackageArgs(ccusagePackageSpecifier, 'ccusage', codexCommandArgs({
      report: 'daily',
      rangeArgs: input.rangeArgs,
      singleThread: true
    })),
    packageCommandOptions({
      env,
      timeoutMs: readDailyTimeoutMs(),
      stderr: input.options.stderr
    })
  )
  const sessions = await collectSessionCounts({
    runner: input.runner,
    command: input.packageRunner.command,
    args: input.packageRunner.runPackageArgs(ccusagePackageSpecifier, 'ccusage', codexCommandArgs({
      report: 'session',
      rangeArgs: input.rangeArgs,
      singleThread: true
    })),
    options: packageCommandOptions({
      env,
      timeoutMs: readSessionTimeoutMs(),
      stderr: input.options.stderr
    }),
    stderr: input.options.stderr
  })
  return {
    snapshots: await normalizeAndCorrectCodexSnapshots({
      daily,
      sessions,
      correctionSessions: sessions,
      codexHomes: input.scope.codexHomes,
      options: input.options,
      collectedAt: input.collectedAt,
      includeSessionOnlySnapshots: false,
      subagentCacheFiles: cacheFilesForScope(input.scope)
    }),
    sessions
  }
}

async function warmCanonicalAttributionsFromScope(input: {
  stateDir?: string
  timezone: string
  scope: CodexSessionScope
  sessions?: unknown
  attributions?: ReadonlyMap<string, CodexSessionAttribution>
  stderr?: (line: string) => void
}) {
  if (!input.stateDir) return
  const attributions = new Map(input.attributions)
  if (!input.attributions) {
    for (const row of readSessionRows(input.sessions)) {
      const sourceFile = resolveScopedSessionSourceFile(row, input.scope)
      const attribution = readCcusageSessionAttribution(row, input.timezone)
      if (sourceFile && attribution) attributions.set(sourceFile, attribution)
    }
  }
  if (attributions.size === 0) return
  await withCodexSessionAttributionCache({
    stateDir: input.stateDir,
    timezone: input.timezone,
    callback: async (cache) => {
      for (const [sourceFile, attribution] of attributions) {
        const scopedFile = scopedFileForSourceFile(sourceFile, input.scope.sourceFiles)
        if (!scopedFile) {
          throw new Error('Codex scoped session attribution lost its source-file mapping')
        }
        const expectedFingerprint = input.scope.sourceFileFingerprints.get(sourceFile)
        if (!expectedFingerprint) {
          throw new Error('Codex scoped session attribution lost its source-file fingerprint')
        }
        const copiedFingerprint = await fingerprintCodexSessionFile(scopedFile)
        if (!sameFrozenScopeContent(copiedFingerprint, expectedFingerprint)) {
          throw new Error('Codex scoped session attribution changed unexpectedly')
        }
        const stored = await cache.storeIfUnchanged({
          filePath: sourceFile,
          fingerprint: expectedFingerprint,
          attribution
        })
        if (!stored) {
          input.stderr?.('Skipping stale Codex canonical attribution cache write for a session that changed after copy')
        }
      }
    }
  })
}

function scopedFileForSourceFile(sourceFile: string, sourceFiles: ReadonlyMap<string, string>) {
  for (const [scopedFile, originalFile] of sourceFiles) {
    if (originalFile === sourceFile) return scopedFile
  }
  return null
}

function sameFrozenScopeContent(
  fingerprint: Awaited<ReturnType<typeof fingerprintCodexSessionFile>>,
  expected: Awaited<ReturnType<typeof fingerprintCodexSessionFile>>
) {
  return fingerprint.size === expected.size && fingerprint.tailSha256 === expected.tailSha256
}

function cacheFilesForScope(scope: CodexSessionScope) {
  const cacheFiles = new Map<string, CodexSubagentUsageCacheFile>()
  for (const [scopedFile, sourceFile] of scope.sourceFiles) {
    const sourceFingerprint = scope.sourceFileFingerprints.get(sourceFile)
    if (!sourceFingerprint) {
      throw new Error('Codex frozen session scope lost its source-file fingerprint')
    }
    cacheFiles.set(scopedFile, { sourceFile, sourceFingerprint })
  }
  return cacheFiles
}

async function collectSessionCounts({
  runner,
  command,
  args,
  options,
  stderr = console.error,
  required = false
}: {
  runner: CommandRunner
  command: string
  args: string[]
  options: Parameters<CommandRunner>[2]
  stderr?: (line: string) => void
  required?: boolean
}) {
  try {
    return await runner(
      command,
      args,
      options
    )
  } catch (error) {
    if (required) throw error
    stderr(`Codex daily tokens collected, but session counts are unavailable; continuing with sessionCount=0: ${errorMessage(error)}`)
    return { data: [] }
  }
}

function buildRangeArgs(options: { since?: string; until?: string }) {
  const args: string[] = []
  if (options.since && options.since !== 'all') {
    args.push('--since', assertValidDateFilter(options.since, 'Codex since date', true))
  }
  if (options.until) {
    args.push('--until', assertValidDateFilter(options.until, 'Codex until date'))
  }
  return args
}

function withTimezoneArgs(args: string[], timezone: string) {
  return [...args, '--timezone', timezone]
}

function hookDateBounds(dates: string[]) {
  const first = dates[0]
  const last = dates.at(-1)
  if (!first || !last) {
    throw new Error('Codex hook reconciliation is missing changed usage dates')
  }
  return {
    since: first.replaceAll('-', ''),
    until: last.replaceAll('-', '')
  }
}

function readSince() {
  const since = process.env.TOKENBOARD_SINCE || process.env.TOKENBOARD_DEFAULT_SINCE || ''
  return since || ''
}

function resolveCodexHomesFromOptions(options: CollectCodexUsageOptions) {
  const hasExplicitOptions = options.codexHomes !== undefined || options.codexHome !== undefined
  return resolveConfiguredCodexHomes({
    explicitHomes: options.codexHomes,
    legacyValue: options.codexHome ?? (options.codexHomes === undefined ? process.env.CODEX_HOME : undefined),
    jsonValue: hasExplicitOptions ? undefined : process.env.TOKENBOARD_CODEX_HOMES_JSON
  })
}

function readBatchSize() {
  const value = Number(process.env.TOKENBOARD_CODEX_BATCH_SIZE || DEFAULT_CODEX_BATCH_SIZE)
  if (!Number.isFinite(value) || value < 1) {
    return DEFAULT_CODEX_BATCH_SIZE
  }
  return Math.min(Math.floor(value), MAX_CODEX_BATCH_SIZE)
}
