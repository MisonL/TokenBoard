import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { readAntigravityDbUsageEvents } from './antigravity-history-db'

describe('readAntigravityDbUsageEvents', () => {
  test('fails visibly when the conversations directory is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-missing-db-'))
    try {
      await expect(readAntigravityDbUsageEvents({
        conversationDir: join(root, 'missing')
      })).rejects.toThrow(`Antigravity conversations directory not found: ${join(root, 'missing')}`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not mark cascades as covered when no usable events are parsed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-empty-db-'))
    try {
      const dir = join(root, 'conversations')
      const sqliteBin = join(root, 'sqlite3-empty.sh')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'conversation-a.db'), '')
      await writeFile(sqliteBin, '#!/bin/sh\nprintf ""\n')
      await chmod(sqliteBin, 0o755)
      const result = await readAntigravityDbUsageEvents({
        conversationDir: dir,
        sqliteBin
      })

      expect(result.events).toHaveLength(0)
      expect(result.cascadeIds).toHaveLength(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
