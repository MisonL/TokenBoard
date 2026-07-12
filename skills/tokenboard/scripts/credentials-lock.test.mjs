import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { restoreCredentialsLock } from './credentials-lock.mjs'

test('stale lock rollback never overwrites a replacement owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-credentials-lock-'))
  const lockPath = join(root, 'device-link.json.lock')
  const quarantinePath = `${lockPath}.stale`
  try {
    await writeFile(lockPath, JSON.stringify({ pid: 300, token: 'replacement' }))
    await writeFile(quarantinePath, JSON.stringify({ pid: 200, token: 'displaced' }))

    restoreCredentialsLock(lockPath, quarantinePath)

    assert.deepEqual(JSON.parse(await readFile(lockPath, 'utf8')), {
      pid: 300,
      token: 'replacement'
    })
    await assert.rejects(readFile(quarantinePath, 'utf8'), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
