#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  configPath,
  parseArgs,
  readConfig,
  serverOriginFromEndpoint,
  withServerProfile,
  writeConfig
} from './config.mjs'
import { writeDeviceLink } from './device-link.mjs'

export function applyRotatedToken({
  currentConfig,
  serverOrigin,
  uploadToken,
  deviceId,
  installationId,
  installClaim,
  writeConfigFn = writeConfig,
  writeDeviceLinkFn = writeDeviceLink
}) {
  const currentProfile = readCurrentServerProfile(currentConfig, serverOrigin)
  const nextConfig = withServerProfile(currentConfig, serverOrigin, {
    ...currentProfile,
    uploadToken,
    deviceId,
    installationId
  })
  writeConfigFn(nextConfig)
  if (installClaim) {
    writeDeviceLinkFn({
      serverOrigin,
      deviceId,
      installationId,
      installClaim
    })
  }
  return nextConfig
}

function readCurrentServerProfile(config, serverOrigin) {
  if (!config || typeof config !== 'object') {
    throw new Error('TokenBoard config is invalid')
  }
  const profile = config.servers?.[serverOrigin]
  if (profile && typeof profile === 'object') return profile
  if (config.activeServer === serverOrigin) return config
  if (!config.activeServer && serverOriginFromEndpoint(config.endpoint) === serverOrigin) {
    return config
  }
  throw new Error('TokenBoard config does not contain this server profile')
}

function requiredFlag(flags, name) {
  const value = flags[name]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing --${name}`)
  }
  return value
}

function readServerOrigin(flags) {
  const serverOrigin = flags['server-origin'] || serverOriginFromEndpoint(flags.endpoint)
  if (typeof serverOrigin !== 'string' || serverOrigin.trim() === '') {
    throw new Error('Missing --server-origin or --endpoint')
  }
  return new URL(serverOrigin).origin
}

function runCli() {
  try {
    if (!existsSync(configPath())) {
      throw new Error(`TokenBoard config not found: ${configPath()}`)
    }
    const flags = parseArgs(process.argv.slice(2))
    applyRotatedToken({
      currentConfig: readConfig(),
      serverOrigin: readServerOrigin(flags),
      uploadToken: requiredFlag(flags, 'upload-token'),
      deviceId: requiredFlag(flags, 'device-id'),
      installationId: requiredFlag(flags, 'installation-id'),
      installClaim: flags['install-claim'] ? String(flags['install-claim']) : null
    })
    console.log('TokenBoard rotated token written.')
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli()
}
