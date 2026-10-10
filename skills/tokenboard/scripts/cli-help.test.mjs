import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { hasHelpFlag, printHelpIfRequested } from './cli-help.mjs'

const scriptPath = (name) => fileURLToPath(new URL(`./${name}`, import.meta.url))
const helpInvocations = ['--help', '-h']

// Every CLI that can change local state must treat `--help`/`-h` as a pure read: print usage,
// exit 0, read nothing from stdin, and touch neither the config directory nor the hooks. The
// harness below makes that guarantee verifiable without any access to the real machine: HOME,
// every hook config location and the collector checkout point into a temp root, and each
// command the scripts could shell out to (git, corepack, launchctl, systemctl, schtasks,
// powershell) resolves to a shim that records the call and fails. A regression that ran one of
// them — a real upgrade, a real schedule install — fails the exit-code assertion and leaves a
// marker the test reports.
const shimmedCommands = [
  'git',
  'corepack',
  'pnpm',
  'npm',
  'bun',
  'launchctl',
  'loginctl',
  'systemctl',
  'schtasks.exe',
  'powershell.exe'
]

const helpScripts = [
  { name: 'uninstall.mjs', args: [] },
  { name: 'upgrade.mjs', args: [] },
  { name: 'sync.mjs', args: [] },
  { name: 'setup.mjs', args: [] },
  { name: 'install-collector.mjs', args: [] },
  { name: 'install-hook.mjs', args: [] },
  { name: 'uninstall-hook.mjs', args: [] },
  { name: 'install-schedule.mjs', args: [] },
  { name: 'uninstall-schedule.mjs', args: [] },
  { name: 'refresh-notify-handler.mjs', args: [] },
  { name: 'antigravity-statusline.mjs', args: [] },
  { name: 'status.mjs', args: [] },
  { name: 'rotate-token.mjs', args: [] },
  { name: 'notify.mjs', args: [] }
]

test('hasHelpFlag recognizes only the help spellings', () => {
  assert.equal(hasHelpFlag(['--help']), true)
  assert.equal(hasHelpFlag(['-h']), true)
  assert.equal(hasHelpFlag(['--mode', 'sync', '--help']), true)
  assert.equal(hasHelpFlag(['--mode', 'sync']), false)
  assert.equal(hasHelpFlag(['--helper']), false)
  assert.equal(hasHelpFlag(['--helpful']), false)
  assert.equal(hasHelpFlag(['-help']), false)
  assert.equal(hasHelpFlag([]), false)
})

test('printHelpIfRequested prints usage once and reports the request', () => {
  const lines = []
  assert.equal(
    printHelpIfRequested(['--help'], 'Usage: thing', (line) => lines.push(line)),
    true
  )
  assert.deepEqual(lines, ['Usage: thing'])

  assert.equal(
    printHelpIfRequested(['--other'], 'Usage: thing', (line) => lines.push(line)),
    false
  )
  assert.deepEqual(lines, ['Usage: thing'])
})

for (const script of helpScripts) {
  for (const flag of helpInvocations) {
    test(`${script.name} ${flag} exits 0 without reading stdin or touching local state`, async () => {
      const harness = createHarness()
      try {
        const result = await spawnWithOpenStdin(process.execPath, [scriptPath(script.name), ...script.args, flag], {
          cwd: harness.root,
          env: harness.env
        })

        assert.equal(result.timedOut, false, `${script.name} ${flag} waited on stdin instead of exiting`)
        assert.equal(result.code, 0, `${script.name} ${flag} exited ${result.code}: ${result.stderr}`)
        assert.match(result.stdout, /Usage:/)
        assert.equal(harness.spawnedCommands(), '', 'help must not spawn any external command')
        harness.assertNoStateCreated()
      } finally {
        harness.cleanup()
      }
    })
  }
}

// An entry guard that compares paths by string — or via `resolve()`, which does not follow
// symlinks — fails when the script is reached through one: the process exits 0 having printed
// nothing, so `--help` silently violates its own contract. Node resolves `import.meta.url`
// through symlinks while `process.argv[1]` is whatever the caller typed, so the guard must
// canonicalize both sides. This covers every CLI in one place rather than one test per script.
test('every CLI treats a symlinked invocation as its own entry point', async () => {
  const harness = createHarness()
  try {
    const symlinkDir = join(harness.root, 'symlinked-bin')
    mkdirSync(symlinkDir, { recursive: true })
    for (const script of helpScripts) {
      const linkPath = join(symlinkDir, script.name)
      symlinkSync(scriptPath(script.name), linkPath)

      const result = await spawnWithOpenStdin(process.execPath, [linkPath, ...script.args, '--help'], {
        cwd: harness.root,
        env: harness.env
      })

      assert.equal(result.timedOut, false, `${script.name} waited on stdin through a symlink`)
      assert.equal(result.code, 0, `${script.name} exited ${result.code} through a symlink: ${result.stderr}`)
      assert.match(
        result.stdout,
        /Usage:/,
        `${script.name} printed no usage through a symlink — its entry guard did not resolve the link`
      )
    }
  } finally {
    harness.cleanup()
  }
})

