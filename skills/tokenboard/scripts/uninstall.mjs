#!/usr/bin/env node
import { existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { relative, resolve, win32 as windowsPath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectorDir, configDir, configPath, parseArgs } from './config.mjs'
import { deviceLinkPath } from './device-link.mjs'
import { errorMessage } from './error-message.mjs'
import { uninstallHooks } from './hooks.mjs'
import { uninstallSchedule } from './uninstall-schedule.mjs'

export function uninstallClient(options = {}) {
  const flags = options.flags || parseArgs(options.argv || process.argv.slice(2))
  const plan = createUninstallPlan(flags)
  const runtime = createUninstallRuntime(options)

  const hookResult = plan.removeHooks ? runtime.uninstallHooks(options.hookOptions || {}) : null
  runtime.uninstallSchedule(options.scheduleOptions || {})
  if (hasIncompleteHookRemoval(hookResult)) {
    throw new Error('Antigravity statusline restoration is incomplete; local recovery state was preserved')
  }

  const removed = {
    hook: plan.removeHooks,
    schedule: true,
    collector: false,
    config: false,
    configDir: false,
    deviceLink: false
  }

  if (plan.removeCollector && runtime.exists(runtime.collectorDir)) {
    if (!samePath(runtime.collectorDir, runtime.configDir, runtime.platform)) {
      removePath(runtime, runtime.collectorDir)
      removed.collector = true
    }
  }

  if (plan.removeConfig && !plan.removeConfigDir && runtime.exists(runtime.configPath)) {
    removePath(runtime, runtime.configPath, { force: true })
    removed.config = true
  }

  if (plan.removeConfigDir && runtime.exists(runtime.configDir)) {
    assertRemovableConfigDir(runtime)
    const deviceLinkWasPresent = runtime.exists(runtime.deviceLinkPath)
    removePath(runtime, runtime.configDir)
    removed.configDir = true
    removed.deviceLink = deviceLinkWasPresent
  }

  runtime.log('TokenBoard client uninstall completed.')
  return removed
}

function hasIncompleteHookRemoval(result) {
  return result?.hooks?.some((hook) => hook?.incomplete === true) === true
}

function createUninstallPlan(flags) {
  const removeCollector = Boolean(flags.all || flags['remove-collector'])
  const removeConfigDir = Boolean(flags.all || flags['remove-config-dir'])
  return {
    removeCollector,
    removeConfig: Boolean(flags['remove-config']),
    removeConfigDir,
    removeHooks: Boolean(
      flags.all ||
      flags['remove-hook'] ||
      flags['remove-hooks'] ||
      removeCollector ||
      flags['remove-config'] ||
      removeConfigDir
    )
  }
}

function createUninstallRuntime(options) {
  return {
    collectorDir: options.collectorDir || collectorDir(),
    configDir: options.configDir || configDir(),
    configPath: options.configPath || configPath(),
    deviceLinkPath: options.deviceLinkPath || deviceLinkPath(options.configDir || configDir()),
    exists: options.exists || existsSync,
    rm: options.rm || rmSync,
    cwd: options.cwd || process.cwd,
    chdir: options.chdir || process.chdir,
    fallbackCwd: options.fallbackCwd || homedir(),
    platform: options.platform || process.platform,
    log: options.log || console.log,
    uninstallHooks: options.uninstallHooks || uninstallHooks,
    uninstallSchedule: options.uninstallSchedule || uninstallSchedule
  }
}

function removePath(runtime, targetPath, options = { recursive: true, force: true }) {
  leaveDirectoryBeforeRemove(runtime, targetPath)
  runtime.rm(targetPath, options)
}

function leaveDirectoryBeforeRemove(runtime, targetPath) {
  if (isInsidePath(runtime.cwd(), targetPath, runtime.platform)) {
    runtime.chdir(runtime.fallbackCwd)
  }
}

function isInsidePath(candidatePath, targetPath, platform = process.platform) {
  const pathApi = platform === 'win32' ? windowsPath : { relative, resolve, sep: '/' }
  const resolvedTarget = pathApi.resolve(targetPath)
  const resolvedCandidate = pathApi.resolve(candidatePath)
  if (platform === 'win32' && !sameWindowsRoot(resolvedTarget, resolvedCandidate)) {
    return false
  }
  const relativePath = pathApi.relative(resolvedTarget, resolvedCandidate)
  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${pathApi.sep}`) && !relativePath.startsWith(pathApi.sep) && relativePath !== '..')
  )
}

function sameWindowsRoot(leftPath, rightPath) {
  return windowsPath.parse(leftPath).root.toLowerCase() === windowsPath.parse(rightPath).root.toLowerCase()
}

function samePath(leftPath, rightPath, platform = process.platform) {
  const pathApi = platform === 'win32' ? windowsPath : { resolve }
  const normalize = (value) => {
    const resolved = pathApi.resolve(String(value))
    return platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return normalize(leftPath) === normalize(rightPath)
}

function runCli() {
  try {
    uninstallClient()
  } catch (error) {
    console.error(errorMessage(error))
    process.exit(1)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli()
}

// `TOKENBOARD_CONFIG_DIR` is a plain environment variable and the config directory is
// removed recursively, so pointing it at `$HOME` or `/` made `--remove-config-dir` — and
// `--all`, which the skill documents — delete that whole tree, `~/.ssh` and all, silently,
// with no dry run and no prompt. The other installers already refuse a suspicious config
// directory; this applies the same guard where the deletion happens.
//
// A TokenBoard config directory is always a *dot-directory* the tool created for itself
// (`.tokenboard`, or a `.tokenboard-*` variant for a second install). Requiring a leading
// dot and at least three path segments rejects a home directory (`/home/user`, `/Users/x`),
// a filesystem root, `/tmp`, a project directory, and a bare relative name — every shape
// where a recursive delete would destroy something the user did not hand over.
function assertRemovableConfigDir(runtime) {
  const target = String(runtime.configDir)
  const trimmed = target.replace(/[\\/]+$/, '')
  const segments = trimmed.split(/[\\/]+/).filter(Boolean)
  const basename = segments.at(-1) ?? ''
  const isDedicatedName = basename.startsWith('.') && basename.length > 1
  if (!isDedicatedName || segments.length < 3) {
    throw new Error(
      `Refusing to remove ${target}: the TokenBoard config directory must be a dedicated dot-directory the tool created (for example ~/.tokenboard), not a home directory, filesystem root, or shared path. Remove it by hand if that is really what you want.`
    )
  }
}
