import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { supportsReliableSignalZero } from './antigravity-statusline-log.mjs'

test('statusline lock avoids broken Windows signal-zero Node releases', () => {
  assert.equal(supportsReliableSignalZero('darwin', '22.12.0'), true)
  assert.equal(supportsReliableSignalZero('win32', '22.12.0'), false)
  assert.equal(supportsReliableSignalZero('win32', '22.16.0'), true)
  assert.equal(supportsReliableSignalZero('win32', '23.11.0'), false)
  assert.equal(supportsReliableSignalZero('win32', '24.0.0'), true)
})

test('statusline log recovers an expired lock when Windows signal-zero is unreliable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-statusline-windows-orphan-'))
  try {
    const sourcePath = fileURLToPath(new URL('./antigravity-statusline-log.mjs', import.meta.url))
    const modulePath = join(root, 'antigravity-statusline-log.mjs')
    const source = (await readFile(sourcePath, 'utf8'))
      .replace(/const lockWaitTimeoutMs = [^\n]+/, 'const lockWaitTimeoutMs = 100')
      .replace(/const unreliableSignalZeroLeaseMs = [^\n]+/, 'const unreliableSignalZeroLeaseMs = 200')
      .replace('supportsReliableSignalZero(process.platform, process.versions.node)', 'false')
    await writeFile(modulePath, source)

    const logPath = join(root, 'events.jsonl')
    const lockPath = `${logPath}.lock`
    await mkdir(lockPath)
    await writeFile(join(lockPath, 'pid'), String(process.pid))
    const module = await import(`${pathToFileURL(modulePath).href}?windows-orphan-test`)
    assert.throws(
      () => module.appendBoundedStatuslineEvent(logPath, { value: 'not-written' }, 1024),
      /Timed out waiting for Antigravity statusline log lock/
    )
    assert.equal(await readFile(join(lockPath, 'pid'), 'utf8'), String(process.pid))

    const expiredAt = new Date(Date.now() - 1_000)
    await utimes(lockPath, expiredAt, expiredAt)
    module.appendBoundedStatuslineEvent(logPath, { value: 'recovered-on-windows' }, 1024)

    assert.match(await readFile(logPath, 'utf8'), /recovered-on-windows/)
    await assert.rejects(stat(lockPath), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
