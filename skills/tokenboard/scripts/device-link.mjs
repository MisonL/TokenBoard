import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { configDir } from './config.mjs'

const deviceLinkStoreVersion = 2

export function deviceLinkPath(root = configDir()) {
  return join(root, 'device-link.json')
}

export function writeDeviceLink(link, options = {}) {
  const root = options.configDir || configDir()
  const path = options.path || deviceLinkPath(root)
  const fs = options.fs || { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync }
  const normalized = normalizeDeviceLink(link)
  const store = readDeviceLinkStore(path, fs)
  store.servers[normalized.serverOrigin] = storedDeviceLink(normalized)
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
  fs.chmodSync?.(path, 0o600)
  return path
}

export function readDeviceLink(options = {}) {
  const path = options.path || deviceLinkPath(options.configDir || configDir())
  const fs = options.fs || { existsSync, readFileSync }
  if (!fs.existsSync(path)) return null
  const store = normalizeDeviceLinkStore(JSON.parse(fs.readFileSync(path, 'utf8')))
  const requestedOrigin = options.serverOrigin
    ? normalizeServerOrigin(options.serverOrigin)
    : null
  if (requestedOrigin) {
    return store.servers[requestedOrigin]
      ? deviceLinkFromStored(requestedOrigin, store.servers[requestedOrigin])
      : null
  }
  const entries = Object.entries(store.servers)
  if (entries.length === 0) return null
  if (entries.length > 1) {
    throw new Error('Invalid TokenBoard device link: serverOrigin is required')
  }
  return deviceLinkFromStored(entries[0][0], entries[0][1])
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
    serverOrigin: normalizeServerOrigin(link.serverOrigin),
    deviceId: requiredString(link.deviceId, 'deviceId'),
    installationId: requiredString(link.installationId, 'installationId'),
    installClaim: requiredString(link.installClaim, 'installClaim')
  }
  return normalized
}

function readDeviceLinkStore(path, fs) {
  if (!fs.existsSync(path)) {
    return { version: deviceLinkStoreVersion, servers: {} }
  }
  return normalizeDeviceLinkStore(JSON.parse(fs.readFileSync(path, 'utf8')))
}

function normalizeDeviceLinkStore(value) {
  if (value?.version !== deviceLinkStoreVersion) {
    const legacy = normalizeDeviceLink(value)
    return {
      version: deviceLinkStoreVersion,
      servers: { [legacy.serverOrigin]: storedDeviceLink(legacy) }
    }
  }
  if (!value.servers || typeof value.servers !== 'object' || Array.isArray(value.servers)) {
    throw new Error('Invalid TokenBoard device link: expected servers object')
  }
  const servers = {}
  for (const [serverOrigin, link] of Object.entries(value.servers)) {
    const normalized = normalizeDeviceLink({ ...link, serverOrigin })
    servers[normalized.serverOrigin] = storedDeviceLink(normalized)
  }
  return { version: deviceLinkStoreVersion, servers }
}

function storedDeviceLink(link) {
  return {
    deviceId: link.deviceId,
    installationId: link.installationId,
    installClaim: link.installClaim
  }
}

function deviceLinkFromStored(serverOrigin, link) {
  return normalizeDeviceLink({ ...link, serverOrigin })
}

function normalizeServerOrigin(value) {
  const raw = requiredString(value, 'serverOrigin')
  try {
    return new URL(raw).origin
  } catch {
    throw new Error('Invalid TokenBoard device link: invalid serverOrigin')
  }
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid TokenBoard device link: missing ${name}`)
  }
  return value
}
