import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, win32 as windowsPath } from 'node:path'
import test from 'node:test'
import { migrateInstalledSchedule, scheduleEntryPaths } from './migrate-schedule.mjs'
import { buildLinuxSystemdUnits, buildMacLaunchAgentPlist, buildWindowsTaskScript } from './schedule.mjs'

const skillDir = '/home/u/.tokenboard/TokenBoard/skills/tokenboard'
const launcherPath = '/home/u/.tokenboard/bin/tokenboard-launcher.mjs'

function setup(t, platform) {
  const root = mkdtempSync(join(tmpdir(), 'migrate-schedule-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const homeDir = join(root, 'home')
  const configDir = join(root, 'config')
  const entry = scheduleEntryPaths({ platform, homeDir, configDir })
  mkdirSync(dirname(entry.path), { recursive: true })
  return { root, homeDir, configDir, entry }
}

function noReload() {
  const calls = []
  return { calls, spawn: (command, args) => (calls.push([command, ...args]), { status: 0 }) }
}

test('a launchd plist that still calls sync.mjs is rewritten onto the launcher', (t) => {
  const { homeDir, configDir, entry } = setup(t, 'darwin')
  const plist = buildMacLaunchAgentPlist({
    nodePath: '/usr/bin/node',
    scriptPath: join(skillDir, 'scripts', 'sync.mjs'),
    packageManager: 'pnpm',
    pathEnv: '/usr/bin:/bin',
    homeDir,
    configDir,
    logDir: join(configDir, 'logs'),
    scheduleTimes: ['09:00']
  })
  writeFileSync(entry.path, plist)
  const { calls, spawn } = noReload()
  const result = migrateInstalledSchedule({
    configDir,
    skillDir,
    launcherPath,
    platform: 'darwin',
    homeDir,
    spawn
  })
  assert.equal(result.status, 'migrated')
  const migrated = readFileSync(entry.path, 'utf8')
  assert.ok(migrated.includes(launcherPath), 'the plist must call the launcher')
  assert.ok(migrated.includes('<string>scripts/sync.mjs</string>'), 'the script is now launcher-relative')
  assert.ok(!migrated.includes(join(skillDir, 'scripts', 'sync.mjs')), 'the legacy path is gone')
  assert.ok(migrated.includes('<string>--mode</string>'), 'the remaining arguments are preserved')
  assert.deepEqual(
    calls.map(([command]) => command),
    ['launchctl', 'launchctl']
  )
})

test('a systemd unit that still calls sync.mjs is rewritten onto the launcher', (t) => {
  const { homeDir, configDir, entry } = setup(t, 'linux')
  const { service } = buildLinuxSystemdUnits({
    nodePath: '/usr/bin/node',
    scriptPath: join(skillDir, 'scripts', 'sync.mjs'),
    packageManager: 'pnpm',
    pathEnv: '/usr/bin:/bin',
    homeDir,
    configDir,
    scheduleTimes: ['09:00']
  })
  writeFileSync(entry.path, service)
  const { calls, spawn } = noReload()
  const result = migrateInstalledSchedule({
    configDir,
    skillDir,
    launcherPath,
    platform: 'linux',
    homeDir,
    spawn
  })
  assert.equal(result.status, 'migrated')
  const migrated = readFileSync(entry.path, 'utf8')
  assert.match(
    migrated,
    /ExecStart="[^"]*node[^"]*" "[^"]*tokenboard-launcher\.mjs" "scripts\/sync\.mjs" --mode sync --scheduled/
  )
  assert.deepEqual(calls, [['systemctl', '--user', 'daemon-reload']])
})

test('a Windows wrapper that still calls sync.mjs is rewritten onto the launcher', (t) => {
  const { homeDir, configDir, entry } = setup(t, 'win32')
  const wrapper = buildWindowsTaskScript({
    nodePath: 'C:\\node\\node.exe',
    scriptPath: windowsPath.join(skillDir, 'scripts', 'sync.mjs'),
    packageManager: 'pnpm',
    pathEnv: 'C:\\Windows\\System32',
    homeDir: 'C:\\Users\\u',
    configDir
  })
  writeFileSync(entry.path, wrapper)
  const result = migrateInstalledSchedule({
    configDir,
    skillDir,
    launcherPath,
    platform: 'win32',
    homeDir,
    spawn: () => ({ status: 0 })
  })
  assert.equal(result.status, 'migrated')
  const migrated = readFileSync(entry.path, 'utf8')
  assert.match(migrated, /"[^"]*tokenboard-launcher\.mjs" "scripts\/sync\.mjs"/)
  assert.ok(!migrated.includes('skills\\tokenboard\\scripts\\sync.mjs'))
})

test('a machine without a schedule never gains one', (t) => {
  const { configDir, entry } = setup(t, 'darwin')
  const result = migrateInstalledSchedule({
    configDir,
    skillDir,
    launcherPath,
    platform: 'darwin',
    homeDir: dirname(dirname(dirname(entry.path))),
    spawn: () => {
      throw new Error('must not run the scheduler')
    }
  })
  assert.equal(result.status, 'not-installed')
  assert.equal(existsSync(entry.path), false)
})

test('an entry that does not name this install is left byte-identical', (t) => {
  const { homeDir, configDir, entry } = setup(t, 'darwin')
  const plist = buildMacLaunchAgentPlist({
    nodePath: '/usr/bin/node',
    scriptPath: '/opt/other-tokenboard/scripts/sync.mjs',
    packageManager: 'pnpm',
    pathEnv: '/usr/bin:/bin',
    homeDir,
    configDir,
    logDir: join(configDir, 'logs'),
    scheduleTimes: ['09:00']
  })
  writeFileSync(entry.path, plist)
  const result = migrateInstalledSchedule({
    configDir,
    skillDir,
    launcherPath,
    platform: 'darwin',
    homeDir,
    spawn: () => {
      throw new Error('must not reload for an untouched entry')
    }
  })
  assert.equal(result.status, 'already-migrated')
  assert.equal(readFileSync(entry.path, 'utf8'), plist)
})

test('running the migration twice is a no-op the second time', (t) => {
  const { homeDir, configDir, entry } = setup(t, 'linux')
  const { service } = buildLinuxSystemdUnits({
    nodePath: '/usr/bin/node',
    scriptPath: join(skillDir, 'scripts', 'sync.mjs'),
    packageManager: 'pnpm',
    pathEnv: '/usr/bin:/bin',
    homeDir,
    configDir,
    scheduleTimes: ['09:00']
  })
  writeFileSync(entry.path, service)
  const first = migrateInstalledSchedule({
    configDir,
    skillDir,
    launcherPath,
    platform: 'linux',
    homeDir,
    spawn: () => ({ status: 0 })
  })
  assert.equal(first.status, 'migrated')
  const afterFirst = readFileSync(entry.path, 'utf8')
  const second = migrateInstalledSchedule({
    configDir,
    skillDir,
    launcherPath,
    platform: 'linux',
    homeDir,
    spawn: () => ({ status: 0 })
  })
  assert.equal(second.status, 'already-migrated')
  assert.equal(readFileSync(entry.path, 'utf8'), afterFirst)
})
