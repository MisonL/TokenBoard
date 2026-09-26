import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { collectChangedSessionFiles, updateCursorFile } from './session-cursor'
import type { CursorState } from './session-cursor-store'
import { sessionContentHashAlgorithm } from './session-content-hash'
import type { SessionJsonlLine } from './session-jsonl-line-reader'

// Changing the content-fingerprint algorithm must not disturb a cursor written by an
// older collector: those entries hold a sha256 digest and no algorithm name. The
// upgrade has to stay silent, keep every pending snapshot, and converge on the new
// algorithm without a migration step.
describe('session content hash algorithm upgrade', () => {
  test('writes the algorithm name alongside a fresh digest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-hash-upgrade-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    try {
      await writeSession(join(sessionsDir, 'session.jsonl'), '{"a":1}\n')

      const result = await collectChangedSessionFiles({ source: 'codex', sessionsDir, cursorPath })
      await consumeFiles(result.files)
      await result.commit()

      const cursor = JSON.parse(await readFile(cursorPath, 'utf8'))
      expect(cursor.version).toBe(1)
      expect(cursor.files['session.jsonl'].contentHashAlgo).toBe(sessionContentHashAlgorithm)
      // blake2b512 is 128 hex characters; the legacy digest was 64.
      expect(cursor.files['session.jsonl'].sha256).toMatch(/^[a-f0-9]{128}$/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('accepts a legacy cursor entry that has no algorithm name and upgrades it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-hash-legacy-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    try {
      const file = join(sessionsDir, 'session.jsonl')
      await writeSession(file, '{"a":1}\n')
      // A cursor exactly as an older collector would have left it.
      await writeLegacyCursor(cursorPath, {
        size: 8,
        mtimeMs: 1,
        sha256: 'a'.repeat(64)
      })

      // Must not throw 'Invalid codex cursor file'.
      const result = await collectChangedSessionFiles({ source: 'codex', sessionsDir, cursorPath })
      // The stored digest came from another algorithm, so the entry cannot be trusted
      // as unchanged: it is re-read once and upgraded in place.
      expect(result.files.map((entry) => entry.relativePath)).toEqual(['session.jsonl'])
      await consumeFiles(result.files)
      await result.commit()

      const cursor = JSON.parse(await readFile(cursorPath, 'utf8'))
      expect(cursor.files['session.jsonl'].contentHashAlgo).toBe(sessionContentHashAlgorithm)
      expect(cursor.files['session.jsonl'].sha256).toMatch(/^[a-f0-9]{128}$/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // A legacy entry on a file that has since grown takes the append-only path, which
  // collectChangedSessionFiles only stages an entry; the snapshot merge happens in
  // updateCursorFile. An upgrade must not disturb that merge, so a legacy entry is
  // exercised through the same call the hook flow makes.
  test('keeps pending snapshots when an upgraded legacy entry is committed', () => {
    const pendingSnapshot = {
      source: 'codex' as const,
      usageDate: '2026-05-22',
      timezone: 'UTC',
      model: 'gpt-5',
      inputTokens: 10,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 10,
      costUsd: 0,
      sessionCount: 1
    }
    const cursor: CursorState = {
      version: 1,
      source: 'codex',
      files: {
        'session.jsonl': {
          size: 3,
          mtimeMs: 1,
          sha256: 'b'.repeat(64),
          endsWithNewline: true,
          snapshots: [pendingSnapshot],
          missingCost: false,
          pendingUpload: true,
          updatedAt: '2026-05-22T10:00:00.000Z'
        }
      }
    }

    // The commit an append-only sync performs on a legacy entry.
    updateCursorFile(
      cursor,
      {
        relativePath: 'session.jsonl',
        size: 20,
        mtimeMs: 2,
        sha256: 'c'.repeat(128),
        endsWithNewline: true,
        appendOnly: true
      },
      { snapshots: [], missingCost: false },
      '2026-05-23T10:00:00.000Z'
    )

    // The retained snapshot must survive, and the entry must record the algorithm so
    // a later sync can compare digests again.
    expect(cursor.files['session.jsonl'].snapshots).toEqual([pendingSnapshot])
    expect(cursor.files['session.jsonl'].pendingUpload).toBe(true)
    expect(cursor.files['session.jsonl'].contentHashAlgo).toBe(sessionContentHashAlgorithm)
  })

  // A legacy entry whose file has grown satisfies every other append-only condition,
  // so this is where the recorded algorithm decides which read path runs. Both paths
  // stay correct — a mismatched comparison simply falls through to the full read — but
  // the entry must come out carrying the current algorithm so later syncs can compare
  // digests again instead of re-reading forever.
  test('re-reads a grown legacy entry once and records the current algorithm', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-hash-grown-legacy-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    try {
      const file = join(sessionsDir, 'session.jsonl')
      await writeSession(file, '{"a":1}\n{"b":2}\n')
      // Legacy entry describing the first line only, newline-terminated, not pending:
      // every append-only condition holds except the recorded algorithm.
      await writeLegacyCursor(cursorPath, {
        size: Buffer.byteLength('{"a":1}\n'),
        mtimeMs: 1,
        sha256: 'd'.repeat(64)
      })

      const result = await collectChangedSessionFiles({ source: 'codex', sessionsDir, cursorPath })
      await consumeFiles(result.files)
      await result.commit()

      const cursor = JSON.parse(await readFile(cursorPath, 'utf8'))
      expect(cursor.files['session.jsonl'].contentHashAlgo).toBe(sessionContentHashAlgorithm)
      expect(cursor.files['session.jsonl'].sha256).toMatch(/^[a-f0-9]{128}$/)

      // Once upgraded, the entry is unchanged and no further read is needed.
      const again = await collectChangedSessionFiles({ source: 'codex', sessionsDir, cursorPath })
      expect(again.files).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('treats an entry written with the current algorithm as unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-hash-roundtrip-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    try {
      await writeSession(join(sessionsDir, 'session.jsonl'), '{"a":1}\n')
      const first = await collectChangedSessionFiles({ source: 'codex', sessionsDir, cursorPath })
      await consumeFiles(first.files)
      await first.commit()
      const digest = JSON.parse(await readFile(cursorPath, 'utf8')).files['session.jsonl'].sha256

      const second = await collectChangedSessionFiles({ source: 'codex', sessionsDir, cursorPath })

      expect(second.files).toEqual([])
      const after = JSON.parse(await readFile(cursorPath, 'utf8'))
      expect(after.files['session.jsonl'].sha256).toBe(digest)
      expect(after.files['session.jsonl'].contentHashAlgo).toBe(sessionContentHashAlgorithm)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('still detects an append to a file fingerprinted with the current algorithm', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-hash-append-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    try {
      const file = join(sessionsDir, 'session.jsonl')
      await writeSession(file, '{"a":1}\n')
      const first = await collectChangedSessionFiles({ source: 'codex', sessionsDir, cursorPath })
      await consumeFiles(first.files)
      await first.commit()

      // Append a line and advance mtime so the append-only path engages.
      await writeFile(file, '{"a":1}\n{"b":2}\n')
      const later = new Date(Date.now() + 60_000)
      await utimes(file, later, later)

      const result = await collectChangedSessionFiles({ source: 'codex', sessionsDir, cursorPath })

      expect(result.files).toHaveLength(1)
      const lines: string[] = []
      for await (const line of result.files[0].readLines() as AsyncIterable<SessionJsonlLine>) {
        if (typeof line === 'string') lines.push(line)
      }
      expect(lines).toEqual(['{"b":2}'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function writeSession(file: string, content: string) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content)
}

async function writeLegacyCursor(
  cursorPath: string,
  entry: Record<string, unknown> & { size: number; mtimeMs: number; sha256: string }
) {
  await writeFile(
    cursorPath,
    JSON.stringify({
      version: 1,
      source: 'codex',
      files: {
        'session.jsonl': {
          endsWithNewline: true,
          snapshots: [],
          missingCost: false,
          updatedAt: '2026-05-22T10:00:00.000Z',
          ...entry
        }
      }
    })
  )
}

async function consumeFiles(files: Array<{ readLines: () => AsyncIterable<SessionJsonlLine> }>) {
  for (const file of files) {
    for await (const _line of file.readLines()) {
    }
  }
}
