#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import {
  chmodSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { isMainModule } from './is-main.mjs'
import { readConfig, parseArgs, collectorDir, readPackageManager } from './config.mjs'
import { printHelpIfRequested } from './cli-help.mjs'
import { normalizePathEnv } from './schedule.mjs'
import { readSince } from './sync-options.mjs'
import { closeScheduledLogRuntime, createScheduledLogRuntime } from './logs.mjs'
import { runUpgrade } from './upgrade.mjs'
import { errorMessage } from './error-message.mjs'
import { acquireLock, lockHasToken, releaseLock, waitForLock } from './coordinator-lock.mjs'
import { runScheduledRetry, transientSyncExitCode } from './scheduled-retry.mjs'
import { currentProcessStartIdentity } from './process-liveness.mjs'
import { writeScheduledSyncState } from './scheduled-sync-state.mjs'
import { redactUrlCredentials } from './redact-credentials.mjs'

const defaultSyncLockTimeoutMs = 60_000

// Hook-mode runs get a wall-clock bound so a wedged scan cannot hold the sync lock or the
// notify caller indefinitely. The default leaves generous room above the observed long tail
// (a full Codex history scan measured at ~25 minutes on a 38 GB session tree); a shorter
// value trades a lost hook cycle for faster failure visibility. Manual and scheduled runs
// are never bounded.
const defaultHookSyncTimeoutMs = 30 * 60 * 1000

export function readHookSyncTimeoutMs(env = process.env) {
  const configured = env.TOKENBOARD_HOOK_SYNC_TIMEOUT_MS
  if (configured === undefined || configured === '') return defaultHookSyncTimeoutMs
  if (!/^[1-9][0-9]*$/.test(configured)) {
    throw new Error('TOKENBOARD_HOOK_SYNC_TIMEOUT_MS must be a positive integer number of milliseconds')
  }
  return Number(configured)
}

if (isMain()) {
  runCli()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`TokenBoard sync failed: ${redactUrlCredentials(errorMessage(error))}`)
      process.exit(1)
    })
}

async function runCli() {
  if (
    printHelpIfRequested(
      process.argv.slice(2),
      'Usage: sync.mjs [--mode preview|sync] [--source SOURCE] [--until YYYY-MM-DD] [--scheduled] [--hook] [--skip-upgrade]'
    )
  ) {
    return 0
  }
  let logs
  try {
    const flags = parseArgs(process.argv.slice(2))
    const config = readConfig()
    const homeDir = homedir()
    const invocation = buildSyncInvocation({
      flags,
      config,
      pathEnv: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      homeDir,
      nodePath: process.execPath,
      platform: process.platform
    })
    logs = createScheduledLogRuntime({
      env: process.env,
      homeDir,
      scheduled: flags.scheduled === true
    })

    return await runSyncInvocation({
      flags,
      invocation,
      logs,
      stateDir: configDirFromInvocation(invocation, homeDir)
    })
  } catch (error) {
    console.error(`TokenBoard sync failed: ${redactUrlCredentials(errorMessage(error))}`)
    return 1
  } finally {
    closeScheduledLogRuntime(logs)
  }
}

