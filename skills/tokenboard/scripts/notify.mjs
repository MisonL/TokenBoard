#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { linkSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configDir, parseArgs, readConfig } from './config.mjs'
import { coordinatedSync } from './coordinator.mjs'
import { errorMessage } from './error-message.mjs'
import { probeProcessLiveness } from './process-liveness.mjs'

export const defaultNotifyCooldownMs = 15 * 60_000
const minNotifyCooldownMs = 60_000
const maxNotifyCooldownMs = 60 * 60_000
const maxTrailingLockAcquireAttempts = 3

export function runNotify(options = {}) {
  const flags = options.flags || parseArgs(options.argv || process.argv.slice(2))
  const source = readSource(flags.source)
  const env = options.env || process.env
  const stateDir = options.stateDir
  const configDirectory = options.configDir || stateDir
  const trigger = { kind: 'notify', source }
  return coordinatedSync(trigger, {
    stateDir,
    cooldownMs: readNotifyCooldownMs(options.cooldownMs, env),
    version: options.version || 'unknown',
    now: options.now,
    mkdir: options.mkdir,
    exists: options.exists,
    readFile: options.readFile,
    writeFile: options.writeFile,
    readdir: options.readdir,
    rename: options.rename,
    link: options.link,
    unlink: options.unlink,
    sleep: options.sleep,
    process: options.process,
    trailingProcess: options.trailingProcess ?? hasTrailingDelay(env),
    scheduleTrailing: options.scheduleTrailing || ((trigger, delayMs) =>
      scheduleTrailingNotify(trigger, delayMs, { ...options, env, configDir: configDirectory })
    ),
    executeSync: options.executeSync || ((trigger, lockToken) => executeTokenBoardSync(trigger.source, { ...options, env, lockToken }))
  })
}

export function executeTokenBoardSync(source, options = {}) {
  if (typeof options.lockToken !== 'string' || !options.lockToken) {
    throw new Error('TokenBoard coordinator lock token is required for hook sync')
  }
  const scriptPath = options.syncScriptPath || fileURLToPath(new URL('./sync.mjs', import.meta.url))
  const spawn = options.spawn || spawnSync
  const result = spawn(
    options.nodePath || process.execPath,
    [scriptPath, '--mode', 'sync', '--source', source, '--hook'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...(options.env || process.env),
        TOKENBOARD_COORDINATOR_LOCK_HELD: '1',
        TOKENBOARD_COORDINATOR_LOCK_TOKEN: options.lockToken
      }
    }
  )
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(formatSyncFailure(result))
  }
  return { source, exitCode: 0 }
}

function scheduleTrailingNotify(trigger, delayMs, options = {}) {
  const runtime = trailingRuntime(options)
  const lockPath = join(runtime.stateDir, 'trailing.lock')
  const lock = acquireTrailingLock(lockPath, runtime)
  if (lock.ownedByCurrentProcess) return true
  if (!lock.acquired) return true

  const spawnProcess = options.spawnDetached || spawn
  const nodePath = options.nodePath || process.execPath
  const scriptPath = options.notifyScriptPath || fileURLToPath(import.meta.url)
  try {
    const child = spawnProcess(
      nodePath,
      [scriptPath, '--source', trigger.source],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: {
          ...runtime.env,
          TOKENBOARD_CONFIG_DIR: runtime.configDir,
          TOKENBOARD_STATE_DIR: runtime.stateDir,
          TOKENBOARD_NOTIFY_TRAILING_DELAY_MS: String(delayMs),
          TOKENBOARD_NOTIFY_TRAILING_LOCK_PATH: lockPath,
          TOKENBOARD_NOTIFY_DISPATCH_LOCK_PATH: '',
          TOKENBOARD_NOTIFY_DISPATCH_LOCK_TOKEN: '',
          TOKENBOARD_NOTIFY_DISPATCH_WORKER_PATH: ''
        }
      }
    )
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
      throw new Error('TokenBoard trailing notifier did not provide a valid process id')
    }
    publishTrailingLock(lockPath, {
      pid: child.pid,
      startedAt: new Date(runtime.now()).toISOString()
    }, runtime)
    child.unref?.()
    return true
  } catch (error) {
    try {
      releaseTrailingLock(lockPath, runtime)
    } catch (cleanupError) {
      throw new Error(`${errorMessage(error)}; trailing lock cleanup failed: ${errorMessage(cleanupError)}`)
    }
    throw error
  }
}

function readSource(value) {
  if (value === 'codex' || value === 'claude-code') {
    return value
  }
  throw new Error('Usage: notify.mjs --source codex|claude-code')
}

