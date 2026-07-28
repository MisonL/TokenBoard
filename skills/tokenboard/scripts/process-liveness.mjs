import { spawnSync } from 'node:child_process'
import { win32 as windowsPath } from 'node:path'

const tasklistTimeoutMs = 2_000

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