export async function runSyncInvocation({
  flags = {},
  invocation,
  logs,
  stateDir,
  runWithLock = runWithSyncLock,
  runRetry = runScheduledRetry,
  writeState = writeScheduledSyncState,
  onStateError = (message) => console.error(message),
  now = Date.now
}) {
  const scheduled = flags.scheduled === true
  const source = invocation?.source || flags.source || 'all'
  const startedAt = new Date(now()).toISOString()
  const recordState = (status, details = {}) => {
    if (!scheduled) return
    try {
      writeState({
        stateDir,
        source,
        status,
        startedAt,
        updatedAt: now(),
        ...(status === 'running' ? {} : { completedAt: now() }),
        ...(Number.isSafeInteger(details.exitCode) ? { exitCode: recordableExitCode(details.exitCode) } : {}),
        ...(details.error ? { error: errorMessage(details.error) } : {})
      })
    } catch (error) {
      try {
        onStateError(`TokenBoard scheduled sync state update failed: ${errorMessage(error)}`)
      } catch {
        // State reporting must never alter the sync result or mask its primary error.
      }
    }
  }
  const run = async (runFlags = flags) =>
    runWithLock({
      flags: runFlags,
      stateDir,
      run: () => runSync({ flags: runFlags, invocation, logs })
    })

  let deferredBy
  try {
    recordState('running')
    const result = await run()
    const exitCode = typeof result === 'number' ? result : 0
    if (exitCode === transientSyncExitCode) {
      if (!canDeferScheduledRun(flags)) {
        // Nothing retries an unscheduled run, so report a plain failure instead
        // of surfacing an internal deferral code the caller cannot act on.
        recordState('failed', { exitCode: 1 })
        return 1
      }
      deferredBy = new Error(`collector exited with transient code ${exitCode}`)
    } else {
      recordState(exitCode === 0 ? 'success' : 'failed', { exitCode })
      return result
    }
  } catch (error) {
    if (!shouldDeferScheduledSync(flags, error)) {
      recordState('failed', { exitCode: 1, error })
      throw error
    }
    deferredBy = error
  }

  // No exitCode here. `transientSyncExitCode` is an internal contract between the
  // collector and the retry loop; the state file is user-visible through
  // `status.mjs`, and the non-scheduled branch above already normalizes the same code
  // to 1 precisely so it is not surfaced. A `deferred` row means "retrying", which the
  // status field already says, so recording the number would only leak an internal
  // code the reader cannot act on.
  recordState('deferred', { error: deferredBy })
  const retryFlags = { ...flags, 'skip-upgrade': true }
  let result
  try {
    result = await runRetry({
      stateDir,
      source,
      runAttempt: () => run(retryFlags)
    })
  } catch (retryError) {
    recordState('failed', { exitCode: 1, error: retryError })
    throw retryError
  }
  if (result.skipped) {
    console.error('TokenBoard scheduled sync deferred because another scheduled retry is active.')
  } else if (result.exhausted) {
    console.error(`TokenBoard scheduled sync retry exhausted after ${result.attempts} attempts.`)
  }
  const exitCode = Number.isSafeInteger(result.exitCode) ? result.exitCode : 1
  // `skipped` means another scheduled retry already holds the lock: this run handed the
  // work off, which is the `deferred` state, not a failure. The old order tested
  // `exitCode !== 0` first, and a skip reports no exit code at all, so the fallback 1
  // made every handoff look like a failure — contradicting both the message printed just
  // above and the `deferred` row the retry loop itself had written. A skip has no exit
  // code to report, so none is recorded.
  const skipped = result.skipped === true
  const status = skipped ? 'deferred' : result.exhausted || exitCode !== 0 ? 'failed' : 'success'
  recordState(status, {
    ...(skipped ? {} : { exitCode }),
    ...(result.error ? { error: result.error } : {})
  })
  return exitCode
}

async function runSync({ flags, invocation, logs }) {
  if (shouldRunUpgrade({ flags, env: process.env })) {
    try {
      runUpgrade({
        flags,
        automatic: true,
        log: createUpgradeLogger(logs)
      })
    } catch (error) {
      console.error(`TokenBoard upgrade skipped: ${redactUrlCredentials(errorMessage(error))}`)
    }
  }

  const effectiveInvocation = refreshBundledCcusageConfig(invocation)

  if (!existsSync(effectiveInvocation.repoDir)) {
    console.error(`TokenBoard collector is not installed: ${effectiveInvocation.repoDir}`)
    console.error('Run setup.mjs again or run install-collector.mjs.')
    return 1
  }

  const hookTimeoutMs = flags.hook === true ? readHookSyncTimeoutMs() : undefined
  const result = await runCollectorProcess(effectiveInvocation, logs, { hookTimeoutMs })

  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') {
      console.error(`TokenBoard hook sync timed out after ${hookTimeoutMs} ms; the collector process was killed`)
    } else {
      console.error(`Failed to run ${effectiveInvocation.command}: ${errorMessage(result.error)}`)
    }
    return 1
  }

  return result.status ?? 1
}

