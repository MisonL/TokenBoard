import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const refreshScriptPath = fileURLToPath(new URL('./refresh-notify-handler.mjs', import.meta.url))

test('refresh handler CLI updates an already installed Codex hook without changing its config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-refresh-notify-handler-'))
  const codexHome = join(root, 'codex')
  const notifyPath = join(root, 'bin', 'notify.cjs')
  const configPath = join(codexHome, 'config.toml')
  const codexConfig = `model = "gpt-5"\nnotify = ["/usr/bin/env", "node", ${JSON.stringify(notifyPath)}, "--source=codex"]\n`

  try {
    await mkdir(codexHome, { recursive: true })
    await mkdir(join(root, 'bin'), { recursive: true })
    await writeFile(configPath, codexConfig)
    await writeFile(notifyPath, 'old handler')

    const result = spawnSync(process.execPath, [refreshScriptPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        TOKENBOARD_CONFIG_DIR: root,
        CODEX_HOME: codexHome,
        CLAUDE_CONFIG_DIR: join(root, 'claude')
      }
    })

    assert.equal(result.status, 0, result.stderr)
    assert.equal(await readFile(configPath, 'utf8'), codexConfig)
    const handler = await readFile(notifyPath, 'utf8')
    assert.match(handler, /TOKENBOARD_NOTIFY_DISPATCH_LOCK_TOKEN/)
    // The refresh must leave a working launcher behind and point the handler at it.
    await readFile(join(root, 'bin', 'tokenboard-launcher.mjs'), 'utf8')
    await readFile(join(root, 'bin', 'launcher-runtime.mjs'), 'utf8')
    assert.match(handler, /const NOTIFY_SCRIPT = .*tokenboard-launcher\.mjs/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
