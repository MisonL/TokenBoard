// The stable entry point that scheduled runs and hooks execute.
//
// Why this exists: a scheduled tick and a hook event can fire in the window
// between the two renames of a skill-directory swap, when `<skillDir>` does not
// exist. Today that window makes sync runs and hooks fail until the next tick
// happens to land after a successful upgrade. This launcher lives in
// `<configDir>/bin`, outside the swapped tree, and repairs the swap before
// handing off.
//
// Self-containment rules (the whole reason this file can be copied):
// - only `node:*` imports plus `./skill-swap-lock.mjs`, which is vendored next
//   to this file byte-for-byte (`ensureLauncher` in launcher.mjs);
// - nothing here reads the skill tree before the health check passes, because
//   the skill tree is exactly what may be missing.
//
// Exit codes: the child's own code is passed through untouched. Everything the
// launcher itself fails at prints one diagnosable line on stderr and exits with
// the skill suite's transient code (75), so the hook dispatcher and the
// scheduled retry treat it as retryable rather than permanent.
//
// Not holding `sync.lock`: recovery contends on a dedicated `skill-swap.lock`
// (./skill-swap-lock.mjs). The child scripts take the coordinator lock
// themselves, and a launcher that held it across the spawn would deadlock the
// child against its own parent.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { acquireSkillSwapLock, releaseSkillSwapLock, skillSwapLockPath } from './skill-swap-lock.mjs'

export const launcherTransientExitCode = 75
export const skillCompleteMarkerName = '.tokenboard-skill-complete'
const swapLockBudgetMs = 1500
const busyRenameRetries = 5
const busyRenameBaseDelayMs = 40

// Default state/config dir resolution, mirroring sync.mjs's
// `configDirFromInvocation` three-level fallback.
export function launcherConfigDir(env) {
  return env.TOKENBOARD_STATE_DIR || env.TOKENBOARD_CONFIG_DIR || join(homedir(), '.tokenboard')
}

// Installed layout: <configDir>/TokenBoard is the collector checkout, and the
// skill lives at <collector>/skills/tokenboard. TOKENBOARD_SKILL_DIR wins when
// set so tests (and unusual installs) can pin the target.
export function launcherSkillDir(env, configDir) {
  return env.TOKENBOARD_SKILL_DIR || join(configDir, 'TokenBoard', 'skills', 'tokenboard')
}

export function isSkillHealthy({ skillDir, scriptRelative, fs }) {
  // A script that exists is the only reliable health signal available: every
  // install that predates this launcher has no completion marker, so requiring
  // the marker would declare every legacy install broken. The marker is what
  // makes a *staging* directory trustworthy (see recover), not what makes an
  // installed directory healthy.
  return fs.exists(join(skillDir, scriptRelative))
}

function hasCompletionMarker(dir, fs) {
  return fs.exists(join(dir, skillCompleteMarkerName))
}

function newestFirst(candidates) {
  // Deterministic even when two leftovers share an mtime tick (coarse
  // filesystems): the path breaks the tie so recovery decides the same way on
  // every run.
  return candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || (left.path < right.path ? 1 : -1))
}

// Candidates are siblings of `<skillDir>` named `<basename>.<kind>-<suffix>`.
// Backups are produced by a full directory rename and are complete by
// construction; stagings are only trusted with a completion marker, because a
// killed copy leaves a plausible-looking but partial tree.
export function findRecoverySources({ skillDir, fs }) {
  const parent = dirname(skillDir)
  const prefix = `${basename(skillDir)}.`
  let names = []
  try {
    names = fs.readDir(parent)
  } catch {
    return { backups: [], stagings: [] }
  }
  const backups = []
  const stagings = []
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    const rest = name.slice(prefix.length)
    const path = join(parent, name)
    let stat
    try {
      stat = fs.stat(path)
    } catch {
      continue
    }
    if (!stat?.isDirectory?.()) continue
    if (rest.startsWith('tokenboard-upgrade-backup-')) {
      backups.push({ path, mtimeMs: Number(stat.mtimeMs) || 0 })
    } else if (rest.startsWith('tokenboard-upgrade-staging-')) {
      if (hasCompletionMarker(path, fs)) stagings.push({ path, mtimeMs: Number(stat.mtimeMs) || 0 })
    }
  }
  return { backups: newestFirst(backups), stagings: newestFirst(stagings) }
}

const retryableRenameCodes = new Set(['EPERM', 'EACCES', 'EBUSY'])

// Windows holds directory handles briefly (antivirus, indexer), so a single
// rename can fail with EPERM on a directory nothing else obviously uses.
function renameWithRetry({ from, to, runtime }) {
  let lastError
  for (let attempt = 0; attempt < busyRenameRetries; attempt += 1) {
    try {
      runtime.fs.rename(from, to)
      return
    } catch (error) {
      lastError = error
      if (!retryableRenameCodes.has(error?.code)) throw error
      runtime.sleep(busyRenameBaseDelayMs * 2 ** attempt)
    }
  }
  throw lastError
}

function lockRuntimeFor(runtime) {
  return {
    pid: runtime.pid,
    now: runtime.now,
    sleep: runtime.sleep,
    isProcessAlive: runtime.isProcessAlive,
    readFile: runtime.fs.readFile,
    writeFile: runtime.fs.writeFile,
    unlink: runtime.fs.unlink,
    budgetMs: swapLockBudgetMs
  }
}