// The collector's own stdout/stderr must reach the scheduled log through the same credential
// redaction the parent's log lines go through. Inheriting the log fds (`stdio: [...fd]`) writes
// the child's output straight into a file that outlives the terminal — a provider or `ccusage`
// error echoing `tb_upload_…` or `https://user:token@host/…` would land there intact. Capture
// instead and forward each line through `redactUrlCredentials`, the way `upgrade-utils` already
// does for the git steps. The child still inherits the real terminal when there is no log file,
// so interactive runs keep their live output.
//
// Output streams line by line instead of accumulating in a 64 MiB buffer: a run killed
// mid-flight keeps everything it already printed, memory stays flat regardless of run length,
// and per-line redaction is equivalent because every redact rule is single-line anchored.
export async function runCollectorProcess(invocation, logs, options = {}) {
  const spawnChild = options.spawn || spawn
  const write = options.write || writeSync
  if (!logs) {
    return spawnChild(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      stdio: 'inherit',
      shell: invocation.shell
    })
  }

  const child = spawnChild(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: invocation.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: invocation.shell
  })
  const stdoutPipe = pipeRedacted(child.stdout, logs.stdoutFd, write)
  const stderrPipe = pipeRedacted(child.stderr, logs.stderrFd, write)
  let timedOut = false
  let timer
  if (options.hookTimeoutMs) {
    // Only hook-mode callers pass a bound; manual and scheduled runs are never killed.
    timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.hookTimeoutMs)
  }

  const outcome = await new Promise((resolve) => {
    child.once('error', (error) => resolve({ error }))
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  clearTimeout(timer)
  await drainPipes([stdoutPipe, stderrPipe], options.streamDrainTimeoutMs)

  if (outcome.error) return { status: 1, error: outcome.error, stdout: '', stderr: '' }
  if (timedOut) {
    return {
      status: 1,
      error: Object.assign(new Error(`collector run exceeded the ${options.hookTimeoutMs} ms hook timeout`), {
        code: 'ETIMEDOUT'
      }),
      stdout: '',
      stderr: ''
    }
  }
  return { status: outcome.code ?? (outcome.signal ? 1 : 0), stdout: '', stderr: '' }
}

function pipeRedacted(stream, fd, write) {
  const pipe = new Promise((resolve) => {
    if (!stream) {
      resolve()
      return
    }
    stream.setEncoding('utf8')
    createInterface({ input: stream }).on('line', (line) => writeRedactedOutput(fd, line, write))
    stream.once('end', resolve)
    stream.once('error', resolve)
  })
  pipe.stream = stream
  return pipe
}

// After the child exits, the stdio pipes stay open as long as any orphaned grandchild
// (ccusage, tsx) that inherited them is still running: the 'end' events never fire and the
// run would hang forever on a process that is already gone. The logs already hold everything
// the child printed, so once the drain grace elapses the parent destroys whichever pipes have
// not settled; their 'error'/'end' handlers in pipeRedacted then resolve the promises. A
// destroy call on its own proves nothing (readline also destroys the stream on natural
// 'end'), which is why the guard watches the pipe promises, not the stream events.
function drainPipes(pipes, streamDrainTimeoutMs) {
  const graceMs = streamDrainTimeoutMs ?? 5_000
  return new Promise((resolve) => {
    let done = false
    const settle = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      for (const pipe of pipes) pipe.stream?.destroy?.()
      settle()
    }, graceMs)
    Promise.all(pipes).then(settle, settle)
  })
}

export function writeRedactedOutput(fd, text, write = writeSync) {
  const output = String(text ?? '')
  if (!output) return
  // A diagnostic sink must never change the sync result, so a failed write is swallowed.
  try {
    write(fd, redactUrlCredentials(output.endsWith('\n') ? output.slice(0, -1) : output) + '\n')
  } catch {
    // ignore
  }
}

export function createUpgradeLogger(logs, { write = writeSync, log = console.log } = {}) {
  return (line) => {
    const message = redactUrlCredentials(String(line))
    if (!logs) {
      log(message)
      return
    }
    try {
      write(logs.stdoutFd, `${message}\n`)
    } catch {
      // A diagnostic sink must never change the upgrade or sync result.
    }
  }
}

// The scheduled log is private (0700 directory, 0600 files), but an upgrade line can embed the
// configured repository URL — `https://user:token@host/…` — and the log outlives the terminal
// it used to print to. Redaction lives in its own module (`redact-credentials.mjs`) so this log
// path and the upgrade helpers that spawn the git steps scrub the same credentials the same way.

export function refreshBundledCcusageConfig(invocation, fileExists = existsSync) {
  if (invocation.env?.TOKENBOARD_CCUSAGE_CONFIG?.trim()) return invocation

  const bundledCcusageConfig = join(invocation.repoDir, 'packages', 'collector', 'ccusage.json')
  if (!fileExists(bundledCcusageConfig)) return invocation

  return {
    ...invocation,
    env: {
      ...invocation.env,
      TOKENBOARD_CCUSAGE_CONFIG: bundledCcusageConfig
    }
  }
}

export function shouldRunUpgrade({ flags = {}, env = process.env } = {}) {
  if (flags.hook === true) {
    return false
  }
  if (flags['skip-upgrade'] === true) {
    return false
  }
  if (env.TOKENBOARD_SKIP_UPGRADE === '1') {
    return false
  }
  if (env.TOKENBOARD_AUTO_UPGRADE === '0') {
    return false
  }
  return true
}

