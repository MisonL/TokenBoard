import { spawnSync } from 'node:child_process'

const tasklistTimeoutMs = 2_000

export type CursorProcessLiveness = 'alive' | 'dead' | 'unknown'

type TasklistResult = {
  error?: unknown
  status: number | null
  stdout?: string | Buffer
}

type RunTasklist = (
  command: string,
  args: string[],
  options: { encoding: 'utf8'; windowsHide: true; timeout: number }
) => TasklistResult

export function probeCursorProcessLiveness(pid: number, options: {
  platform?: string
  nodeVersion?: string
  kill?: (pid: number, signal: 0) => unknown
  runTasklist?: RunTasklist
} = {}): CursorProcessLiveness {
  const platform = options.platform ?? process.platform
  const nodeVersion = options.nodeVersion ?? process.versions.node
  if (platform === 'win32' && !supportsReliableCursorSignalZero(platform, nodeVersion)) {
    return probeWindowsProcess(pid, options.runTasklist ?? spawnSync)
  }
  const kill = options.kill ?? process.kill.bind(process)
  try {
    kill(pid, 0)
    return 'alive'
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      if (error.code === 'EPERM') return 'alive'
      if (error.code === 'ESRCH') return 'dead'
    }
    return 'unknown'
  }
}

export function supportsReliableCursorSignalZero(platform: string, nodeVersion: string) {
  if (platform !== 'win32') return true
  const [major, minor] = nodeVersion.split('.').map(Number)
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false
  return major > 23 || (major === 22 && minor >= 16)
}

export function tasklistContainsCursorPid(output: string, pid: number) {
  return output.split(/\r?\n/).some((line) => {
    const match = line.match(/^"[^"]+","(\d+)"(?:,|$)/)
    return match?.[1] === String(pid)
  })
}

function probeWindowsProcess(pid: number, runTasklist: RunTasklist): CursorProcessLiveness {
  const result = runTasklist('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: tasklistTimeoutMs
  })
  if (result.error || result.status !== 0) return 'unknown'
  const stdout = typeof result.stdout === 'string' ? result.stdout : result.stdout?.toString('utf8') ?? ''
  return tasklistContainsCursorPid(stdout, pid) ? 'alive' : 'dead'
}
