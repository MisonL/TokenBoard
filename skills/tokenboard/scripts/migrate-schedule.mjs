// Migrates an already-installed scheduler entry onto the stable launcher.
//
// Only an *existing* schedule is rewritten: a machine that deliberately runs no
// schedule (setup --skip-schedule) must not gain one from an upgrade. Entries are
// recognised by the script path they currently invoke, so a user's own pinned
// variant of a TokenBoard unit is left alone.
//
// This is the step that makes the launcher effective for existing installs: the
// setup path writes launcher-based entries for new installs, but nothing re-runs
// setup on an upgrade, so without this a migrated machine keeps calling the old
// `<skillDir>/scripts/sync.mjs` until its schedule is reinstalled by hand.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join, win32 as windowsPath } from 'node:path'
import { launchAgentLabel, serviceName, windowsWrapperName } from './schedule.mjs'

export function scheduleEntryPaths({ platform, homeDir = homedir(), configDir }) {
  if (platform === 'darwin') {
    return { path: join(homeDir, 'Library', 'LaunchAgents', `${launchAgentLabel}.plist`), kind: 'launchd' }
  }
  if (platform === 'linux') {
    return { path: join(homeDir, '.config', 'systemd', 'user', serviceName), kind: 'systemd' }
  }
  if (platform === 'win32') {
    return { path: join(configDir, windowsWrapperName), kind: 'schtasks-wrapper' }
  }
  return null
}

// The exact argument forms each generator writes, so the rewrite can splice the
// launcher in without re-deriving the whole file (which would need schedule
// times, PATH and package manager that may have changed since install).
function rewriteEntry({ kind, content, legacyScriptPath, launcherPath }) {
  const relativeEntry = 'scripts/sync.mjs'
  if (kind === 'launchd') {
    const old = `\t\t<string>${escapeXml(legacyScriptPath)}</string>\n`
    if (!content.includes(old)) return null
    const replacement = `\t\t<string>${escapeXml(launcherPath)}</string>\n\t\t<string>${relativeEntry}</string>\n`
    return content.replace(old, replacement)
  }
  if (kind === 'systemd') {
    // ExecStart uses quoteSystemdValue, which always wraps in double quotes.
    const old = `"${escapeSystemd(legacyScriptPath)}"`
    if (!content.includes(old)) return null
    return content.replace(old, `"${escapeSystemd(launcherPath)}" "${relativeEntry}"`)
  }
  // Windows wrapper: the node invocation is the single line naming the script.
  const old = `"${escapeWindowsCmd(legacyScriptPath)}"`
  if (!content.includes(old)) return null
  return content.replace(old, `"${escapeWindowsCmd(launcherPath)}" "${relativeEntry}"`)
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function escapeSystemd(value) {
  return String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('%', '%%')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
}

function escapeWindowsCmd(value) {
  return String(value).replaceAll('%', '%%')
}

// After the files are rewritten the scheduler must re-read them: launchd caches
// the loaded job, systemd caches the unit. Both are best-effort — a failed reload
// leaves the migration in place (the file is correct) and the next install fixes
// the daemon state.
function reloadScheduler({ kind, plistPath, spawn, log, env }) {
  try {
    if (kind === 'launchd') {
      const uid = process.getuid?.() ?? 0
      const domain = `gui/${uid}`
      spawn('launchctl', ['bootout', domain, plistPath], { stdio: 'ignore', env })
      const result = spawn('launchctl', ['bootstrap', domain, plistPath], { stdio: 'ignore', env })
      if (result.status !== 0) {
        log(`TokenBoard schedule migrated, but launchctl bootstrap failed; rerun setup to reload it`)
      }
    } else if (kind === 'systemd') {
      const result = spawn('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore', env })
      if (result.status !== 0) {
        log(`TokenBoard schedule migrated, but systemctl daemon-reload failed; rerun setup to reload it`)
      }
    }
    // Windows reads the wrapper on every run; nothing to reload.
  } catch {
    // The migration is a convenience; a scheduler hiccup must not fail an upgrade.
  }
}

export function migrateInstalledSchedule({
  configDir,
  skillDir,
  launcherPath,
  platform = process.platform,
  homeDir = homedir(),
  env = process.env,
  spawn = spawnSync,
  exists = existsSync,
  readFile = (path) => readFileSync(path, 'utf8'),
  writeFile = (path, content) => writeFileSync(path, content),
  reload = true,
  log = () => {}
}) {
  const entry = scheduleEntryPaths({ platform, homeDir, configDir })
  if (!entry) return { status: 'unsupported', platform }
  if (!exists(entry.path)) return { status: 'not-installed', platform, path: entry.path }
  // The separator must match what the generator wrote on that platform, which is
  // not necessarily the separator of the host running this migration (a Windows
  // install inspected from a POSIX host, or a test).
  const legacyScriptPath = (platform === 'win32' ? windowsPath.join : join)(skillDir, 'scripts', 'sync.mjs')
  const content = readFile(entry.path)
  const next = rewriteEntry({ kind: entry.kind, content, legacyScriptPath, launcherPath })
  if (next === null) return { status: 'already-migrated', platform, path: entry.path }
  writeFile(entry.path, next)
  if (reload) reloadScheduler({ kind: entry.kind, plistPath: entry.path, spawn, log, env })
  return { status: 'migrated', platform, path: entry.path }
}
