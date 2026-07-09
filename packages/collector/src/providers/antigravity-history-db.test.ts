import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
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

      expect(await readFile(queryPath, 'utf8')).toBe('select idx, hex(data) from gen_metadata where idx > 41 order by idx limit 500')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('pages large metadata backlogs and advances the row cursor between sqlite calls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-paged-db-'))
    try {
      const dir = join(root, 'conversations')
      const sqliteBin = join(root, 'sqlite3-paged.sh')
      const queriesPath = join(root, 'queries.sql')
      const cascadeId = '00000000-0000-0000-0000-000000000001'
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `${cascadeId}.db`), '')
      await writeFile(sqliteBin, [
        '#!/bin/sh',
        `printf '%s\\n' "$3" >> ${JSON.stringify(queriesPath)}`,
        'case "$3" in',
        '  *"idx > 41 "*)',
        '    i=42',
        '    while [ "$i" -le 541 ]; do',
        '      printf "%s|\\n" "$i"',
        '      i=$((i + 1))',
        '    done',
        '    ;;',
        '  *"idx > 541 "*)',
        '    printf "542|\\n"',
        '    ;;',
        'esac'
      ].join('\n'))
      await chmod(sqliteBin, 0o755)

      const result = await readAntigravityDbUsageEvents({
        conversationDir: dir,
        sqliteBin,
        lastSeenRowIndexByCascadeHash: new Map([[hash(cascadeId), 41]])
      })

      expect((await readFile(queriesPath, 'utf8')).trim().split('\n')).toEqual([
        'select idx, hex(data) from gen_metadata where idx > 41 order by idx limit 500',
        'select idx, hex(data) from gen_metadata where idx > 541 order by idx limit 500'
      ])
      expect(result.events).toHaveLength(0)
      expect(result.lastReadRowIndexByCascade?.get(cascadeId)).toBe(542)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('reads only the most recent bounded db files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-recent-db-'))
    try {
      const dir = join(root, 'conversations')
      const sqliteBin = join(root, 'sqlite3-recent.sh')
      const callsPath = join(root, 'calls.txt')
      const oldCascadeId = '00000000-0000-0000-0000-000000000001'
      const middleCascadeId = '00000000-0000-0000-0000-000000000002'
      const recentCascadeId = '00000000-0000-0000-0000-000000000003'
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `${oldCascadeId}.db`), '')
      await writeFile(join(dir, `${middleCascadeId}.db`), '')
      await writeFile(join(dir, `${recentCascadeId}.db`), '')
      await utimes(join(dir, `${oldCascadeId}.db`), new Date('2026-04-28T10:00:00.000Z'), new Date('2026-04-28T10:00:00.000Z'))
      await utimes(join(dir, `${middleCascadeId}.db`), new Date('2026-04-28T10:01:00.000Z'), new Date('2026-04-28T10:01:00.000Z'))
      await utimes(join(dir, `${recentCascadeId}.db`), new Date('2026-04-28T10:02:00.000Z'), new Date('2026-04-28T10:02:00.000Z'))
      await writeFile(sqliteBin, [
        '#!/bin/sh',
        `printf '%s\\n' "$2" >> ${JSON.stringify(callsPath)}`,
        'printf ""'
      ].join('\n'))
      await chmod(sqliteBin, 0o755)

      await readAntigravityDbUsageEvents({
        conversationDir: dir,
        sqliteBin,
        maxDbFiles: 2
      })

      const calls = (await readFile(callsPath, 'utf8')).trim().split('\n')
      expect(calls).toEqual([
        join(dir, `${recentCascadeId}.db`),
        join(dir, `${middleCascadeId}.db`)
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('skips db files that cannot be statted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-stat-race-'))
    try {
      const dir = join(root, 'conversations')
      const sqliteBin = join(root, 'sqlite3-stat-race.sh')
      const callsPath = join(root, 'calls.txt')
      const skippedCascadeId = '00000000-0000-0000-0000-000000000004'
      const keptCascadeId = '00000000-0000-0000-0000-000000000005'
      const skippedDb = join(dir, `${skippedCascadeId}.db`)
      const keptDb = join(dir, `${keptCascadeId}.db`)
      await mkdir(dir, { recursive: true })
      await writeFile(skippedDb, '')
      await writeFile(keptDb, '')
      await writeFile(sqliteBin, [
        '#!/bin/sh',
        `printf '%s\\n' "$2" >> ${JSON.stringify(callsPath)}`,
        'printf ""'
      ].join('\n'))
      await chmod(sqliteBin, 0o755)

      await readAntigravityDbUsageEvents({
        conversationDir: dir,
        sqliteBin,
        statFile: async (filePath) => {
          if (filePath === skippedDb) throw new Error('file disappeared')
          return { mtimeMs: filePath === keptDb ? 2000 : 1000 }
        }
      })

      const calls = (await readFile(callsPath, 'utf8')).trim().split('\n')
      expect(calls).toEqual([keptDb])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex')
}