export function buildSyncInvocation({
  flags = {},
  config,
  env = process.env,
  pathEnv = env.PATH || '/usr/local/bin:/usr/bin:/bin',
  homeDir = homedir(),
  nodePath = process.execPath,
  platform = process.platform,
  fileExists = existsSync
}) {
  const mode = flags.mode || 'sync'
  const source = flags.source || config.source || 'all'
  const repoDir = config.collectorDir || collectorDir()
  const packageManager = readPackageManager(flags, config)
  const since = readSince({ flags, config, env })
  const delimiter = platform === 'win32' ? ';' : ':'
  const {
    TOKENBOARD_COORDINATOR_LOCK_HELD: _coordinatorLockHeld,
    TOKENBOARD_COORDINATOR_LOCK_TOKEN: _coordinatorLockToken,
    ...collectorEnv
  } = env
  const bundledCcusageConfig = join(repoDir, 'packages', 'collector', 'ccusage.json')
  const ccusageConfig = collectorEnv.TOKENBOARD_CCUSAGE_CONFIG?.trim()
    ? undefined
    : fileExists(bundledCcusageConfig)
      ? bundledCcusageConfig
      : undefined
  const until = normalizeUntilFlag(flags.until)
  const codexSymlinkRoots =
    Array.isArray(config.codexSymlinkRoots) && config.codexSymlinkRoots.length > 0
      ? Object.prototype.hasOwnProperty.call(collectorEnv, 'TOKENBOARD_CODEX_SYMLINK_ROOTS_JSON')
        ? undefined
        : JSON.stringify(config.codexSymlinkRoots)
      : undefined
  const untilArgs = until === undefined ? [] : ['--until', until]
  return {
    command: nodePath,
    args: ['--import', 'tsx', 'src/cli.ts', mode, '--source', source, ...untilArgs],
    source,
    cwd: join(repoDir, 'packages', 'collector'),
    repoDir,
    shell: false,
    env: {
      ...collectorEnv,
      PATH: normalizePathEnv({
        pathEnv,
        homeDir,
        nodePath,
        delimiter
      }),
      TOKENBOARD_ENDPOINT: config.endpoint,
      TOKENBOARD_UPLOAD_TOKEN: config.uploadToken,
      TOKENBOARD_TIMEZONE: config.timezone,
      TOKENBOARD_SOURCE: source,
      TOKENBOARD_PACKAGE_MANAGER: packageManager,
      ...(ccusageConfig ? { TOKENBOARD_CCUSAGE_CONFIG: ccusageConfig } : {}),
      ...(codexSymlinkRoots ? { TOKENBOARD_CODEX_SYMLINK_ROOTS_JSON: codexSymlinkRoots } : {}),
      ...(until !== undefined ? { TOKENBOARD_UNTIL: until } : {}),
      TOKENBOARD_SINCE: since,
      TOKENBOARD_DEFAULT_SINCE: since,
      ...(flags.scheduled === true &&
      !Object.prototype.hasOwnProperty.call(collectorEnv, 'TOKENBOARD_FAIL_ON_SOURCE_ERROR')
        ? {
            TOKENBOARD_FAIL_ON_SOURCE_ERROR: '1'
          }
        : {}),
      ...(flags.hook === true
        ? {
            TOKENBOARD_HOOK_MODE: '1',
            TOKENBOARD_STATE_DIR: env.TOKENBOARD_STATE_DIR || env.TOKENBOARD_CONFIG_DIR || join(homeDir, '.tokenboard')
          }
        : {})
    }
  }
}

function normalizeUntilFlag(value) {
  if (value === undefined) return undefined
  if (typeof value === 'boolean') throw new Error('--until requires a date value')
  const normalized = String(value).trim()
  if (!normalized) throw new Error('--until requires a date value')
  return normalized
}

export async function runWithSyncLock({ flags = {}, env = process.env, stateDir, runtime = syncLockRuntime(), run }) {
  if (typeof run !== 'function') {
    throw new Error('runWithSyncLock requires run')
  }
  if (typeof stateDir !== 'string' || !stateDir.trim()) {
    throw new Error('runWithSyncLock requires stateDir')
  }
  ensurePrivateStateDir(runtime, stateDir)
  const lockPath = join(stateDir, 'sync.lock')
  if (isCoordinatorLockHeld({ flags, env, lockPath, runtime })) {
    return run()
  }

  let owner = acquireLock(lockPath, runtime)
  if (!owner) {
    const wait = waitForLock(lockPath, runtime)
    if (!wait.acquired) {
      throw syncLockTimeoutError(lockPath)
    }
    owner = wait.owner
  }
  let result
  let primaryError
  let primaryFailed = false
  try {
    result = await run()
  } catch (error) {
    primaryFailed = true
    primaryError = error
  }

  let releaseError
  try {
    const released = releaseLock(lockPath, runtime, owner)
    if (!released && lockHasToken(lockPath, owner.token, runtime)) {
      releaseError = new Error(`TokenBoard sync lock release was not confirmed: ${lockPath}`)
    }
  } catch (error) {
    releaseError = new Error(`TokenBoard sync lock release failed: ${errorMessage(error)}`, { cause: error })
  }

  if (primaryFailed && releaseError) {
    const combined = new AggregateError(
      [primaryError, releaseError],
      `${errorMessage(primaryError)}; ${errorMessage(releaseError)}`
    )
    if (primaryError && typeof primaryError === 'object' && 'code' in primaryError) {
      combined.code = primaryError.code
    }
    throw combined
  }
  if (primaryFailed) throw primaryError
  if (releaseError) throw releaseError
  return result
}

