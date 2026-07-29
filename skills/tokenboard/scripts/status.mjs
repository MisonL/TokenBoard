#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configPath, readConfig } from './config.mjs'
import { deviceLinkStatus } from './device-link.mjs'
import { hookStatus } from './hooks.mjs'

export function buildStatus({ configPath, config, hooks = hookStatus(), deviceLink = deviceLinkStatus(), scheduledRetry }) {
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
    ...(scheduledRetry ? { scheduledRetry: publicScheduledRetry(scheduledRetry) } : {})
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
  return value === 'installed' ||
    value === 'installed-local-history' ||
    value === 'not-installed' ||
    value === 'error'
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
  console.log(JSON.stringify(buildStatus({
    configPath: file,
    config,
    scheduledRetry: readScheduledRetry(file)
  }), null, 2))
}

function readScheduledRetry(configFile) {
  const stateDir = process.env.TOKENBOARD_STATE_DIR || dirname(configFile)
  const statePath = join(stateDir, 'scheduled-sync-retry.json')
  if (!existsSync(statePath)) return null
  try {
    const value = JSON.parse(readFileSync(statePath, 'utf8'))
    return isScheduledRetryState(value) ? value : { status: 'invalid' }
  } catch {
    return { status: 'invalid' }
  }
}

function isScheduledRetryState(value) {
  return value && typeof value === 'object' &&
    value.schemaVersion === 'tokenboard-scheduled-sync-retry/v1' &&
    typeof value.source === 'string' && value.source.trim().length > 0 &&
    scheduledRetryStatuses.has(value.status) &&
    Number.isSafeInteger(value.retryAttempt) &&
    Number.isSafeInteger(value.maxAttempts) &&
    value.retryAttempt >= 0 &&
    value.maxAttempts > 0 &&
    value.retryAttempt <= value.maxAttempts &&
    isIsoTimestamp(value.updatedAt) &&
    (value.nextRetryAt === undefined || isIsoTimestamp(value.nextRetryAt))
}

const scheduledRetryStatuses = new Set(['deferred', 'retrying', 'completed', 'failed', 'exhausted'])

function isIsoTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli()
}
