import { mkdtemp, readFile, readdir, rm, writeFile as writeRawFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { readCursor, withCursorLock, writeCursor } from './session-cursor-store'

describe('session cursor store concurrency', () => {
  test('waits for an in-flight heartbeat before releasing the cursor lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-heartbeat-release-'))
    const cursorPath = join(root, 'codex-cursor.json')
    const heartbeatStarted = deferred<void>()
    const releaseHeartbeat = deferred<void>()
    let settled = false
    try {
      const operation = withCursorLock(cursorPath, async () => {
        await delay(30)
      }, {
        heartbeatIntervalMs: 1,
        refreshCursorLock: async () => {
          heartbeatStarted.resolve()
          await releaseHeartbeat.promise
        }
      }).finally(() => {
        settled = true
      })

      await delay(40)
      try {
        expect(heartbeatStarted.settled()).toBe(true)
        expect(settled).toBe(false)
      } finally {
        releaseHeartbeat.resolve()
        await operation
      }
      await expect(readFile(`${cursorPath}.lock`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      releaseHeartbeat.resolve()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('serializes the complete cursor read-modify-write interval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-lock-'))
    const cursorPath = join(root, 'codex-cursor.json')
    try {
      await Promise.all(Array.from({ length: 12 }, async (_, index) => {
        await withCursorLock(cursorPath, async () => {
          const cursor = await readCursor(cursorPath, 'codex')
          await new Promise((resolve) => setTimeout(resolve, 5))
          cursor.files[`session-${index}`] = {
            size: index,
            mtimeMs: index,
            sha256: String(index),
            snapshots: [],
            missingCost: false,
            updatedAt: '2026-07-12T00:00:00.000Z'
          }
          await writeCursor(cursorPath, cursor)
        })
      }))

      const cursor = await readCursor(cursorPath, 'codex')
      expect(Object.keys(cursor.files)).toHaveLength(12)
      expect((await readdir(root)).filter((name) => name.includes('.tmp-'))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('preserves callback errors when lock ownership changes during cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-lock-error-'))
    const cursorPath = join(root, 'codex-cursor.json')
    try {
      await expect(withCursorLock(cursorPath, async () => {
        await writeCursor(`${cursorPath}.lock`, {
          version: 1,
          source: 'codex',
          files: {}
        })
        throw new Error('callback failed')
      })).rejects.toThrow('callback failed')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects a cursor write after lock ownership is lost', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-lock-fence-'))
    const cursorPath = join(root, 'codex-cursor.json')
    try {
      await expect(withCursorLock(cursorPath, async () => {
        await writeRawFile(`${cursorPath}.lock`, JSON.stringify({ pid: process.pid, token: 'replacement' }))
        await writeCursor(cursorPath, { version: 1, source: 'codex', files: {} })
      })).rejects.toThrow('Cursor lock ownership changed before write')
      await expect(readFile(cursorPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function deferred<T>() {
  let isSettled = false
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = (value) => {
      isSettled = true
      resolvePromise(value)
    }
  })
  return { promise, resolve, settled: () => isSettled }
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
