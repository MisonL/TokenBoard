import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { readCursor, withCursorLock, writeCursor } from './session-cursor-store'

describe('session cursor store concurrency', () => {
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
})
