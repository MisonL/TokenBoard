#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { hostname, platform } from 'node:os'
import {
  configPath,
  parseArgs,
  readConfig,
  readPackageManager,
  serverOriginFromEndpoint,
  withServerProfile,
  writeConfig
} from './config.mjs'
import { existsSync } from 'node:fs'
import { readDeviceLink, writeDeviceLink } from './device-link.mjs'
import { dailyScheduleTimes, parseScheduleTimes } from './schedule.mjs'
import {
  buildInitialSyncArgs,
  buildInstallCollectorArgs,
  buildWarmHookCursorArgs,
  createPairingCodeFromDeviceLink,
  readSetupBaseUrl,
  shouldUseDeviceLink,
  shouldWarmHookCursorsBeforeInstall
} from './setup-options.mjs'

const flags = parseArgs(process.argv.slice(2))
let pairingCode = flags['pairing-code'] || process.env.TOKENBOARD_PAIRING_CODE
const baseUrl = readSetupBaseUrl({ flags })
const timezone = flags.timezone || process.env.TOKENBOARD_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone
const deviceName = flags['device-name'] || `${hostname()} ${platform()}`
const packageManager = readPackageManager(flags)
const scheduleTimes = parseScheduleTimes(flags['schedule-times'] || process.env.TOKENBOARD_SCHEDULE_TIMES || dailyScheduleTimes.join(','))

if (!baseUrl) {
  console.error('Missing --base-url or TOKENBOARD_BASE_URL')
  process.exit(1)
}
if (!pairingCode && shouldUseDeviceLink(flags)) {
  try {
    pairingCode = await createPairingCodeFromDeviceLink({
      baseUrl,
      readDeviceLink
    })
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
if (!pairingCode) {
  console.error('Missing --pairing-code')
  process.exit(1)
}

const response = await fetch(`${baseUrl}/api/v1/device/pair`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    pairingCode,
    deviceName,
    platform: platform(),
    timezone
  })
})

if (!response.ok) {
  console.error(`Pairing failed with status ${response.status}: ${await response.text()}`)
  process.exit(1)
}

const paired = await response.json()
const currentConfig = existsSync(configPath()) ? readConfig() : {}
const serverOrigin = serverOriginFromEndpoint(paired.endpoint || baseUrl)
if (!serverOrigin) {
  console.error('Pairing response did not include a valid endpoint.')
  process.exit(1)
}
const nextConfig = withServerProfile(currentConfig, serverOrigin, {
  endpoint: paired.endpoint,
  uploadToken: paired.uploadToken,
  deviceId: paired.deviceId,
  installationId: paired.installationId,
  timezone: paired.timezone,
  source: 'all',
  repoUrl: flags['repo-url'] || process.env.TOKENBOARD_REPO_URL,
  repoRef: flags['repo-ref'] || process.env.TOKENBOARD_REPO_REF,
  packageManager,
  scheduleTimes,
  createdAt: new Date().toISOString()
})
writeConfig(nextConfig)
if (paired.installClaim) {
  writeDeviceLink({
    serverOrigin,
    deviceId: paired.deviceId,
    installationId: paired.installationId,
    installClaim: paired.installClaim
  })
}
console.log('TokenBoard config written.')

function scriptPath(name) {
  return fileURLToPath(new URL(name, import.meta.url))
}

if (!flags['skip-collector']) {
  const installCollector = spawnSync(
    process.execPath,
    buildInstallCollectorArgs({
      flags,
      packageManager,
      installCollectorScript: scriptPath('./install-collector.mjs')
    }),
    {
      stdio: 'inherit'
    }
  )
  if (installCollector.status !== 0) process.exit(installCollector.status ?? 1)
}

if (!flags['skip-schedule']) {
  const schedule = spawnSync(process.execPath, [
    scriptPath('./install-schedule.mjs'),
    '--schedule-times',
    scheduleTimes.join(',')
  ], {
    stdio: 'inherit'
  })
  if (schedule.status !== 0) process.exit(schedule.status ?? 1)
}

if (!flags['skip-initial-sync']) {
  const sync = spawnSync(
    process.execPath,
    [
      scriptPath('./sync.mjs'),
      ...buildInitialSyncArgs({ flags, packageManager })
    ],
    {
      stdio: 'inherit'
    }
  )
  if (sync.status !== 0) process.exit(sync.status ?? 1)
}

if (shouldWarmHookCursorsBeforeInstall(flags)) {
  const warm = spawnSync(
    process.execPath,
    [
      scriptPath('./sync.mjs'),
      ...buildWarmHookCursorArgs({ packageManager })
    ],
    {
      stdio: 'inherit'
    }
  )
  if (warm.status !== 0) process.exit(warm.status ?? 1)
}

if (!flags['skip-hook']) {
  const hook = spawnSync(process.execPath, [
    scriptPath('./install-hook.mjs')
  ], {
    stdio: 'inherit'
  })
  if (hook.status !== 0) process.exit(hook.status ?? 1)
}
