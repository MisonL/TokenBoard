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
  return Boolean(flags['use-device-link'] || env.TOKENBOARD_USE_DEVICE_LINK === '1')
}

export async function createPairingCodeFromDeviceLink({
  baseUrl,
  readDeviceLink,
  fetcher = fetch
} = {}) {
  if (!baseUrl) {
    throw new Error('Missing --base-url or TOKENBOARD_BASE_URL')
  }
  const deviceLink = readDeviceLink()
  if (!deviceLink) {
    throw new Error('TokenBoard device link not found')
  }
  const baseOrigin = serverOriginFromUrl(baseUrl)
  if (!baseOrigin || deviceLink.serverOrigin !== baseOrigin) {
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
