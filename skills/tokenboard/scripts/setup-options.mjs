export function buildInitialSyncArgs({ flags = {}, packageManager } = {}) {
  const args = [
    '--mode',
    'sync',
    '--source',
    'all',
    '--since',
    flags.since || 'all'
  ]
  if (typeof packageManager === 'string' && packageManager.trim()) {
    args.push('--package-manager', packageManager)
  }
  return args
}

export function shouldWarmHookCursorsBeforeInstall(flags = {}) {
  if (flags['skip-hook']) return false
  if (flags['skip-initial-sync']) return true
  return flags.since !== undefined && flags.since !== 'all'
}

export function buildWarmHookCursorArgs({ packageManager } = {}) {
  const args = ['--mode', 'warm-hooks', '--source', 'all', '--skip-upgrade']
  if (typeof packageManager === 'string' && packageManager.trim()) {
    args.push('--package-manager', packageManager)
  }
  return args
}

export function readSetupBaseUrl({ flags = {}, env = process.env } = {}) {
  const value = flags['base-url'] || env.TOKENBOARD_BASE_URL
  return value ? String(value).replace(/\/$/, '') : null
}

export function resolveSetupInstallOptions({
  flags = {},
  env = process.env,
  profile = {},
  defaultScheduleTimes = []
} = {}) {
  const scheduleTimes = flags['schedule-times'] ||
    env.TOKENBOARD_SCHEDULE_TIMES ||
    profile.scheduleTimes ||
    defaultScheduleTimes
  return {
    repoUrl: flags['repo-url'] || env.TOKENBOARD_REPO_URL || profile.repoUrl,
    repoRef: flags['repo-ref'] || env.TOKENBOARD_REPO_REF || profile.repoRef,
    packageManager: flags['package-manager'] || env.TOKENBOARD_PACKAGE_MANAGER || profile.packageManager || 'pnpm',
    scheduleTimesInput: Array.isArray(scheduleTimes) ? scheduleTimes.join(',') : scheduleTimes
  }
}

export function buildInstallCollectorArgs({ flags = {}, packageManager, installCollectorScript = './install-collector.mjs' } = {}) {
  const args = [installCollectorScript]
  if (flags['repo-url']) {
    args.push('--repo-url', flags['repo-url'])
  }
  if (flags['repo-ref']) {
    args.push('--repo-ref', flags['repo-ref'])
  }
  if (typeof packageManager === 'string' && packageManager.trim()) {
    args.push('--package-manager', packageManager)
  }
  return args
}

export function shouldUseDeviceLink(flags = {}, env = process.env) {
  const explicit = flags['use-device-link']
  if (explicit === false || explicit === 'false' || explicit === '0') {
    return false
  }
  if (explicit) {
    return true
  }
  return env.TOKENBOARD_USE_DEVICE_LINK === '1'
}

export async function createPairingCodeFromDeviceLink({
  baseUrl,
  readDeviceLink,
  writeDeviceLink,
  fetcher = fetch
} = {}) {
  if (!baseUrl) {
    throw new Error('Missing --base-url or TOKENBOARD_BASE_URL')
  }
  const baseOrigin = serverOriginFromUrl(baseUrl)
  if (!baseOrigin) {
    throw new Error('TokenBoard device link belongs to a different server')
  }
  const deviceLink = readDeviceLink({ serverOrigin: baseOrigin })
  if (!deviceLink) {
    throw new Error('TokenBoard device link not found')
  }
  if (deviceLink.serverOrigin !== baseOrigin) {
    throw new Error('TokenBoard device link belongs to a different server')
  }
  const response = await fetcher(`${baseOrigin}/api/v1/device/reconnect-pairing-codes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      deviceId: deviceLink.deviceId,
      installationId: deviceLink.installationId,
      installClaim: deviceLink.installClaim
    })
  })
  if (!response.ok) {
    throw new Error(`Device-link reconnect failed with status ${response.status}`)
  }
  const result = await response.json()
  if (result && typeof result.installClaim === 'string' && result.installClaim.trim() !== '') {
    if (typeof writeDeviceLink !== 'function') {
      throw new Error('Failed to refresh TokenBoard device link after reconnect')
    }
    try {
      await writeDeviceLink({
        serverOrigin: baseOrigin,
        deviceId: deviceLink.deviceId,
        installationId: deviceLink.installationId,
        installClaim: result.installClaim
      })
    } catch {
      throw new Error('Failed to refresh TokenBoard device link after reconnect')
    }
  }
  if (!result || typeof result.pairingCode !== 'string' || result.pairingCode.trim() === '') {
    throw new Error('Device-link reconnect response did not include a pairing code')
  }
  return result.pairingCode
}

function serverOriginFromUrl(value) {
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}
