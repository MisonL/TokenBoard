#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  readConfig,
  parseArgs,
  collectorDir,
  readPackageManager
} from './config.mjs'
import { normalizePathEnv } from './schedule.mjs'
import { readSince } from './sync-options.mjs'
import { closeScheduledLogRuntime, createScheduledLogRuntime } from './logs.mjs'
import { runUpgrade } from './upgrade.mjs'
import { errorMessage } from './error-message.mjs'
import { acquireLock, lockHasToken, releaseLock, waitForLock } from './coordinator-lock.mjs'
import { runScheduledRetry } from './scheduled-retry.mjs'

const defaultSyncLockTimeoutMs = 60_000

if (isMain()) {
  process.exit(runCli())
}

function runCli() {
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

    return runSyncInvocation({
      flags,
      invocation,
      logs,
      stateDir: configDirFromInvocation(invocation, homeDir)
    })
  } catch (error) {
    console.error(`TokenBoard sync failed: ${errorMessage(error)}`)
    return 1
  } finally {
    closeScheduledLogRuntime(logs)
  }
}

export function runSyncInvocation({
  flags = {},
  invocation,
  logs,
  stateDir,
  runWithLock = runWithSyncLock,
  runRetry = runScheduledRetry
}) {
  const run = (runFlags = flags) => runWithLock({
    flags: runFlags,
    stateDir,
    run: () => runSync({ flags: runFlags, invocation, logs })
  })

  try {
    return run()
  } catch (error) {
    if (!shouldDeferScheduledSync(flags, error)) throw error
    const retryFlags = { ...flags, 'skip-upgrade': true }
    const result = runRetry({
      stateDir,
      source: invocation.source,
      runAttempt: () => run(retryFlags)
    })
    if (result.skipped) {
      console.error('TokenBoard scheduled sync deferred because another scheduled retry is active.')
    } else if (result.exhausted) {
      console.error(`TokenBoard scheduled sync retry exhausted after ${result.attempts} lock-timeout attempts.`)
    }
    return result.exitCode
  }
}

function runSync({ flags, invocation, logs }) {
  if (shouldRunUpgrade({ flags, env: process.env })) {
    try {
      runUpgrade({
        flags,
        automatic: true,
        log: (line) => {
          if (!logs) console.log(line)
        }
      })
    } catch (error) {
      console.error(`TokenBoard upgrade skipped: ${errorMessage(error)}`)
    }
  }

  if (!existsSync(invocation.repoDir)) {
    console.error(`TokenBoard collector is not installed: ${invocation.repoDir}`)
    console.error('Run setup.mjs again or run install-collector.mjs.')
    return 1
  }

  const result = spawnSync(
    invocation.command,
    invocation.args,
    {
      cwd: invocation.cwd,
      env: invocation.env,
      stdio: logs ? ['ignore', logs.stdoutFd, logs.stderrFd] : 'inherit',
      shell: invocation.shell
    }
  )

  if (result.error) {
    console.error(`Failed to run ${invocation.command}: ${errorMessage(result.error)}`)
    return 1
  }

  return result.status ?? 1
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
  platform = process.platform
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
  return {
    command: nodePath,
    args: ['--import', 'tsx', 'src/cli.ts', mode, '--source', source],
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
      TOKENBOARD_SINCE: since,
      TOKENBOARD_DEFAULT_SINCE: since,
      ...(flags.scheduled === true ? {
        TOKENBOARD_FAIL_ON_SOURCE_ERROR: '1'
      } : {}),
      ...(flags.hook === true ? {
        TOKENBOARD_HOOK_MODE: '1',
        TOKENBOARD_STATE_DIR: env.TOKENBOARD_STATE_DIR || env.TOKENBOARD_CONFIG_DIR || join(homeDir, '.tokenboard')
      } : {})
    }
  }
}

export function runWithSyncLock({
  flags = {},
  env = process.env,
  stateDir,
  runtime = syncLockRuntime(),
  run
}) {
  if (typeof run !== 'function') {
    throw new Error('runWithSyncLock requires run')
  }
  if (typeof stateDir !== 'string' || !stateDir.trim()) {
    throw new Error('runWithSyncLock requires stateDir')
  }
  runtime.mkdir(stateDir, { recursive: true })
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
    result = run()
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
    releaseError = new Error(
      `TokenBoard sync lock release failed: ${errorMessage(error)}`,
      { cause: error }
    )
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

function shouldDeferScheduledSync(flags, error) {
  return flags.scheduled === true &&
    flags.hook !== true &&
    (flags.mode || 'sync') === 'sync' &&
    error?.code === 'TOKENBOARD_SYNC_LOCK_TIMEOUT'
}

function syncLockTimeoutError(lockPath) {
  const error = new Error(`Timed out waiting for TokenBoard sync lock: ${lockPath}`)
  error.code = 'TOKENBOARD_SYNC_LOCK_TIMEOUT'
  return error
}

function isCoordinatorLockHeld({ flags, env, lockPath, runtime }) {
  return flags.hook === true &&
    env.TOKENBOARD_COORDINATOR_LOCK_HELD === '1' &&
    lockHasToken(lockPath, env.TOKENBOARD_COORDINATOR_LOCK_TOKEN, runtime)
}

function configDirFromInvocation(invocation, homeDir) {
  return invocation.env.TOKENBOARD_STATE_DIR || invocation.env.TOKENBOARD_CONFIG_DIR || join(homeDir, '.tokenboard')
}

function syncLockRuntime() {
  return {
    lockTimeoutMs: defaultSyncLockTimeoutMs,
    mkdir: (path, options) => mkdirSync(path, options),
    now: Date.now,
    process,
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
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}
