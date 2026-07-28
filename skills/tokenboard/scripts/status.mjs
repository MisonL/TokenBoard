#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { configPath, readConfig } from './config.mjs'
import { deviceLinkStatus } from './device-link.mjs'
import { hookStatus } from './hooks.mjs'

export function buildStatus({ configPath, config, hooks = hookStatus(), deviceLink = deviceLinkStatus() }) {
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
    hooks: publicHookStatus(hooks)
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

  console.log(JSON.stringify(buildStatus({ configPath: file, config: readConfig() }), null, 2))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli()
}
