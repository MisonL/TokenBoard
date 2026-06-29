import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { configDir } from './config.mjs'

export function deviceLinkPath(root = configDir()) {
  return join(root, 'device-link.json')
}

export function writeDeviceLink(link, options = {}) {
  const root = options.configDir || configDir()
  const path = options.path || deviceLinkPath(root)
  const fs = options.fs || { mkdirSync, writeFileSync }
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path, `${JSON.stringify(normalizeDeviceLink(link), null, 2)}\n`, { mode: 0o600 })
  return path
}

export function readDeviceLink(options = {}) {
  const path = options.path || deviceLinkPath(options.configDir || configDir())
  const fs = options.fs || { existsSync, readFileSync }
  if (!fs.existsSync(path)) return null
  return normalizeDeviceLink(JSON.parse(fs.readFileSync(path, 'utf8')))
}

export function deviceLinkStatus(options = {}) {
  const path = options.path || deviceLinkPath(options.configDir || configDir())
  const fs = options.fs || { existsSync }
  return {
    path,
    present: fs.existsSync(path)
  }
}

function normalizeDeviceLink(link) {
  if (!link || typeof link !== 'object' || Array.isArray(link)) {
    throw new Error('Invalid TokenBoard device link: expected object')
  }
  const normalized = {
    version: 1,
    serverOrigin: requiredString(link.serverOrigin, 'serverOrigin'),
    deviceId: requiredString(link.deviceId, 'deviceId'),
    installationId: requiredString(link.installationId, 'installationId'),
    installClaim: requiredString(link.installClaim, 'installClaim')
  }
  return normalized
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid TokenBoard device link: missing ${name}`)
  }
  return value
}