export async function runNotifyCli(options = {}) {
  const env = options.env || process.env
  const trailingLockPath = env.TOKENBOARD_NOTIFY_TRAILING_LOCK_PATH || ''
  const dispatchLockPath = env.TOKENBOARD_NOTIFY_DISPATCH_LOCK_PATH || ''
  const dispatchLockToken = env.TOKENBOARD_NOTIFY_DISPATCH_LOCK_TOKEN || ''
  const dispatchWorkerPath = env.TOKENBOARD_NOTIFY_DISPATCH_WORKER_PATH || ''
  const readCurrentConfig = options.readConfig || readConfig
  const readConfigDirectory = options.configDir || configDir
  const notify = options.runNotify || runNotify
  const wait = options.waitTrailingDelay || waitTrailingDelay
  const reportError = options.error || console.error
  const runtime = options.trailingRuntime || trailingRuntime({ env })
  let dispatchClaimed = false
  try {
    dispatchClaimed = claimDispatchLock(dispatchLockPath, dispatchLockToken, { workerPath: dispatchWorkerPath })
    if (!dispatchClaimed) return 0
    const config = readCurrentConfig()
    const configuredDir = readConfigDirectory()
    let delayMs = trailingDelayMsFromEnvironment(env)
    while (true) {
      await wait(delayMs)
      const result = notify({
        configDir: configuredDir,
        stateDir: env.TOKENBOARD_STATE_DIR || configuredDir,
        env,
        trailingProcess: Boolean(trailingLockPath) || delayMs > 0,
        version: config.updatedAt || config.createdAt || 'unknown'
      })
      if (result.error) {
        if (!result.trailingScheduled) throw new Error(result.error)
        reportError(`TokenBoard hook sync retry scheduled after error: ${result.error}`)
      }
      const nextDelayMs = trailingContinuationDelay(result, trailingLockPath, runtime)
      if (nextDelayMs === null) return 0
      delayMs = nextDelayMs
    }
  } catch (error) {
    reportError(errorMessage(error))
    return 1
  } finally {
    releaseTrailingLock(trailingLockPath, runtime)
    if (dispatchClaimed) releaseDispatchLock(dispatchLockPath, dispatchLockToken, { workerPath: dispatchWorkerPath })
  }
}

export function readNotifyCooldownMs(explicitValue, env = process.env) {
  if (explicitValue !== undefined) {
    if (!Number.isSafeInteger(explicitValue) || explicitValue < 0) {
      throw new Error('TokenBoard notify cooldown must be a nonnegative integer')
    }
    return explicitValue
  }

  const configuredValue = env.TOKENBOARD_NOTIFY_COOLDOWN_MS
  if (configuredValue === undefined || configuredValue === '') return defaultNotifyCooldownMs
  if (!/^[1-9][0-9]*$/.test(configuredValue)) {
    throw new Error('TOKENBOARD_NOTIFY_COOLDOWN_MS must be an integer number of milliseconds')
  }

  const cooldownMs = Number(configuredValue)
  if (!Number.isSafeInteger(cooldownMs) || cooldownMs < minNotifyCooldownMs || cooldownMs > maxNotifyCooldownMs) {
    throw new Error(`TOKENBOARD_NOTIFY_COOLDOWN_MS must be between ${minNotifyCooldownMs} and ${maxNotifyCooldownMs} milliseconds`)
  }
  return cooldownMs
}

async function waitTrailingDelay(delayMs = trailingDelayMsFromEnvironment()) {
  if (!Number.isFinite(delayMs) || delayMs <= 0) return
  await new Promise((resolve) => setTimeout(resolve, delayMs))
}

function hasTrailingDelay(env = process.env) {
  const delayMs = trailingDelayMsFromEnvironment(env)
  return Number.isFinite(delayMs) && delayMs > 0
}

function trailingDelayMsFromEnvironment(env = process.env) {
  return Number.parseInt(env.TOKENBOARD_NOTIFY_TRAILING_DELAY_MS || '', 10)
}

function trailingContinuationDelay(result, lockPath, runtime = trailingRuntime({})) {
  if (!lockPath || !result.trailingScheduled || !isTrailingLockOwnedByCurrentProcess(lockPath, runtime)) {
    return null
  }
  const delayMs = Number(result.trailingDelayMs)
  return Number.isFinite(delayMs) && delayMs > 0 ? delayMs : null
}