test('antigravity-statusline.mjs records an invalid option and exits without reading stdin', async () => {
  const harness = createHarness()
  try {
    const result = await spawnWithOpenStdin(
      process.execPath,
      [scriptPath('antigravity-statusline.mjs'), '--state-dir', harness.stateDir, '--max-log-bytes', 'nope'],
      {
        cwd: harness.root,
        env: harness.env
      }
    )

    assert.equal(result.timedOut, false, 'an option error must not wait on stdin')
    assert.equal(result.code, 1)
    assert.equal(harness.spawnedCommands(), '')
    const errorLog = join(harness.stateDir, 'antigravity-statusline-errors.log')
    assert.equal(existsSync(errorLog), true)
    assert.match(harness.readFile(errorLog), /Invalid Antigravity statusline log byte limit/)
    assert.doesNotMatch(harness.readFile(errorLog), /nope/)
  } finally {
    harness.cleanup()
  }
})

function createHarness() {
  const root = mkdtempSync(join(tmpdir(), 'tokenboard-cli-help-'))
  const homeDir = join(root, 'home')
  const stateDir = join(root, 'state')
  const collectorDir = join(root, 'collector')
  const shimDir = join(root, 'bin')
  const markerPath = join(root, 'spawned-commands.log')
  mkdirSync(homeDir, { recursive: true })
  mkdirSync(shimDir, { recursive: true })
  for (const command of shimmedCommands) {
    writeFileSync(join(shimDir, command), `#!/bin/sh\necho "$0" >> '${markerPath}'\nexit 1\n`, { mode: 0o755 })
  }

  const env = {
    PATH: `${shimDir}:/usr/bin:/bin`,
    HOME: homeDir,
    TMPDIR: process.env.TMPDIR || tmpdir(),
    LANG: process.env.LANG || 'en_US.UTF-8',
    TOKENBOARD_CONFIG_DIR: stateDir,
    TOKENBOARD_STATE_DIR: stateDir,
    TOKENBOARD_COLLECTOR_DIR: collectorDir,
    TOKENBOARD_LOG_DIR: join(stateDir, 'logs'),
    // Any accidental network path points at a closed local port, never a real host.
    TOKENBOARD_BASE_URL: 'http://127.0.0.1:1',
    TOKENBOARD_PAIRING_CODE: 'cli-help-test-code',
    TOKENBOARD_REPO_URL: 'http://127.0.0.1:1/tokenboard.git',
    TOKENBOARD_ARCHIVE_URL: 'http://127.0.0.1:1/tokenboard.zip',
    CODEX_HOME: join(homeDir, '.codex'),
    CLAUDE_CONFIG_DIR: join(homeDir, '.claude'),
    ANTIGRAVITY_CONFIG_DIR: join(homeDir, '.gemini', 'antigravity-cli'),
    ANTIGRAVITY_IDE_CONFIG_DIR: join(homeDir, '.gemini', 'antigravity-ide'),
    ANTIGRAVITY_APP_CONFIG_DIR: join(homeDir, '.gemini', 'antigravity'),
    XDG_CONFIG_HOME: join(homeDir, '.config')
  }

  return {
    root,
    homeDir,
    stateDir,
    env,
    readFile: (path) => readFileSync(path, 'utf8'),
    spawnedCommands: () => {
      try {
        return readFileSync(markerPath, 'utf8').trim()
      } catch {
        return ''
      }
    },
    assertNoStateCreated: () => {
      assert.equal(existsSync(stateDir), false, 'help must not create the state directory')
      assert.equal(existsSync(collectorDir), false, 'help must not create the collector directory')
      for (const hookDir of [
        join(homeDir, '.codex'),
        join(homeDir, '.claude'),
        join(homeDir, '.gemini'),
        join(homeDir, '.config'),
        join(homeDir, 'Library')
      ]) {
        assert.equal(existsSync(hookDir), false, `help must not touch ${hookDir}`)
      }
      assert.deepEqual(readdirSync(homeDir), [], 'help must not write inside HOME')
    },
    cleanup: () => rmSync(root, { recursive: true, force: true })
  }
}

async function spawnWithOpenStdin(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), 10_000)
  })
  const exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ timedOut: false, code, signal }))
  })

  const result = await Promise.race([exited, timeout])
  clearTimeout(timer)
  if (result.timedOut) {
    child.kill('SIGKILL')
  }
  // The stdin pipe is intentionally never written or ended: a handler that reads it would
  // block forever and trip the timeout instead of exiting.
  return { ...result, stdout, stderr }
}
