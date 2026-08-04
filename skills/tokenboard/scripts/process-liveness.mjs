import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { win32 as windowsPath } from 'node:path'

const tasklistTimeoutMs = 2_000
const processIdentityTimeoutMs = 2_000

export function isProcessAlive(pid, options = {}) {
  return probeProcessLiveness(pid, options) !== 'dead'
}

export function probeProcessLiveness(pid, options = {}) {
  const platform = options.platform || process.platform
  const nodeVersion = options.nodeVersion || process.versions.node
  if (platform === 'win32' && !supportsReliableSignalZero(platform, nodeVersion)) {
    const runTasklist = options.runTasklist || spawnSync
    return isWindowsProcessAlive(pid, runTasklist, options.env)
  }
  const kill = options.kill || process.kill.bind(process)
  try {
    kill(pid, 0)
    return 'alive'
  } catch (error) {
    if (error?.code === 'EPERM') return 'alive'
    return 'dead'
  }
}

export function supportsReliableSignalZero(platform, nodeVersion) {
  if (platform !== 'win32') return true
  const [major, minor] = nodeVersion.split('.').map(Number)
  return major > 23 || (major === 22 && minor >= 16)
}

export function currentProcessStartIdentity(options = {}) {
  const pid = options.pid ?? process.pid
  const identity = probeProcessStartIdentity(pid, options)
  return identity.status === 'known' ? identity.value : undefined
}

export function probeProcessStartIdentity(pid, options = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { status: 'dead' }
  if (typeof options.readProcessStartIdentity === 'function') {
    try {
      return normalizeProcessStartIdentity(options.readProcessStartIdentity(pid))
    } catch (error) {
      return error?.code === 'ENOENT' ? { status: 'dead' } : { status: 'unknown' }
    }
  }

  const platform = options.platform || process.platform
  if (platform === 'linux') return readLinuxProcessStartIdentity(pid, options)
  if (platform === 'win32') return readWindowsProcessStartIdentity(pid, options)
  return readPsProcessStartIdentity(pid, options)
}

export function tasklistContainsPid(output, pid) {
  return output.split(/\r?\n/).some((line) => {
    const match = line.match(/^"[^"]+","(\d+)"(?:,|$)/)
    return match?.[1] === String(pid)
  })
}

export function tasklistCommand(env = process.env) {
  const systemRoot = typeof env.SystemRoot === 'string' ? env.SystemRoot.trim() : ''
  const root = windowsPath.isAbsolute(systemRoot)
    ? systemRoot
    : 'C:\\Windows'
  return windowsPath.join(root, 'System32', 'tasklist.exe')
}

function isWindowsProcessAlive(pid, runTasklist, env) {
  const result = runTasklist(tasklistCommand(env), ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: tasklistTimeoutMs
  })
  if (result.error || result.status !== 0) return 'unknown'
  return tasklistContainsPid(result.stdout, pid) ? 'alive' : 'dead'
}

function normalizeProcessStartIdentity(value) {
  if (value && typeof value === 'object' &&
    (value.status === 'known' || value.status === 'dead' || value.status === 'unknown')) {
    if (value.status !== 'known') return { status: value.status }
    return typeof value.value === 'string' && value.value ? { status: 'known', value: value.value } : { status: 'unknown' }
  }
  if (typeof value === 'string' && value) return { status: 'known', value }
  return { status: 'unknown' }
}

function readLinuxProcessStartIdentity(pid, options = {}) {
  const readFile = options.readFile || readFileSync
  let raw
  try {
    raw = readFile(`/proc/${pid}/stat`, 'utf8')
  } catch (error) {
    return error?.code === 'ENOENT' ? { status: 'dead' } : { status: 'unknown' }
  }
  const commandEnd = raw.lastIndexOf(')')
  if (commandEnd < 0) return { status: 'unknown' }
  const fields = raw.slice(commandEnd + 1).trim().split(/\s+/)
  const startTicks = fields[19]
  if (!/^\d+$/.test(startTicks || '')) return { status: 'unknown' }

  let bootId
  try {
    const value = readFile('/proc/sys/kernel/random/boot_id', 'utf8')
    if (typeof value !== 'string') return { status: 'unknown' }
    bootId = value.trim()
  } catch {
    return { status: 'unknown' }
  }
  if (!bootId || bootId.length > 256 || /\s/.test(bootId)) return { status: 'unknown' }
  return { status: 'known', value: `linux:${bootId}:${startTicks}` }
}

function readPsProcessStartIdentity(pid, options) {
  const result = (options.runProcessIdentity || spawnSync)('ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8',
    timeout: processIdentityTimeoutMs,
    env: { ...process.env, LC_ALL: 'C' }
  })
  if (result.error) return { status: 'unknown' }
  const output = String(result.stdout || '').trim()
  if (!output) return result.status === 1 ? { status: 'dead' } : { status: 'unknown' }
  const startedAt = Date.parse(output)
  return Number.isFinite(startedAt)
    ? { status: 'known', value: `ps:${startedAt}` }
    : { status: 'unknown' }
}

function readWindowsProcessStartIdentity(pid, options) {
  const command = `$process = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($null -eq $process) { exit 3 }; [Console]::Out.Write($process.StartTime.ToUniversalTime().Ticks)`
  const result = (options.runProcessIdentity || spawnSync)('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    command
  ], {
    encoding: 'utf8',
    timeout: processIdentityTimeoutMs,
    windowsHide: true
  })
  if (result.error) return { status: 'unknown' }
  if (result.status === 3) return { status: 'dead' }
  if (result.status !== 0) return { status: 'unknown' }
  const ticks = String(result.stdout || '').trim()
  return /^\d+$/.test(ticks) ? { status: 'known', value: `windows:${ticks}` } : { status: 'unknown' }
}