function formatSyncFailure(result) {
  const exitCode = result.status ?? 1
  const stderr = normalizeChildOutput(result.stderr)
  if (!stderr) {
    return `TokenBoard hook sync failed with exit code ${exitCode}`
  }
  return `TokenBoard hook sync failed with exit code ${exitCode}: ${stderr}`
}

function normalizeChildOutput(value) {
  const text = Array.isArray(value) ? value.join('') : String(value || '')
  return text.trim().replace(/\s+/g, ' ')
}

function trailingRuntime(options = {}) {
  const env = options.env || process.env
  const stateDir = options.stateDir || env.TOKENBOARD_STATE_DIR || configDir()
  const hasCustomFileOps = Boolean(options.readFile || options.writeFile || options.unlink || options.rename || options.link)
  return {
    env,
    configDir: options.configDir || env.TOKENBOARD_CONFIG_DIR || stateDir,
    stateDir,
    now: options.now || Date.now,
    nodeVersion: options.nodeVersion || process.versions.node,
    platform: options.platform || process.platform,
    process: options.process || process,
    mkdir: options.mkdir || mkdirSync,
    readFile: options.readFile || ((path) => readFileSync(path, 'utf8')),
    runTasklist: options.runTasklist,
    writeFile: options.writeFile || writeFileSync,
    readdir: options.readdir || readdirSync,
    rename: options.rename || (hasCustomFileOps ? undefined : renameSync),
    link: options.link || (hasCustomFileOps ? undefined : linkSync),
    unlink: options.unlink || unlinkSync
  }
}

function acquireTrailingLock(lockPath, runtime) {
  for (let attempt = 0; attempt < maxTrailingLockAcquireAttempts; attempt += 1) {
    try {
      runtime.writeFile(lockPath, JSON.stringify({ pid: runtime.process.pid, startedAt: new Date(runtime.now()).toISOString() }), { flag: 'wx' })
      return { acquired: true }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const record = readTrailingLockRecord(lockPath, runtime)
      if (!record) continue
      if (record?.pid === runtime.process.pid) {
        return { acquired: false, ownedByCurrentProcess: true }
      }
      if (!isTrailingLockStale(record, runtime)) return { acquired: false }
      if (!releaseTrailingLock(lockPath, runtime, { force: true, record })) {
        const current = readTrailingLockRecord(lockPath, runtime)
        if (!current || isTrailingLockStale(current, runtime)) continue
        return { acquired: false }
      }
    }
  }

  throw new Error('TokenBoard trailing lock could not be acquired after replacing stale lock')
}

function publishTrailingLock(lockPath, record, runtime) {
  if (typeof runtime.rename !== 'function') {
    throw new Error('TokenBoard trailing lock publication requires atomic rename')
  }

  const tempPath = trailingPublishPath(lockPath, runtime)
  try {
    runtime.writeFile(tempPath, JSON.stringify(record), { flag: 'wx', mode: 0o600 })
    runtime.rename(tempPath, lockPath)
  } catch (error) {
    try {
      runtime.unlink(tempPath)
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') {
        throw new Error(`${errorMessage(error)}; trailing lock publish cleanup failed: ${errorMessage(cleanupError)}`)
      }
    }
    throw error
  }
}

function isTrailingLockOwnedByCurrentProcess(lockPath, runtime) {
  return readTrailingLockRecord(lockPath, runtime)?.pid === runtime.process.pid
}

function releaseTrailingLock(lockPath, runtime, options = {}) {
  if (!lockPath) return false
  const record = options.record || readTrailingLockRecord(lockPath, runtime)
  if (!record) return false
  if (!options.force && record.pid !== runtime.process.pid) return false
  return removeTrailingLockRecord(lockPath, record.raw, runtime)
}

function isTrailingLockStale(record, runtime) {
  const pid = record?.pid ?? null
  if (pid === null) return true
  if (pid === runtime.process.pid) return false
  return probeProcessLiveness(pid, {
    platform: runtime.platform,
    nodeVersion: runtime.nodeVersion,
    kill: runtime.process.kill?.bind(runtime.process),
    runTasklist: runtime.runTasklist
  }) === 'dead'
}

function removeTrailingLockRecord(lockPath, expectedRaw, runtime) {
  if (typeof runtime.rename !== 'function' || typeof runtime.link !== 'function') {
    throw new Error('TokenBoard trailing lock cleanup requires atomic rename and link operations')
  }

  const quarantinePath = trailingQuarantinePath(lockPath, runtime)
  try {
    runtime.rename(lockPath, quarantinePath)
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }

  let quarantined
  try {
    quarantined = readTrailingLockRecord(quarantinePath, runtime)
  } catch (error) {
    restoreTrailingLockRecord(lockPath, quarantinePath, runtime)
    throw error
  }
  if (!quarantined || quarantined.raw !== expectedRaw) {
    restoreTrailingLockRecord(lockPath, quarantinePath, runtime)
    return false
  }
  try {
    runtime.unlink(quarantinePath)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    restoreTrailingLockRecord(lockPath, quarantinePath, runtime)
    throw error
  }
}