// Renames the best recovery source into place. Returns null on success or a
// diagnosable message. The caller holds the swap lock for the whole call.
function recoverSkillDir({ skillDir, scriptRelative, runtime }) {
  const { backups, stagings } = findRecoverySources({ skillDir, fs: runtime.fs })
  const source = backups[0] ?? stagings[0]
  if (!source) {
    return `no upgrade backup or staging found to recover ${skillDir}`
  }
  // A half-copied directory (the archive upgrade path copies in place) blocks
  // the rename; move it aside instead of deleting so the failure stays
  // inspectable.
  if (runtime.fs.exists(skillDir)) {
    const broken = `${skillDir}.tokenboard-launcher-broken-${runtime.pid}`
    runtime.fs.rm(broken)
    try {
      renameWithRetry({ from: skillDir, to: broken, runtime })
    } catch (error) {
      return `cannot quarantine broken skill directory ${skillDir}: ${error?.message ?? error}`
    }
  }
  const parent = dirname(skillDir)
  if (!runtime.fs.exists(parent)) {
    try {
      runtime.fs.mkdir(parent, { recursive: true })
    } catch (error) {
      return `cannot create ${parent}: ${error?.message ?? error}`
    }
  }
  try {
    renameWithRetry({ from: source.path, to: skillDir, runtime })
  } catch (error) {
    return `cannot restore ${source.path} to ${skillDir}: ${error?.message ?? error}`
  }
  if (!isSkillHealthy({ skillDir, scriptRelative, fs: runtime.fs })) {
    return `recovered ${skillDir} from ${source.path} but ${scriptRelative} is still missing`
  }
  return null
}

export function runLauncherCli({ argv = [], env = {}, runtime = defaultLauncherRuntime(env) }) {
  const [scriptRelative, ...args] = argv
  if (!scriptRelative) {
    runtime.onError('usage: tokenboard-launcher.mjs <scripts/entry.mjs> [...args]')
    return 2
  }
  const configDir = launcherConfigDir(env)
  const skillDir = launcherSkillDir(env, configDir)
  const scriptPath = resolve(skillDir, scriptRelative)
  if (isAbsolute(scriptRelative) || !scriptPath.startsWith(skillDir + sep)) {
    runtime.onError(`refusing a script path outside ${skillDir}: ${scriptRelative}`)
    return 2
  }
  const childEnv = { ...env, TOKENBOARD_STATE_DIR: configDir, TOKENBOARD_SKILL_DIR: skillDir }

  let recoveryError = null
  if (!isSkillHealthy({ skillDir, scriptRelative, fs: runtime.fs })) {
    const lockPath = skillSwapLockPath(configDir)
    const owner = acquireSkillSwapLock(lockPath, lockRuntimeFor(runtime))
    if (!owner) {
      runtime.onError(
        `skill swap lock at ${lockPath} is busy; skill directory ${skillDir} is not usable yet — retrying on the next scheduled run`
      )
      return launcherTransientExitCode
    }
    try {
      // Another launcher may have finished the recovery between our first
      // observation and taking the lock; never recover from a stale view.
      if (!isSkillHealthy({ skillDir, scriptRelative, fs: runtime.fs })) {
        recoveryError = recoverSkillDir({ skillDir, scriptRelative, runtime })
      }
    } finally {
      releaseSkillSwapLock(lockPath, lockRuntimeFor(runtime), owner)
    }
    if (recoveryError) {
      runtime.onError(`cannot run ${scriptRelative}: ${recoveryError}`)
      return launcherTransientExitCode
    }
  }

  const result = runtime.spawn(process.execPath, [scriptPath, ...args], { stdio: 'inherit', env: childEnv })
  if (typeof result?.status === 'number') return result.status
  if (result?.signal) {
    runtime.onError(`child ${scriptRelative} terminated by ${result.signal}`)
    return 1
  }
  return 1
}

// The runtime the installed entry uses. Kept in this file so the vendored copy
// in <configDir>/bin has no dependency on the skill tree at import time.
export function defaultLauncherRuntime(env = process.env) {
  return {
    platform: process.platform,
    pid: process.pid,
    now: () => Date.now(),
    sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
    isProcessAlive: (pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch (error) {
        // EPERM means the process exists but belongs to somebody else.
        return error?.code !== 'ESRCH'
      }
    },
    fs: {
      exists: (p) => existsSync(p),
      stat: (p) => statSafe(p),
      readDir: (p) => readdirSync(p),
      readFile: (p) => readFileSync(p, 'utf8'),
      writeFile: (p, data, options) => writeFileSync(p, data, options),
      mkdir: (p, options) => mkdirSync(p, options),
      rename: (from, to) => renameSync(from, to),
      unlink: (p) => rmSync(p, { force: true }),
      rm: (p) => rmSync(p, { recursive: true, force: true })
    },
    spawn: (command, args, options) => spawnSync(command, args, options),
    onError: (line) => process.stderr.write(`TokenBoard launcher: ${line}\n`)
  }
}

function statSafe(p) {
  try {
    return statSync(p)
  } catch {
    return null
  }
}
