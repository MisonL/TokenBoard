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

    return runWithSyncLock({
      flags,
      stateDir: configDirFromInvocation(invocation, homeDir),
      run: () => runSync({ flags, invocation, logs })
    })
  } catch (error) {
    console.error(`TokenBoard sync failed: ${errorMessage(error)}`)
    return 1
  } finally {
    closeScheduledLogRuntime(logs)
  }
}

function runSync({ flags, invocation, logs }) {
  if (shouldRunUpgrade({ flags, env: process.env })) {
    try {
      runUpgrade({
        flags,
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
      throw new Error(`Timed out waiting for TokenBoard sync lock: ${lockPath}`)
    }
    owner = wait.owner
  }
  try {
    return run()
  } finally {
    releaseLock(lockPath, runtime, owner)
  }
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