function restoreTrailingLockRecord(lockPath, quarantinePath, runtime) {
  try {
    runtime.link(quarantinePath, lockPath)
  } catch (error) {
    if (error.code !== 'EEXIST' && error.code !== 'ENOENT') throw error
  }
  try {
    runtime.unlink(quarantinePath)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

function readTrailingLockRecord(lockPath, runtime) {
  try {
    const raw = runtime.readFile(lockPath)
    return { raw, pid: readTrailingLockPid(raw) }
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function readTrailingLockPid(raw) {
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed.pid === 'number' ? parsed.pid : null
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
}

function trailingQuarantinePath(lockPath, runtime) {
  const now = typeof runtime.now === 'function' ? runtime.now() : Date.now()
  return `${lockPath}.release-${runtime.process.pid}-${now}-${Math.random().toString(36).slice(2)}`
}

function trailingPublishPath(lockPath, runtime) {
  const now = typeof runtime.now === 'function' ? runtime.now() : Date.now()
  return `${lockPath}.publish-${runtime.process.pid}-${now}-${Math.random().toString(36).slice(2)}`
}

export function claimDispatchLock(lockPath, token, options = {}) {
  if (!lockPath && !token) return true
  if (!lockPath || !token) return false
  const readFile = options.readFile || ((path) => readFileSync(path, 'utf8'))
  const writeFile = options.writeFile || writeFileSync
  const pid = options.pid || process.pid
  const now = options.now || Date.now
  const workerPath = dispatchWorkerPath(lockPath, options.workerPath)
  try {
    if (!hasDispatchLockToken(lockPath, token, readFile)) return false
    writeFile(workerPath, JSON.stringify({
      token,
      pid,
      startedAt: new Date(now()).toISOString()
    }), { encoding: 'utf8', mode: 0o600 })
    if (hasDispatchLockToken(lockPath, token, readFile)) return true
    removeDispatchWorker(workerPath, token, options)
    return false
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

export function releaseDispatchLock(lockPath, token, options = {}) {
  if (!lockPath || !token) return false
  const workerPath = dispatchWorkerPath(lockPath, options.workerPath)
  try {
    const released = releaseOwnedDispatchFile(lockPath, token, options)
    removeDispatchWorker(workerPath, token, options)
    return released
  } catch (error) {
    if (error.code === 'ENOENT') {
      removeDispatchWorker(workerPath, token, options)
      return false
    }
    throw error
  }
}

function dispatchWorkerPath(lockPath, workerPath) {
  return workerPath || `${lockPath}.worker`
}

function hasDispatchLockToken(lockPath, token, readFile) {
  try {
    const current = JSON.parse(readFile(lockPath))
    return Boolean(current && current.token === token)
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

function removeDispatchWorker(workerPath, token, options) {
  return releaseOwnedDispatchFile(workerPath, token, options)
}

function releaseOwnedDispatchFile(path, token, options) {
  const readFile = options.readFile || ((filePath) => readFileSync(filePath, 'utf8'))
  const rename = options.rename || renameSync
  const link = options.link || linkSync
  const unlink = options.unlink || unlinkSync
  const quarantinePath = dispatchQuarantinePath(path)
  try {
    rename(path, quarantinePath)
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }

  let owned
  try {
    owned = hasDispatchLockToken(quarantinePath, token, readFile)
  } catch (error) {
    restoreDispatchFile(path, quarantinePath, { link, unlink })
    throw error
  }
  if (!owned) {
    restoreDispatchFile(path, quarantinePath, { link, unlink })
    return false
  }
  try {
    unlink(quarantinePath)
    return true
  } catch (error) {
    restoreDispatchFile(path, quarantinePath, { link, unlink })
    throw error
  }
}

function restoreDispatchFile(path, quarantinePath, { link, unlink }) {
  try {
    link(quarantinePath, path)
  } catch (error) {
    if (error.code !== 'EEXIST' && error.code !== 'ENOENT') throw error
  }
  try {
    unlink(quarantinePath)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

function dispatchQuarantinePath(path) {
  return `${path}.release-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await runNotifyCli()
}
