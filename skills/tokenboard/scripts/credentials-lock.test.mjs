import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { restoreCredentialsLock } from './credentials-lock.mjs'

test('stale lock rollback preserves both owners and reports the conflict', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-credentials-lock-'))
  const lockPath = join(root, 'device-link.json.lock')
  const quarantinePath = `${lockPath}.stale`
  try {
    await writeFile(lockPath, JSON.stringify({ pid: 300, token: 'replacement' }))
    await writeFile(quarantinePath, JSON.stringify({ pid: 200, token: 'displaced' }))

    assert.throws(
      () => restoreCredentialsLock(lockPath, quarantinePath),
      /replacement credentials lock could not be restored/
    )

    assert.deepEqual(JSON.parse(await readFile(lockPath, 'utf8')), {
      pid: 300,
      token: 'replacement'
    })
    assert.deepEqual(JSON.parse(await readFile(quarantinePath, 'utf8')), {
      pid: 200,
      token: 'displaced'
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
