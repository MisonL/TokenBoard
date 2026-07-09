import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
      const cascadeId = '00000000-0000-0000-0000-000000000001'
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `${cascadeId}.db`), '')
      await writeFile(sqliteBin, '#!/bin/sh\nprintf "7|\\n"\n')
      await chmod(sqliteBin, 0o755)
      const result = await readAntigravityDbUsageEvents({
        conversationDir: dir,
        sqliteBin
      })

      expect(result.events).toHaveLength(0)
      expect(result.cascadeIds).toHaveLength(0)
      expect(result.lastReadRowIndexByCascade?.get(cascadeId)).toBe(7)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('bounds metadata reads by the stored per-cascade row cursor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-bounded-db-'))
    try {
      const dir = join(root, 'conversations')
      const sqliteBin = join(root, 'sqlite3-query.sh')
      const queryPath = join(root, 'query.sql')
      const cascadeId = '00000000-0000-0000-0000-000000000001'
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `${cascadeId}.db`), '')
      await writeFile(sqliteBin, [
        '#!/bin/sh',
        `printf '%s' "$3" > ${JSON.stringify(queryPath)}`,
        'printf ""'
      ].join('\n'))
      await chmod(sqliteBin, 0o755)

      await readAntigravityDbUsageEvents({
        conversationDir: dir,
        sqliteBin,
        lastSeenRowIndexByCascadeHash: new Map([[hash(cascadeId), 41]])
      })

      expect(await readFile(queryPath, 'utf8')).toBe('select idx, hex(data) from gen_metadata where idx > 41 order by idx')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex')
}
