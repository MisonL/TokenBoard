#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isMainModule } from './is-main.mjs'
import { configPath, readConfig } from './config.mjs'
import { printHelpIfRequested } from './cli-help.mjs'
import { errorMessage } from './error-message.mjs'
import { deviceLinkStatus } from './device-link.mjs'
import { hookStatus } from './hooks.mjs'
import { scheduledRetryLegacyStatePath, scheduledRetryStatePath } from './scheduled-retry.mjs'
import { readScheduledSyncState, scheduledSyncStatePath } from './scheduled-sync-state.mjs'

export function buildStatus({
  configPath,
  config,
  hooks = hookStatus(),
  deviceLink = deviceLinkStatus(),
  scheduledRetry,
  scheduledSync,
  recentRuns
}) {
  return {
    configured: true,
    activeServerConfigured: hasValue(config.activeServer),
    collectorConfigured: hasValue(config.collectorDir),
    deviceIdentityConfigured: hasValue(config.deviceId) && hasValue(config.installationId),
    deviceLinkPresent: deviceLink.present === true,
    timezone: config.timezone,
    source: config.source,
    packageManager: config.packageManager || 'pnpm',
    scheduleTimes: Array.isArray(config.scheduleTimes) ? config.scheduleTimes : [],
    hooks: publicHookStatus(hooks),
    ...(config.upgradedCommit ? { lastUpgradedCommit: config.upgradedCommit } : {}),
    ...(config.upgradedAt ? { upgradedAt: config.upgradedAt } : {}),
    ...(scheduledRetry ? { scheduledRetry: publicScheduledRetry(scheduledRetry) } : {}),
    ...(scheduledSync ? { scheduledSync: publicScheduledSync(scheduledSync) } : {}),
    ...(recentRuns ? { recentRuns } : {})
  }
}

