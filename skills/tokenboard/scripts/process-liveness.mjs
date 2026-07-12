import { spawnSync } from 'node:child_process'

const tasklistTimeoutMs = 2_000

export function isProcessAlive(pid, options = {}) {
  const platform = options.platform || process.platform
  const nodeVersion = options.nodeVersion || process.versions.node
  if (platform === 'win32' && !supportsReliableSignalZero(platform, nodeVersion)) {
    const runTasklist = options.runTasklist || spawnSync
    return isWindowsProcessAlive(pid, runTasklist)
  }
  const kill = options.kill || process.kill.bind(process)
  try {
    kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
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

function isWindowsProcessAlive(pid, runTasklist) {
  const result = runTasklist('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: tasklistTimeoutMs
  })
  if (result.error || result.status !== 0) return true
  return tasklistContainsPid(result.stdout, pid)
}