export { transientSyncExitCode }

function canDeferScheduledRun(flags) {
  return flags.scheduled === true && flags.hook !== true && (flags.mode || 'sync') === 'sync'
}

function shouldDeferScheduledSync(flags, error) {
  return canDeferScheduledRun(flags) && error?.code === 'TOKENBOARD_SYNC_LOCK_TIMEOUT'
}

function syncLockTimeoutError(lockPath) {
  const error = new Error(`Timed out waiting for TokenBoard sync lock: ${lockPath}`)
  error.code = 'TOKENBOARD_SYNC_LOCK_TIMEOUT'
  return error
}

function ensurePrivateStateDir(runtime, stateDir) {
  if (typeof runtime.mkdir !== 'function' || typeof runtime.chmod !== 'function') {
    throw new Error('TokenBoard sync state directory setup requires mkdir and chmod operations')
  }
  const inspect = typeof runtime.lstat === 'function' ? () => runtime.lstat(stateDir) : null
  const before = inspectDirectory(inspect)
  if (before?.isSymbolicLink?.()) {
    throw new Error(`TokenBoard sync state directory must not be a symbolic link: ${stateDir}`)
  }

  runtime.mkdir(stateDir, { recursive: true, mode: 0o700 })

  const after = inspectDirectory(inspect)
  if (after?.isSymbolicLink?.()) {
    throw new Error(`TokenBoard sync state directory must not be a symbolic link: ${stateDir}`)
  }
  if (after && typeof after.isDirectory === 'function' && !after.isDirectory()) {
    throw new Error(`TokenBoard sync state path is not a directory: ${stateDir}`)
  }
  runtime.chmod(stateDir, 0o700)
}

function inspectDirectory(inspect) {
  if (!inspect) return null
  try {
    return inspect()
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function isCoordinatorLockHeld({ flags, env, lockPath, runtime }) {
  return (
    flags.hook === true &&
    env.TOKENBOARD_COORDINATOR_LOCK_HELD === '1' &&
    lockHasToken(lockPath, env.TOKENBOARD_COORDINATOR_LOCK_TOKEN, runtime)
  )
}

function configDirFromInvocation(invocation, homeDir) {
  return invocation.env.TOKENBOARD_STATE_DIR || invocation.env.TOKENBOARD_CONFIG_DIR || join(homeDir, '.tokenboard')
}

function syncLockRuntime() {
  let processStartIdentity
  return {
    lockTimeoutMs: defaultSyncLockTimeoutMs,
    chmod: (path, mode) => chmodSync(path, mode),
    lstat: (path) => lstatSync(path),
    mkdir: (path, options) => mkdirSync(path, options),
    now: Date.now,
    process,
    getProcessStartIdentity: () => {
      if (processStartIdentity) return processStartIdentity
      processStartIdentity = currentProcessStartIdentity()
      return processStartIdentity
    },
    readFile: (path) => readFileSync(path, 'utf8'),
    rename: renameSync,
    link: linkSync,
    sleep: sleepSync,
    unlink: unlinkSync,
    writeFile: writeFileSync
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms))
}

function isMain() {
  return isMainModule(import.meta.url)
}

// A process exit code is 0-255, but the value reaching `recordState` is not always one:
// Windows reports the untruncated 32-bit status (`GetExitCodeProcess`), so an access
// violation arrives as 3221225477 rather than a byte. `scheduled-sync-state.mjs` rejects
// anything outside 0-255 by design, and that throw is swallowed by `recordState`'s catch —
// which left the file on disk still reading `running`, making the failure indistinguishable
// from a sync that never finished. Out-of-range codes are recorded as 1 (a generic failure)
// rather than dropped, since a dropped code reads as "no exit code recorded".
function recordableExitCode(exitCode) {
  return exitCode >= 0 && exitCode <= 255 ? exitCode : 1
}
