import assert from 'node:assert/strict'
import test from 'node:test'
import { hookStatus, installHooks, uninstallHooks } from './hooks.mjs'
import { readSources } from './hooks-utils.mjs'

test('all installs Codex and Claude Code hooks while Antigravity CLI stays explicit opt-in', () => {
  assert.deepEqual(readSources('all'), ['codex', 'claude-code'])
  assert.deepEqual(readSources('all,antigravity-cli'), ['codex', 'claude-code', 'antigravity-cli'])
})

test('installs and restores Antigravity statusLine command without notify handler', () => {
  const paths = createPaths()
  const originalSettings = {
    statusLine: {
      enabled: false,
      command: 'node /custom/statusline.mjs',
      color: 'blue'
    },
    other: true
  }
  const fs = memoryFs({
    [paths.antigravitySettingsPath]: JSON.stringify(originalSettings)
  })

  const installed = installHooks({
    paths,
    fs,
    nodePath: '/usr/bin/node',
    flags: { source: 'antigravity-cli' }
  })

  assert.equal(installed.hooks[0].changed, true)
  assert.equal(fs.files.has(paths.notifyPath), false)
  const settings = JSON.parse(fs.files.get(paths.antigravitySettingsPath))
  assert.equal(settings.statusLine.enabled, true)
  assert.match(settings.statusLine.command, /antigravity-statusline\.mjs/)
  assert.match(settings.statusLine.command, /--state-dir/)
  assert.deepEqual(JSON.parse(fs.files.get(paths.antigravityOriginalStatuslinePath)).statusLine, originalSettings.statusLine)
  assert.equal(hookStatus({ paths, fs }).antigravityCli, 'installed')

  const removed = uninstallHooks({ paths, fs, flags: { source: 'antigravity-cli' } })

  assert.equal(removed.hooks[0].changed, true)
  assert.equal(removed.notifyRemoved, false)
  assert.deepEqual(JSON.parse(fs.files.get(paths.antigravitySettingsPath)), originalSettings)
  assert.equal(fs.files.has(paths.antigravityOriginalStatuslinePath), false)
})

test('removes TokenBoard Antigravity statusLine when no original command existed', () => {
  const paths = createPaths()
  const fs = memoryFs({
    [paths.antigravitySettingsPath]: JSON.stringify({ other: true }),
    [paths.antigravityOriginalStatuslinePath]: JSON.stringify({ statusLine: { command: 'stale' } })
  })

  installHooks({ paths, fs, nodePath: '/usr/bin/node', flags: { source: 'antigravity-cli' } })
  assert.equal(fs.files.has(paths.antigravityOriginalStatuslinePath), false)

  uninstallHooks({ paths, fs, flags: { source: 'antigravity-cli' } })

  assert.deepEqual(JSON.parse(fs.files.get(paths.antigravitySettingsPath)), { other: true })
})

test('fails visibly when Antigravity statusLine has an unsupported format', () => {
  const paths = createPaths()
  const fs = memoryFs({
    [paths.antigravitySettingsPath]: JSON.stringify({ statusLine: 'bad' })
  })

  assert.throws(
    () => installHooks({ paths, fs, nodePath: '/usr/bin/node', flags: { source: 'antigravity-cli' } }),
    /Unsupported Antigravity statusLine format/
  )
})

function createPaths() {
  return {
    stateDir: '/home/user/.tokenboard',
    binDir: '/home/user/.tokenboard/bin',
    notifyPath: '/home/user/.tokenboard/bin/notify.cjs',
    notifyScriptPath: '/repo/scripts/notify.mjs',
    statuslineScriptPath: '/repo/scripts/antigravity-statusline.mjs',
    codexConfigPath: '/home/user/.codex/config.toml',
    codexOriginalPath: '/home/user/.tokenboard/codex_notify_original.json',
    claudeSettingsPath: '/home/user/.claude/settings.json',
    antigravitySettingsPath: '/home/user/.gemini/antigravity-cli/settings.json',
    antigravityOriginalStatuslinePath: '/home/user/.tokenboard/antigravity_statusline_original.json'
  }
}

function memoryFs(initial = {}) {
  const files = new Map(Object.entries(initial))
  return {
    files,
    mkdir: () => {},
    readFile: (path) => {
      if (!files.has(path)) {
        const error = new Error(`ENOENT: ${path}`)
        error.code = 'ENOENT'
        throw error
      }
      return files.get(path)
    },
    writeFile: (path, value) => {
      files.set(path, String(value))
    },
    unlink: (path) => {
      if (!files.delete(path)) {
        const error = new Error(`ENOENT: ${path}`)
        error.code = 'ENOENT'
        throw error
      }
    }
  }
}
