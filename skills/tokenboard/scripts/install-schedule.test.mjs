import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { installSchedule } from './install-schedule.mjs'

test('installs macOS LaunchAgent through an isolated launchctl harness', () => {
  const harness = createHarness('darwin')
  try {
    const result = installSchedule({
      ...harness.options,
      argv: ['--schedule-times', '08:15,21:45']
    })

    const plistPath = join(harness.homeDir, 'Library', 'LaunchAgents', 'com.tokenboard.daily-sync.plist')
    assert.equal(result.plistPath, plistPath)
    assert.equal(existsSync(plistPath), true)
    const plist = readFileSync(plistPath, 'utf8')
    assert.match(plist, /<integer>8<\/integer>/)
    assert.match(plist, /<integer>15<\/integer>/)
    assert.match(plist, /<integer>21<\/integer>/)
    assert.match(plist, /<integer>45<\/integer>/)
    assert.deepEqual(harness.calls.map(commandLine), [
      'launchctl --version',
      `launchctl bootout gui/501 ${plistPath}`,
      `launchctl bootstrap gui/501 ${plistPath}`,
      'launchctl enable gui/501/com.tokenboard.daily-sync'
    ])
  } finally {
    harness.cleanup()
  }
})

test('installs Linux user systemd timer through an isolated systemd harness', () => {
  const harness = createHarness('linux')
  try {
    installSchedule({
      ...harness.options,
      argv: ['--schedule-times', '08:15,21:45']
    })

    const unitDir = join(harness.homeDir, '.config', 'systemd', 'user')
    const service = readFileSync(join(unitDir, 'tokenboard-daily-sync.service'), 'utf8')
    const timer = readFileSync(join(unitDir, 'tokenboard-daily-sync.timer'), 'utf8')
    assert.match(service, /Environment=TOKENBOARD_PACKAGE_MANAGER=pnpm/)
    assert.match(timer, /OnCalendar=08:15/)
    assert.match(timer, /OnCalendar=21:45/)
    assert.doesNotMatch(timer, /OnCalendar=09:00/)
    assert.deepEqual(harness.calls.map(commandLine), [
      'systemctl --user --version',
      'systemctl --user daemon-reload',
      'systemctl --user enable --now tokenboard-daily-sync.timer',
      'loginctl --version',
      'loginctl enable-linger tokenboard-test'
    ])
  } finally {
    harness.cleanup()
  }
})

test('creates Windows scheduled tasks through an isolated schtasks harness', () => {
  const harness = createHarness('win32')
  try {
    installSchedule({
      ...harness.options,
      argv: ['--schedule-times', '08:15,21:45']
    })

    assert.deepEqual(harness.calls.map(commandLine), [
      'schtasks.exe --version',
      'schtasks.exe /Create /F /SC DAILY /TN TokenBoardDailySync /TR "node-test" "sync-test.mjs" --mode sync --source all /ST 08:15',
      'schtasks.exe /Create /F /SC DAILY /TN TokenBoardDailySync2145 /TR "node-test" "sync-test.mjs" --mode sync --source all /ST 21:45'
    ])
  } finally {
    harness.cleanup()
  }
})

function createHarness(platform) {
  const root = mkdtempSync(join(tmpdir(), 'tokenboard-schedule-test-'))
  const homeDir = join(root, 'home')
  const configDir = join(root, 'config')
  const calls = []
  return {
    homeDir,
    calls,
    options: {
      platform,
      homeDir,
      configDir,
      nodePath: 'node-test',
      scriptPath: 'sync-test.mjs',
      getUid: () => 501,
      env: {
        PATH: '/usr/bin:/bin',
        USER: 'tokenboard-test'
      },
      readConfig: () => ({ packageManager: 'pnpm' }),
      log: () => {},
      spawn: (command, args) => {
        calls.push({ command, args })
        return { status: 0 }
      }
    },
    cleanup: () => rmSync(root, { recursive: true, force: true })
  }
}

function commandLine(call) {
  return [call.command, ...call.args].join(' ')
}