// Aggregates the coordinator's bounded run-log directory (1024 files max) into per-status
// counts for the last 7 days. Run logs contain local paths and full diagnostic output, so
// this reports only counts and a timestamp — never file contents or error text. A half-written
// file (run logs are written with a plain writeFile) counts as invalid rather than failing
// status, mirroring how retry-state reads degrade.
export function collectRecentRunSummary(runsDir, { now = new Date(), readdir = readdirSync, readFile = readFileSync } = {}) {
  let names
  try {
    names = readdir(runsDir)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  const windowStartMs = now.getTime() - 7 * 24 * 60 * 60 * 1000
  const summary = { windowDays: 7, total: 0, success: 0, error: 0, skipped: 0, invalid: 0, lastErrorAt: null }
  for (const name of names) {
    const match = /^(\d{4}-\d{2}-\d{2})T/.exec(name)
    if (!match || !name.endsWith('.json')) continue
    const startedMs = Date.parse(`${match[1]}T00:00:00.000Z`)
    if (!Number.isFinite(startedMs) || startedMs < windowStartMs) continue
    summary.total += 1
    try {
      const parsed = JSON.parse(readFile(join(runsDir, name), 'utf8'))
      if (parsed.status === 'success') summary.success += 1
      else if (parsed.status === 'error') {
        summary.error += 1
        // runId embeds the ISO start time with ':' replaced by '-'; restore it just long
        // enough to Date.parse the prefix before the random suffix.
        const timestampPart = name.slice(0, name.indexOf('.json'))
        const runStarted = Date.parse(timestampPart.slice(0, 24).replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3'))
        if (Number.isFinite(runStarted) && (!summary.lastErrorAt || runStarted > Date.parse(summary.lastErrorAt))) {
          summary.lastErrorAt = new Date(runStarted).toISOString()
        }
      } else if (parsed.status === 'skipped') summary.skipped += 1
      else summary.invalid += 1
    } catch {
      summary.invalid += 1
    }
  }
  if (summary.lastErrorAt === null) delete summary.lastErrorAt
  return summary
}

function publicScheduledSync(value) {
  if (value.status === 'invalid') return { status: 'invalid' }
  return {
    status: value.status,
    source: value.source,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    ...(value.completedAt ? { completedAt: value.completedAt } : {}),
    ...(Number.isSafeInteger(value.exitCode) ? { exitCode: value.exitCode } : {})
  }
}

function publicScheduledRetry(value) {
  if (value.status === 'invalid') return { status: 'invalid' }
  return {
    status: value.status,
    retryAttempt: value.retryAttempt,
    maxAttempts: value.maxAttempts,
    updatedAt: value.updatedAt,
    ...(value.nextRetryAt ? { nextRetryAt: value.nextRetryAt } : {})
  }
}

function hasValue(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function publicHookStatus(hooks) {
  return {
    notifyHandler: hookState(hooks?.notifyHandler),
    codex: hookState(hooks?.codex),
    claudeCode: hookState(hooks?.claudeCode),
    antigravityCli: hookState(hooks?.antigravityCli),
    antigravityIde: hookState(hooks?.antigravityIde),
    antigravity: hookState(hooks?.antigravity)
  }
}

function hookState(value) {
  return value === 'installed' || value === 'installed-local-history' || value === 'not-installed' || value === 'error'
    ? value
    : 'unknown'
}

function runCli() {
  if (printHelpIfRequested(process.argv.slice(2), 'Usage: status.mjs')) return
  const file = configPath()
  if (!existsSync(file)) {
    console.log('TokenBoard is not configured.')
    process.exit(1)
  }

  const config = readConfig()
  const source = typeof config.source === 'string' && config.source.trim() ? config.source : 'all'
  const stateDir = process.env.TOKENBOARD_STATE_DIR || dirname(file)
  console.log(
    JSON.stringify(
      buildStatus({
        configPath: file,
        config,
        scheduledRetry: readScheduledRetry(file, source),
        scheduledSync: readScheduledSync(source, stateDir),
        recentRuns: collectRecentRunSummary(join(dirname(file), 'runs'))
      }),
      null,
      2
    )
  )
}

function readScheduledSync(source, stateDir) {
  const current = readScheduledSyncState(scheduledSyncStatePath(stateDir, source))
  if (current || source === 'all') return current

  // The unsuffixed file is what a `--source all` install writes, so its `source` is
  // always 'all'. Comparing it against a per-source value could never match, which made
  // this fallback dead code and hid the sync state for every non-'all' configuration.
  const legacy = readScheduledSyncState(scheduledSyncStatePath(stateDir))
  if (!legacy || legacy.status === 'invalid') return legacy
  return legacy.source === 'all' || legacy.source === source ? legacy : null
}

function readScheduledRetry(configFile, source = 'all') {
  const stateDir = process.env.TOKENBOARD_STATE_DIR || dirname(configFile)
  const statePath = scheduledRetryStatePath(stateDir, source)
  const state = readRetryState(statePath)
  if (source === 'all') return state
  const sourceState = isRetryStateForSource(state, source) ? state : null
  const legacyStatePath = scheduledRetryLegacyStatePath(stateDir)
  const legacy = readRetryState(legacyStatePath)
  const legacyState = isRetryStateForSource(legacy, source) ? legacy : null
  return preferRetryState(sourceState, legacyState)
}

function isRetryStateForSource(state, source) {
  return state && (state.status === 'invalid' || state.source === source || state.source === 'all')
}

function preferRetryState(primary, fallback) {
  if (!primary) return fallback
  if (primary.status === 'invalid') return primary
  if (!fallback) return primary
  const primaryUpdatedAt = retryStateUpdatedAt(primary)
  const fallbackUpdatedAt = retryStateUpdatedAt(fallback)
  if (primaryUpdatedAt === null) return fallbackUpdatedAt === null ? primary : fallback
  if (fallbackUpdatedAt === null) return primary
  return fallbackUpdatedAt > primaryUpdatedAt ? fallback : primary
}

function retryStateUpdatedAt(state) {
  if (state.status === 'invalid') return null
  const value = Date.parse(state.updatedAt)
  return Number.isFinite(value) ? value : null
}

function readRetryState(statePath) {
  try {
    const value = JSON.parse(readFileSync(statePath, 'utf8'))
    return isScheduledRetryState(value) ? value : { status: 'invalid' }
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    if (!(error instanceof SyntaxError)) throw error
    return { status: 'invalid' }
  }
}

function isScheduledRetryState(value) {
  return (
    value &&
    typeof value === 'object' &&
    value.schemaVersion === 'tokenboard-scheduled-sync-retry/v1' &&
    typeof value.source === 'string' &&
    value.source.trim().length > 0 &&
    scheduledRetryStatuses.has(value.status) &&
    Number.isSafeInteger(value.retryAttempt) &&
    Number.isSafeInteger(value.maxAttempts) &&
    value.retryAttempt >= 0 &&
    value.maxAttempts > 0 &&
    value.retryAttempt <= value.maxAttempts &&
    isIsoTimestamp(value.updatedAt) &&
    (value.nextRetryAt === undefined || isIsoTimestamp(value.nextRetryAt))
  )
}

const scheduledRetryStatuses = new Set(['deferred', 'retrying', 'completed', 'failed', 'exhausted'])

function isIsoTimestamp(value) {
  if (typeof value !== 'string') return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

if (isMainModule(import.meta.url)) {
  try {
    runCli()
  } catch (error) {
    // Node's uncaught-exception handler prints the throwing source line, and for this
    // script that line can be the config file's contents — including the upload token.
    // Printing only the message keeps the diagnosis and the secret apart.
    console.error(errorMessage(error))
    process.exit(1)
  }
}
