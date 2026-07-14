#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { configPath, readConfig } from './config.mjs'
import { deviceLinkStatus } from './device-link.mjs'
import { hookStatus } from './hooks.mjs'

export function buildStatus({ configPath, config, hooks = hookStatus(), deviceLink = deviceLinkStatus() }) {
  return {
    configured: true,
    configPath,
    activeServer: config.activeServer,
    endpoint: config.endpoint,
    deviceId: config.deviceId,
    installationId: config.installationId,
    timezone: config.timezone,
    source: config.source,
    packageManager: config.packageManager || 'pnpm',
    collectorDir: config.collectorDir,
    scheduleTimes: Array.isArray(config.scheduleTimes) ? config.scheduleTimes : [],
    deviceLink,
    hooks
  }
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
