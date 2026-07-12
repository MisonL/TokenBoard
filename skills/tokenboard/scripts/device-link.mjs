import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { configDir } from './config.mjs'
import { isProcessAlive } from './process-liveness.mjs'

const deviceLinkStoreVersion = 2
const lockRetryDelayMs = 20
const lockWaitTimeoutMs = 2_000
const malformedLockGraceMs = 500
const lockMaxLeaseMs = 120_000
const lockRetryCount = Math.ceil(lockWaitTimeoutMs / lockRetryDelayMs) + 1
const sleepState = new Int32Array(new SharedArrayBuffer(4))
const defaultFs = {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
}

export function deviceLinkPath(root = configDir()) {
  return join(root, 'device-link.json')
}

export function writeDeviceLink(link, options = {}) {
  const root = options.configDir || configDir()
  const path = options.path || deviceLinkPath(root)
  const fs = options.fs || defaultFs
  const normalized = normalizeDeviceLink(link)
  fs.mkdirSync(root, { recursive: true })
  const update = () => {
    const store = readDeviceLinkStore(path, fs)
    store.servers[normalized.serverOrigin] = storedDeviceLink(normalized)
    writeDeviceLinkStore(path, store, fs)
  }
  if (options.fs) update()
  else withDeviceLinkLock(path, update)
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

function writeDeviceLinkStore(path, store, fs) {
  const content = `${JSON.stringify(store, null, 2)}\n`
  if (!fs.renameSync || !fs.rmSync) {
    fs.writeFileSync(path, content, { mode: 0o600 })
    fs.chmodSync?.(path, 0o600)
    return
  }
  const tempPath = `${path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`
  try {
    fs.writeFileSync(tempPath, content, { mode: 0o600 })
    fs.renameSync(tempPath, path)
    fs.chmodSync?.(path, 0o600)
  } catch (error) {
    fs.rmSync(tempPath, { force: true })
    throw error
  }
}

function withDeviceLinkLock(path, callback) {
  const lockPath = `${path}.lock`
  const owner = acquireDeviceLinkLock(lockPath)
  try {
    return callback()
  } finally {
    releaseDeviceLinkLock(lockPath, owner)
  }
}

function acquireDeviceLinkLock(lockPath) {
  for (let attempt = 0; attempt < lockRetryCount; attempt += 1) {
    const owner = { pid: process.pid, token: randomBytes(16).toString('hex') }
    let file = null
    let created = false
    try {
      file = openSync(lockPath, 'wx', 0o600)
      created = true
      try {
        writeFileSync(file, JSON.stringify(owner))
      } finally {
        closeSync(file)
        file = null
      }
      return owner
    } catch (error) {
      if (file !== null) closeSync(file)
      if (!isLockExistsError(error)) {
        if (created) rmSync(lockPath, { force: true })
        throw error
      }
      recoverDeviceLinkLock(lockPath)
      sleep(lockRetryDelayMs)
    }
  }
  throw new Error('Timed out waiting for TokenBoard device link lock')
}

function releaseDeviceLinkLock(lockPath, owner) {
  const identity = readLockIdentity(lockPath)
  if (!identity || !sameDeviceLinkLockOwner(lockPath, owner)) {
    throw new Error('TokenBoard device link lock ownership changed')
  }
  removeDeviceLinkLock(lockPath, identity, owner)
}

function recoverDeviceLinkLock(lockPath) {
  const identity = readLockIdentity(lockPath)
  if (!identity) return
  const owner = readDeviceLinkLockOwner(lockPath)
  if (!owner) {
    if (readLockAgeMs(lockPath) < malformedLockGraceMs) return
    removeDeviceLinkLock(lockPath, identity)
    return
  }
  if (isProcessAlive(owner.pid) && readLockAgeMs(lockPath) < lockMaxLeaseMs) return
  removeDeviceLinkLock(lockPath, identity, owner)
}

function removeDeviceLinkLock(lockPath, identity, owner) {
  if (!sameLockIdentity(lockPath, identity)) return
  if (owner && !sameDeviceLinkLockOwner(lockPath, owner)) return
  const quarantinePath = `${lockPath}.stale-${process.pid}-${randomBytes(8).toString('hex')}`
  try {
    renameSync(lockPath, quarantinePath)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  if (!sameLockIdentity(quarantinePath, identity) ||
      (owner && !sameDeviceLinkLockOwner(quarantinePath, owner))) {
    restoreDeviceLinkLock(lockPath, quarantinePath)
    return
  }
  rmSync(quarantinePath, { force: true })
}

function restoreDeviceLinkLock(lockPath, quarantinePath) {
  try {
    renameSync(quarantinePath, lockPath)
  } catch (error) {
    throw new Error('TokenBoard replacement device link lock could not be restored', { cause: error })
  }
}

function readDeviceLinkLockOwner(lockPath) {
  try {
    const owner = JSON.parse(readFileSync(lockPath, 'utf8'))
    if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) return null
    if (typeof owner.token !== 'string' || !owner.token) return null
    return owner
  } catch {
    return null
  }
}

function sameDeviceLinkLockOwner(lockPath, expected) {
  const current = readDeviceLinkLockOwner(lockPath)
  return current?.pid === expected.pid && current.token === expected.token
}

function readLockIdentity(lockPath) {
  try {
    const stats = statSync(lockPath, { bigint: true })
    return { dev: stats.dev, ino: stats.ino }
  } catch {
    return null
  }
}

function sameLockIdentity(lockPath, expected) {
  const current = readLockIdentity(lockPath)
  return current?.dev === expected.dev && current.ino === expected.ino
}

function readLockAgeMs(lockPath) {
  try {
    return Math.max(0, Date.now() - statSync(lockPath).mtimeMs)
  } catch {
    return 0
  }
}

function isLockExistsError(error) {
  return error?.code === 'EEXIST'
}

function sleep(milliseconds) {
  Atomics.wait(sleepState, 0, 0, milliseconds)
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
