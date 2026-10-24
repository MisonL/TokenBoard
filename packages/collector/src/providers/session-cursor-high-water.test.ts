import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { collectChangedSessionFiles } from './session-cursor'

async function writeSession(file: string, content: string, mtimeMs: number) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content)
  const date = new Date(mtimeMs)
  await utimes(file, date, date)
}

async function scan(sessionsDir: string, cursorPath: string) {
  const result = await collectChangedSessionFiles({ source: 'codex', sessionsDir, cursorPath })
  for (const file of result.files) {
    for await (const _line of file.readLines()) {
      // Drain, so `commit` is allowed to run.
    }
  }
  await result.commit()
  return result
}

describe('session scan high-water mark', () => {
  // The high-water mark is the cutoff the next scan subtracts its safety window from, and
  // `skipByMetadata` drops any file older than it *before reading*. Taking the maximum mtime
  // over every scanned file therefore lets one file with a future timestamp — a clock step, a
  // restored backup, `touch -d` — raise the cutoff above files that were never read. They are
  // then skipped on every later scan, and the mark only ever grows, so deleting the offending
  // file does not recover: the usage is simply gone, with `hasPendingUpload` false and the sync
  // reporting success. Clamping to the present keeps the mark honest about what it covers.
  test('does not let a future-dated file hide sessions that arrive later', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-high-water-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const skewed = join(sessionsDir, '2026', '05', '22', 'skewed.jsonl')
    const real = join(sessionsDir, '2026', '05', '23', 'real.jsonl')

    try {
      await writeSession(skewed, '{"a":1}\n', Date.now() + 7 * 86_400_000)
      expect((await scan(sessionsDir, cursorPath)).files.map((file) => file.relativePath)).toEqual([
        '2026/05/22/skewed.jsonl'
      ])

      await writeSession(real, '{"b":2}\n', Date.now() - 60_000)

      // The new file must be collected on the next scan, and keep being collected until read.
      expect((await scan(sessionsDir, cursorPath)).files.map((file) => file.relativePath)).toEqual([
        '2026/05/23/real.jsonl'
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('records a high-water mark that does not run ahead of the clock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-high-water-cap-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const skewed = join(sessionsDir, '2026', '05', '22', 'skewed.jsonl')

    try {
      const future = Date.now() + 7 * 86_400_000
      await writeSession(skewed, '{"a":1}\n', future)
      await scan(sessionsDir, cursorPath)

      const cursor = JSON.parse(await readCursorFile(cursorPath))
      expect(cursor.lastScanHighWaterMs).toBeLessThanOrEqual(Date.now())
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function readCursorFile(cursorPath: string) {
  const { readFile } = await import('node:fs/promises')
  return readFile(cursorPath, 'utf8')
}
