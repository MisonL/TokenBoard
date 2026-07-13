import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { readAntigravityDbUsageEvents } from './antigravity-history-db'
import type { AntigravityFileScanState } from './antigravity-file-scan'

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

  test('fails visibly instead of truncating database directories beyond the safety bound', async () => {
    let listed = 0

    await expect(readAntigravityDbUsageEvents({
      conversationDir: '/tmp/tokenboard-antigravity-overflow-databases',
      maxDbFiles: 2,
      listFiles: async function * () {
        for (let index = 0; index <= 10_000; index += 1) {
          listed += 1
          yield { name: `${cascadeId(index)}.db`, isFile: () => true }
        }
      },
      statFile: async () => ({ mtimeMs: 1 })
    })).rejects.toThrow('Antigravity conversations directory exceeds the 10000-entry scan limit')
    expect(listed).toBe(10_001)
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

  test('records a successful empty database scan so bounded backlog selection can advance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-empty-db-cursor-'))
    try {
      const dir = join(root, 'conversations')
      const sqliteBin = join(root, 'sqlite3-no-rows.sh')
      const cascadeId = '00000000-0000-0000-0000-000000000001'
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `${cascadeId}.db`), '')
      await writeFile(sqliteBin, '#!/bin/sh\nprintf ""\n')
      await chmod(sqliteBin, 0o755)

      const result = await readAntigravityDbUsageEvents({
        conversationDir: dir,
        sqliteBin
      })

      expect(result.lastReadRowIndexByCascade?.get(cascadeId)).toBe(-1)
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

  test('does not acknowledge a row when a nested SQLite usage block is semantically invalid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-invalid-nested-db-'))
    try {
      const dir = join(root, 'conversations')
      const sqliteBin = join(root, 'sqlite3-invalid-nested.sh')
      const queriesPath = join(root, 'queries.sql')
      const cascadeId = '00000000-0000-0000-0000-000000000001'
      const lastSeenRowIndexByCascadeHash = new Map([[hash(cascadeId), 41]])
      const invalidNestedUsageHex = '0A472216100A18025A10726573706F6E73652D7072696D6172798A01191217108194EBDC035A0F726573706F6E73652D6E65737465649A011067656D696E692D332D666C6173682D61220B657865637574696F6E2D61'
      const query = 'select idx, hex(data) from gen_metadata where idx > 41 order by idx limit 500'
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `${cascadeId}.db`), '')
      await writeFile(sqliteBin, [
        '#!/bin/sh',
        `printf '%s\\n' "$3" >> ${JSON.stringify(queriesPath)}`,
        `printf '%s\\n' ${JSON.stringify(`42|${invalidNestedUsageHex}`)}`
      ].join('\n'))
      await chmod(sqliteBin, 0o755)

      const read = () => readAntigravityDbUsageEvents({
        conversationDir: dir,
        sqliteBin,
        lastSeenRowIndexByCascadeHash
      })

      await expect(read()).rejects.toThrow('token field 2 is invalid')
      await expect(read()).rejects.toThrow('token field 2 is invalid')

      expect(lastSeenRowIndexByCascadeHash.get(hash(cascadeId))).toBe(41)
      expect((await readFile(queriesPath, 'utf8')).trim().split('\n')).toEqual([query, query])
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

  test('prioritizes unread database backlog before revisiting recent files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-db-backlog-'))
    try {
      const dir = join(root, 'conversations')
      const sqliteBin = join(root, 'sqlite3-backlog.sh')
      const callsPath = join(root, 'calls.txt')
      const oldCascadeId = '00000000-0000-0000-0000-000000000001'
      const middleCascadeId = '00000000-0000-0000-0000-000000000002'
      const recentCascadeId = '00000000-0000-0000-0000-000000000003'
      const oldDb = join(dir, `${oldCascadeId}.db`)
      const middleDb = join(dir, `${middleCascadeId}.db`)
      const recentDb = join(dir, `${recentCascadeId}.db`)
      await mkdir(dir, { recursive: true })
      await writeFile(oldDb, '')
      await writeFile(middleDb, '')
      await writeFile(recentDb, '')
      await utimes(oldDb, new Date('2026-04-28T10:00:00.000Z'), new Date('2026-04-28T10:00:00.000Z'))
      await utimes(middleDb, new Date('2026-04-28T10:01:00.000Z'), new Date('2026-04-28T10:01:00.000Z'))
      await utimes(recentDb, new Date('2026-04-28T10:02:00.000Z'), new Date('2026-04-28T10:02:00.000Z'))
      await writeFile(sqliteBin, [
        '#!/bin/sh',
        `printf '%s\\n' "$2" >> ${JSON.stringify(callsPath)}`,
        'printf ""'
      ].join('\n'))
      await chmod(sqliteBin, 0o755)

      const first = await readAntigravityDbUsageEvents({
        conversationDir: dir,
        sqliteBin,
        maxDbFiles: 2
      })
      expect((await readFile(callsPath, 'utf8')).trim().split('\n')).toEqual([recentDb, middleDb])
      const acknowledgedRows = new Map(
        [...(first.lastReadRowIndexByCascade ?? [])].map(([cascadeId, rowIndex]) => [hash(cascadeId), rowIndex])
      )
      await writeFile(callsPath, '')

      await readAntigravityDbUsageEvents({
        conversationDir: dir,
        sqliteBin,
        maxDbFiles: 2,
        lastSeenRowIndexByCascadeHash: acknowledgedRows
      })

      expect((await readFile(callsPath, 'utf8')).trim().split('\n')).toEqual([oldDb, recentDb])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('reserves read capacity for processed databases while unread files remain', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-db-read-fairness-'))
    try {
      const dir = join(root, 'conversations')
      const sqliteBin = join(root, 'sqlite3-read-fairness.sh')
      const callsPath = join(root, 'calls.txt')
      const unreadOldId = cascadeId(1)
      const unreadNewId = cascadeId(2)
      const processedId = cascadeId(3)
      await mkdir(dir, { recursive: true })
      for (const id of [unreadOldId, unreadNewId, processedId]) {
        await writeFile(join(dir, `${id}.db`), '')
      }
      await writeFile(sqliteBin, [
        '#!/bin/sh',
        `printf '%s\n' "$2" >> ${JSON.stringify(callsPath)}`,
        'printf ""'
      ].join('\n'))
      await chmod(sqliteBin, 0o755)

      await readAntigravityDbUsageEvents({
        conversationDir: dir,
        sqliteBin,
        maxDbFiles: 2,
        lastSeenRowIndexByCascadeHash: new Map([[hash(processedId), 0]]),
        statFile: async (filePath) => ({
          mtimeMs: Number(basename(filePath, '.db').slice(-12))
        })
      })

      expect((await readFile(callsPath, 'utf8')).trim().split('\n')).toEqual([
        join(dir, `${unreadNewId}.db`),
        join(dir, `${processedId}.db`)
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('bounds db metadata stats while selecting recent files from a large directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-db-bounded-stat-'))
    try {
      const dir = join(root, 'conversations')
      const sqliteBin = join(root, 'sqlite3-bounded-stat.sh')
      const callsPath = join(root, 'calls.txt')
      const scanState: AntigravityFileScanState = { nextSequence: 0, files: {} }
      await mkdir(dir, { recursive: true })
      for (let index = 0; index < 200; index += 1) {
        await writeFile(join(dir, `${cascadeId(index)}.db`), '')
      }
      await writeFile(sqliteBin, [
        '#!/bin/sh',
        `printf '%s\n' "$2" >> ${JSON.stringify(callsPath)}`,
        'printf ""'
      ].join('\n'))
      await chmod(sqliteBin, 0o755)
      let statCount = 0

      await readAntigravityDbUsageEvents({
        conversationDir: dir,
        sqliteBin,
        maxDbFiles: 2,
        statFile: async (filePath) => {
          statCount += 1
          return { mtimeMs: Number(basename(filePath, '.db').slice(-12)) }
        },
        scanState
      })

      expect(statCount).toBeLessThanOrEqual(16)
      expect((await readFile(callsPath, 'utf8')).trim().split('\n')).toEqual([
        join(dir, `${cascadeId(199)}.db`),
        join(dir, `${cascadeId(198)}.db`)
      ])
      expect(Object.keys(scanState.files)).toHaveLength(16)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rotates bounded db metadata scans until middle files are selected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-db-rotating-stat-'))
    try {
      const sqliteBin = join(root, 'sqlite3-rotating-stat.sh')
      const callsPath = join(root, 'calls.txt')
      const scanState: AntigravityFileScanState = { nextSequence: 0, files: {} }
      await writeFile(sqliteBin, [
        '#!/bin/sh',
        `printf '%s\n' "$2" >> ${JSON.stringify(callsPath)}`,
        'printf ""'
      ].join('\n'))
      await chmod(sqliteBin, 0o755)

      for (let run = 0; run < 24; run += 1) {
        let statCount = 0
        await readAntigravityDbUsageEvents({
          conversationDir: '/tmp/tokenboard-antigravity-rotating-databases',
          sqliteBin,
          maxDbFiles: 2,
          listFiles: async function * () {
            for (let index = 0; index < 200; index += 1) {
              yield { name: `${cascadeId(index)}.db`, isFile: () => true }
            }
          },
          statFile: async (filePath) => {
            statCount += 1
            const index = Number(basename(filePath, '.db').slice(-12))
            return { mtimeMs: index === 100 ? 10_000 : index }
          },
          scanState
        })
        expect(statCount).toBeLessThanOrEqual(16)
      }

      expect(Object.keys(scanState.files)).toHaveLength(200)
      expect((await readFile(callsPath, 'utf8')).split('\n')).toContain(
        join('/tmp/tokenboard-antigravity-rotating-databases', `${cascadeId(100)}.db`)
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('skips db files that disappear before stat', async () => {
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
          if (filePath === skippedDb) {
            throw Object.assign(new Error('file disappeared'), { code: 'ENOENT' })
          }
          return { mtimeMs: filePath === keptDb ? 2000 : 1000 }
        }
      })

      const calls = (await readFile(callsPath, 'utf8')).trim().split('\n')
      expect(calls).toEqual([keptDb])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails visibly when db file metadata cannot be read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-stat-error-'))
    try {
      const dir = join(root, 'conversations')
      const cascade = cascadeId(6)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `${cascade}.db`), '')

      await expect(readAntigravityDbUsageEvents({
        conversationDir: dir,
        statFile: async () => {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
        }
      })).rejects.toThrow('permission denied')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function cascadeId(index: number) {
  return `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`
}
