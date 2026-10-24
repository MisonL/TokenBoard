import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { win32 as windowsPath } from 'node:path'

const tasklistTimeoutMs = 2_000
const processIdentityTimeoutMs = 2_000
const darwinProcessInfoSize = 136
const darwinStartSecondsOffset = 120
const darwinStartMicrosecondsOffset = 128

export type CursorProcessLiveness = 'alive' | 'dead' | 'unknown'
export type CursorProcessStartIdentity = { status: 'known'; value: string } | { status: 'dead' | 'unknown' }

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

export function probeCursorProcessLiveness(
  pid: number,
  options: {
    platform?: string
    nodeVersion?: string
    kill?: (pid: number, signal: 0) => unknown
    runTasklist?: RunTasklist
    env?: Partial<NodeJS.ProcessEnv>
  } = {}
): CursorProcessLiveness {
  const platform = options.platform ?? process.platform
  const nodeVersion = options.nodeVersion ?? process.versions.node
  if (platform === 'win32' && !supportsReliableCursorSignalZero(platform, nodeVersion)) {
    return probeWindowsProcess(pid, options.runTasklist ?? spawnSync, options.env)
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

export function probeCursorProcessStartIdentity(
  pid: number,
  options: {
    platform?: string
    nodeVersion?: string
    readFile?: (path: string, encoding: 'utf8') => string
    runProcessIdentity?: typeof spawnSync
    kill?: (pid: number, signal: 0) => unknown
    env?: Partial<NodeJS.ProcessEnv>
  } = {}
): CursorProcessStartIdentity {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { status: 'dead' }
  const platform = options.platform ?? process.platform
  if (platform === 'linux') return readLinuxProcessStartIdentity(pid, options)
  if (platform === 'win32') return readWindowsProcessStartIdentity(pid, options)
  if (platform === 'darwin') return readDarwinProcessStartIdentity(pid, options)
  return { status: 'unknown' }
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

export function cursorTasklistCommand(env: Partial<NodeJS.ProcessEnv> = process.env) {
  const systemRoot = typeof env.SystemRoot === 'string' ? env.SystemRoot.trim() : ''
  const root = windowsPath.isAbsolute(systemRoot) ? systemRoot : 'C:\\Windows'
  return windowsPath.join(root, 'System32', 'tasklist.exe')
}

function probeWindowsProcess(
  pid: number,
  runTasklist: RunTasklist,
  env: Partial<NodeJS.ProcessEnv> | undefined
): CursorProcessLiveness {
  const result = runTasklist(cursorTasklistCommand(env), ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: tasklistTimeoutMs
  })
  if (result.error || result.status !== 0) return 'unknown'
  const stdout = typeof result.stdout === 'string' ? result.stdout : (result.stdout?.toString('utf8') ?? '')
  return tasklistContainsCursorPid(stdout, pid) ? 'alive' : 'dead'
}

function readLinuxProcessStartIdentity(
  pid: number,
  options: { readFile?: (path: string, encoding: 'utf8') => string }
): CursorProcessStartIdentity {
  const readFile = options.readFile ?? readFileSync
  let raw: string
  try {
    raw = readFile(`/proc/${pid}/stat`, 'utf8')
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
      ? { status: 'dead' }
      : { status: 'unknown' }
  }
  const commandEnd = raw.lastIndexOf(')')
  if (commandEnd < 0) return { status: 'unknown' }
  const fields = raw
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/)
  const startTicks = fields[19]
  if (!/^\d+$/.test(startTicks ?? '')) return { status: 'unknown' }

  let bootId: string
  try {
    bootId = readFile('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  } catch {
    return { status: 'unknown' }
  }
  if (!bootId || bootId.length > 256 || /\s/.test(bootId)) return { status: 'unknown' }
  return { status: 'known', value: `linux:${bootId}:${startTicks}` }
}

function readDarwinProcessStartIdentity(
  pid: number,
  options: { runProcessIdentity?: typeof spawnSync; kill?: (pid: number, signal: 0) => unknown }
): CursorProcessStartIdentity {
  const runProcessIdentity = options.runProcessIdentity ?? spawnSync
  const result = runProcessIdentity(
    '/usr/bin/osascript',
    ['-l', 'JavaScript', '-e', darwinProcessIdentityScript(pid)],
    {
      encoding: 'utf8',
      timeout: processIdentityTimeoutMs,
      killSignal: 'SIGKILL'
    }
  )
  if (result.error || result.status == null) return { status: 'unknown' }
  if (result.status !== 0) {
    const kill = options.kill ?? process.kill.bind(process)
    try {
      kill(pid, 0)
      return { status: 'unknown' }
    } catch (error) {
      return error instanceof Error && 'code' in error && error.code === 'ESRCH'
        ? { status: 'dead' }
        : { status: 'unknown' }
    }
  }

  const encoded = String(result.stdout ?? '').trim()
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) return { status: 'unknown' }
  try {
    const bytes = Buffer.from(encoded, 'base64')
    if (bytes.length !== darwinProcessInfoSize) return { status: 'unknown' }
    const seconds = bytes.readBigUInt64LE(darwinStartSecondsOffset)
    const microseconds = bytes.readBigUInt64LE(darwinStartMicrosecondsOffset)
    if (seconds <= 0n || microseconds >= 1_000_000n) return { status: 'unknown' }
    return { status: 'known', value: `darwin:${seconds}:${microseconds}` }
  } catch {
    return { status: 'unknown' }
  }
}

function readWindowsProcessStartIdentity(
  pid: number,
  options: { runProcessIdentity?: typeof spawnSync; env?: Partial<NodeJS.ProcessEnv> }
): CursorProcessStartIdentity {
  const runProcessIdentity = options.runProcessIdentity ?? spawnSync
  const command = `try { $process = Get-Process -Id ${pid} -ErrorAction Stop; [Console]::Out.Write($process.StartTime.ToUniversalTime().Ticks) } catch { if ($_.CategoryInfo.Category -eq 'ObjectNotFound' -or $_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId*') { exit 3 }; exit 4 }`
  const result = runProcessIdentity(
    windowsPowerShellCommand(options.env),
    ['-NoProfile', '-NonInteractive', '-Command', command],
    {
      encoding: 'utf8',
      timeout: processIdentityTimeoutMs,
      killSignal: 'SIGKILL',
      windowsHide: true
    }
  )
  if (result.error) return { status: 'unknown' }
  if (result.status === 3) return { status: 'dead' }
  if (result.status !== 0) return { status: 'unknown' }
  const ticks = String(result.stdout ?? '').trim()
  return /^\d+$/.test(ticks) ? { status: 'known', value: `windows:${ticks}` } : { status: 'unknown' }
}

function windowsPowerShellCommand(env: Partial<NodeJS.ProcessEnv> = process.env) {
  const systemRoot = typeof env.SystemRoot === 'string' ? env.SystemRoot.trim() : ''
  const root = windowsPath.isAbsolute(systemRoot) ? systemRoot : 'C:\\Windows'
  return windowsPath.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function darwinProcessIdentityScript(pid: number) {
  return `ObjC.import("Foundation"); const procPidInfoTypes = ["int", ["int", "int", "unsigned long", "pointer", "int"]]; try { ObjC.bindFunction("proc_pidinfo", procPidInfoTypes); } catch (_) { ObjC.bindFunction("proc_pidinfo", procPidInfoTypes, "/usr/lib/libproc.dylib"); } const data = $.NSMutableData.dataWithLength(${darwinProcessInfoSize}); const size = $.proc_pidinfo(${pid}, 3, 0, data.mutableBytes, ${darwinProcessInfoSize}); if (size !== ${darwinProcessInfoSize}) { throw new Error("proc_pidinfo unavailable") }; ObjC.unwrap(data.base64EncodedStringWithOptions(0));`
}
