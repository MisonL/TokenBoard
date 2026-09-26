#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configPath, readConfig } from './config.mjs'
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
  scheduledSync
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
    ...(scheduledRetry ? { scheduledRetry: publicScheduledRetry(scheduledRetry) } : {}),
    ...(scheduledSync ? { scheduledSync: publicScheduledSync(scheduledSync) } : {})
  }
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
        scheduledSync: readScheduledSync(source, stateDir)
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
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
