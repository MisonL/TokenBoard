import { chmod, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { UsageSnapshot } from '@tokenboard/usage-core'
import { describe, expect, test } from 'vitest'
import { pushCliUsageEvent, pushCompleteCliCursorSnapshots } from './antigravity-cli-cursor'
import {
  clearPendingUploadCursors,
  collectChangedSessionFiles,
  mergeSnapshots,
  warmHookCursorHighWater
} from './session-cursor'

const canDenyFileReadWithModeBits = process.platform !== 'win32' && process.getuid?.() !== 0

describe('collectChangedSessionFiles', () => {
  test('returns only new or changed session files after the cursor is written', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const first = join(sessionsDir, '2026', '05', '22', 'first.jsonl')
    const second = join(sessionsDir, '2026', '05', '22', 'second.jsonl')

    try {
      await writeSession(first, 'one', '2026-05-22T01:00:00.000Z')
      let result = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })

      expect(result.files.map((file) => file.relativePath)).toEqual(['2026/05/22/first.jsonl'])
      await result.commit()
      expect(JSON.parse(await readFile(cursorPath, 'utf8')).version).toBe(1)

      result = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })
      expect(result.files).toEqual([])

      await writeSession(second, 'two', '2026-05-22T02:00:00.000Z')
      await writeSession(first, 'one changed', '2026-05-22T03:00:00.000Z')
      result = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })

      expect(result.files.map((file) => file.relativePath)).toEqual([
        '2026/05/22/first.jsonl',
        '2026/05/22/second.jsonl'
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps cursor unchanged when commit is not called', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const file = join(sessionsDir, '2026', '05', '22', 'session.jsonl')

    try {
      await writeSession(file, 'one', '2026-05-22T01:00:00.000Z')
      await collectChangedSessionFiles({
        source: 'claude-code',
        sessionsDir,
        cursorPath
      })

      const result = await collectChangedSessionFiles({
        source: 'claude-code',
        sessionsDir,
        cursorPath
      })

      expect(result.files.map((item) => item.relativePath)).toEqual(['2026/05/22/session.jsonl'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails visibly when cursor files have invalid file maps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const file = join(sessionsDir, '2026', '05', '22', 'session.jsonl')

    try {
      await writeSession(file, 'one', '2026-05-22T01:00:00.000Z')
      await writeFile(cursorPath, JSON.stringify({ version: 1, source: 'codex', files: [] }))
      await expect(collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })).rejects.toThrow('Invalid codex cursor file')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails visibly when cursor files have invalid entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const file = join(sessionsDir, '2026', '05', '22', 'session.jsonl')

    try {
      await writeSession(file, 'one', '2026-05-22T01:00:00.000Z')
      await writeFile(cursorPath, JSON.stringify({
        version: 1,
        source: 'codex',
        files: { 'missing.jsonl': null }
      }))
      await expect(collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })).rejects.toThrow('Invalid codex cursor file')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails visibly when cursor files have invalid cached snapshots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const file = join(sessionsDir, '2026', '05', '22', 'session.jsonl')

    try {
      await writeSession(file, 'one', '2026-05-22T01:00:00.000Z')
      await writeFile(cursorPath, JSON.stringify({
        version: 1,
        source: 'codex',
        files: {
          'old.jsonl': {
            size: 1,
            mtimeMs: 1,
            sha256: 'abc',
            snapshots: [null],
            missingCost: false,
            updatedAt: '2026-05-22T01:00:00.000Z'
          }
        }
      }))
      await expect(collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })).rejects.toThrow('Invalid codex cursor file')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails visibly when cursor high-water is invalid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const file = join(sessionsDir, '2026', '05', '22', 'session.jsonl')

    try {
      await writeSession(file, 'one', '2026-05-22T01:00:00.000Z')
      await writeFile(cursorPath, JSON.stringify({
        version: 1,
        source: 'codex',
        lastScanHighWaterMs: -1,
        files: {}
      }))
      await expect(collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })).rejects.toThrow('Invalid codex cursor file')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails visibly when Antigravity file scan state is invalid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    try {
      await writeFile(cursorPath, JSON.stringify({
        version: 1,
        source: 'codex',
        antigravityDbFileScan: {
          nextSequence: 1,
          files: {
            'raw-conversation-id': {
              mtimeMs: 1,
              size: 1,
              hasDatabaseFile: false,
              checkedSequence: 0
            }
          }
        },
        files: {}
      }))
      await expect(collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })).rejects.toThrow('Invalid codex cursor file')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails visibly when cursor path is not readable as a file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const file = join(sessionsDir, '2026', '05', '22', 'session.jsonl')

    try {
      await writeSession(file, 'one', '2026-05-22T01:00:00.000Z')
      await symlink(sessionsDir, cursorPath, process.platform === 'win32' ? 'junction' : 'dir')

      await expect(collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails visibly when cursor JSON is malformed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const file = join(sessionsDir, '2026', '05', '22', 'session.jsonl')

    try {
      await writeSession(file, 'one', '2026-05-22T01:00:00.000Z')
      await writeFile(cursorPath, '{')

      await expect(collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })).rejects.toThrow('Invalid codex cursor JSON')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('exposes changed session content as a line stream', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const file = join(sessionsDir, '2026', '05', '22', 'session.jsonl')

    try {
      await writeSession(file, 'first\nsecond\n', '2026-05-22T01:00:00.000Z')
      const result = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })

      const lines = []
      for await (const line of result.files[0].readLines()) {
        lines.push(line)
      }

      expect(lines).toEqual(['first', 'second'])
      expect('content' in result.files[0]).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps pending upload files eligible until upload ack clears them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const file = join(sessionsDir, '2026', '05', '22', 'session.jsonl')

    try {
      await writeSession(file, 'one', '2026-05-22T01:00:00.000Z')
      let result = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })

      result.markPendingUpload()
      await result.commit()

      result = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })
      expect(result.files.map((item) => item.relativePath)).toEqual(['2026/05/22/session.jsonl'])

      await clearPendingUploadCursors({ stateDir: root, source: 'codex' })
      result = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath: join(root, 'codex-cursor.json')
      })
      expect(result.files).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('prunes expired acknowledged Antigravity usage state while retaining control cursors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-cursor-retention-'))
    const cursorPath = join(root, 'antigravity-cli-cursor.json')
    const oldTimestamp = Date.parse('2025-01-01T00:00:00.000Z')
    const recentTimestamp = Date.now()
    const entry = (mtimeMs: number, pendingUpload: boolean, snapshots: unknown[] = []) => ({
      size: 0,
      mtimeMs,
      sha256: 'a'.repeat(64),
      snapshots,
      missingCost: true,
      pendingUpload,
      updatedAt: new Date(mtimeMs).toISOString()
    })

    try {
      await writeFile(cursorPath, `${JSON.stringify({
        version: 1,
        source: 'antigravity-cli',
        files: {
          ['history-event\0old\0' + 'b'.repeat(64)]: entry(oldTimestamp, false, [{
            source: 'antigravity-cli',
            usageDate: '2025-01-01',
            timezone: 'UTC',
            model: 'gemini-old',
            inputTokens: 10,
            outputTokens: 2,
            cacheCreationTokens: 0,
            cacheReadTokens: 3,
            totalTokens: 15,
            costUsd: 0,
            sessionCount: 1
          }]),
          ['event\0old-model']: entry(oldTimestamp, false),
          ['session\0old-session']: entry(oldTimestamp, false),
          ['history-event\0recent\0' + 'c'.repeat(64)]: entry(recentTimestamp, true),
          ['db-row\0antigravity-cli\0' + 'd'.repeat(64)]: entry(7, false)
        }
      }, null, 2)}\n`)

      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity-cli' })

      const cursor = JSON.parse(await readFile(cursorPath, 'utf8'))
      expect(Object.keys(cursor.files)).toEqual(expect.arrayContaining([
        'history-event\0old\0' + 'b'.repeat(64),
        'event\0old-model',
        'session\0old-session',
        'history-event\0recent\0' + 'c'.repeat(64),
        'db-row\0antigravity-cli\0' + 'd'.repeat(64)
      ]))
      expect(cursor.files['history-event\0old\0' + 'b'.repeat(64)].snapshots).toEqual([])
      expect(cursor.files['event\0old-model'].snapshots).toEqual([])
      expect(cursor.files['session\0old-session'].snapshots).toEqual([])
      expect(cursor.files['history-event\0old\0' + 'b'.repeat(64)].compactedIdentity).toBe(true)
      expect(cursor.files['event\0old-model'].compactedIdentity).toBe(true)
      expect(cursor.files['session\0old-session'].compactedIdentity).toBe(true)
      expect(cursor.files['history-event\0recent\0' + 'c'.repeat(64)].pendingUpload).toBe(false)
      const entries = Object.values(cursor.files) as Array<{
        snapshots?: Array<{ model: string; totalTokens: number }>
      }>
      expect(entries.some((item) => (
        item.snapshots?.some((snapshot) => snapshot.model === 'gemini-old' && snapshot.totalTokens === 15)
      ))).toBe(true)

      for (const key of [
        'history-event\0old\0' + 'b'.repeat(64),
        'event\0old-model',
        'session\0old-session'
      ]) {
        cursor.files[key].updatedAt = '2025-01-01T00:00:00.000Z'
      }
      await writeFile(cursorPath, `${JSON.stringify(cursor, null, 2)}\n`)
      const compactedCursorText = await readFile(cursorPath, 'utf8')
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity-cli' })
      expect(await readFile(cursorPath, 'utf8')).toBe(compactedCursorText)

      cursor.files['history-event\0late\0' + 'e'.repeat(64)] = entry(recentTimestamp, true, [{
        source: 'antigravity-cli',
        usageDate: '2025-01-01',
        timezone: 'UTC',
        model: 'gemini-old',
        inputTokens: 4,
        outputTokens: 1,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 5,
        costUsd: 0,
        sessionCount: 0
      }])
      const uploadSnapshots: UsageSnapshot[] = []
      pushCompleteCliCursorSnapshots(uploadSnapshots, cursor, new Date().toISOString(), new Set())
      expect(mergeSnapshots(uploadSnapshots)).toEqual([
        expect.objectContaining({ model: 'gemini-old', totalTokens: 20, sessionCount: 1 })
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps compacted Antigravity identities from being counted again after a full rescan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-cursor-replay-'))
    const cursorPath = join(root, 'antigravity-cli-cursor.json')
    const capturedAt = '2025-01-01T10:00:00.000Z'
    const conversationHash = 'a'.repeat(64)
    const eventHash = 'b'.repeat(64)
    const event = {
      capturedAt,
      conversationHash,
      eventHash,
      model: 'gemini-old',
      inputTokens: 10,
      outputTokens: 2,
      cacheCreationTokens: 0,
      cacheReadTokens: 3
    }
    const historyEventKey = ['history-event', conversationHash, eventHash].join('\0')
    const statuslineEventKey = [
      'event',
      conversationHash,
      event.model,
      event.inputTokens,
      event.outputTokens,
      event.cacheCreationTokens,
      event.cacheReadTokens
    ].join('\0')
    const sessionKey = ['session', '2025-01-01', event.model, conversationHash].join('\0')
    const entry = (snapshots: unknown[] = []) => ({
      size: 0,
      mtimeMs: Date.parse(capturedAt),
      sha256: 'c'.repeat(64),
      snapshots,
      missingCost: true,
      pendingUpload: false,
      updatedAt: capturedAt
    })

    try {
      await writeFile(cursorPath, `${JSON.stringify({
        version: 1,
        source: 'antigravity-cli',
        files: {
          [historyEventKey]: entry([{
            source: 'antigravity-cli',
            usageDate: '2025-01-01',
            timezone: 'UTC',
            model: event.model,
            inputTokens: 10,
            outputTokens: 2,
            cacheCreationTokens: 0,
            cacheReadTokens: 3,
            totalTokens: 15,
            costUsd: 0,
            sessionCount: 1
          }]),
          [statuslineEventKey]: entry(),
          [sessionKey]: entry()
        }
      }, null, 2)}\n`)

      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity-cli' })
      const cursor = JSON.parse(await readFile(cursorPath, 'utf8'))
      const replayedSnapshots: UsageSnapshot[] = []
      const emittedKeys = new Set<string>()
      pushCliUsageEvent({
        event,
        cursor,
        snapshots: replayedSnapshots,
        emittedKeys,
        timezone: 'UTC',
        collectedAt: '2026-07-15T10:00:00.000Z',
        origin: 'history'
      })
      pushCompleteCliCursorSnapshots(
        replayedSnapshots,
        cursor,
        '2026-07-15T10:00:00.000Z',
        emittedKeys
      )

      expect(replayedSnapshots).toEqual([])
      expect(cursor.files[historyEventKey]?.snapshots).toEqual([])
      expect(cursor.files[statuslineEventKey]?.snapshots).toEqual([])
      expect(cursor.files[sessionKey]?.snapshots).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps pending Antigravity snapshots outside a bounded acknowledgement range', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-bounded-ack-'))
    const cursorPath = join(root, 'antigravity-cursor.json')
    const snapshot = (usageDate: string) => ({
      source: 'antigravity',
      usageDate,
      timezone: 'UTC',
      model: 'gemini',
      inputTokens: 10,
      outputTokens: 2,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 12,
      costUsd: 0,
      sessionCount: 1
    })
    const entry = (usageDate: string) => ({
      size: 0,
      mtimeMs: Date.parse(`${usageDate}T10:00:00.000Z`),
      sha256: 'a'.repeat(64),
      snapshots: [snapshot(usageDate)],
      missingCost: true,
      pendingUpload: true,
      updatedAt: new Date().toISOString()
    })

    try {
      await writeFile(cursorPath, `${JSON.stringify({
        version: 1,
        source: 'antigravity',
        files: {
          'event\0old': entry('2026-06-23'),
          'event\0current': entry('2026-06-24')
        }
      }, null, 2)}\n`)

      await clearPendingUploadCursors({
        stateDir: root,
        source: 'antigravity',
        since: '20260624',
        timezone: 'UTC'
      })

      const cursor = JSON.parse(await readFile(cursorPath, 'utf8'))
      expect(cursor.files['event\0old'].pendingUpload).toBe(true)
      expect(cursor.files['event\0current'].pendingUpload).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('acks snapshotless Antigravity entries with unknown mtime in a bounded range', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-zero-mtime-'))
    const cursorPath = join(root, 'antigravity-cursor.json')
    try {
      await writeFile(cursorPath, `${JSON.stringify({
        version: 1,
        source: 'antigravity',
        files: {
          'event\0unknown-time': {
            size: 0,
            mtimeMs: 0,
            sha256: 'a'.repeat(64),
            snapshots: [],
            missingCost: true,
            pendingUpload: true,
            updatedAt: new Date().toISOString()
          }
        }
      }, null, 2)}\n`)

      await clearPendingUploadCursors({
        stateDir: root,
        source: 'antigravity',
        since: '20260624',
        timezone: 'UTC'
      })

      const cursor = JSON.parse(await readFile(cursorPath, 'utf8'))
      expect(cursor.files['event\0unknown-time'].pendingUpload).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('drops pending upload entries without snapshots when the session file disappears before retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const file = join(sessionsDir, '2026', '05', '22', 'session.jsonl')

    try {
      await writeSession(file, 'one', '2026-05-22T01:00:00.000Z')
      const first = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })
      first.markPendingUpload()
      await first.commit()
      await rm(file)

      const retry = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })
      await retry.commit()

      const cursor = JSON.parse(await readFile(cursorPath, 'utf8'))
      expect(retry.files).toEqual([])
      expect(retry.hasPendingUpload).toBe(false)
      expect(retry.hasUnreadablePendingUpload).toBe(false)
      expect(retry.hasCursorCleanup).toBe(true)
      expect(cursor.files['2026/05/22/session.jsonl']).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('drops snapshotless missing pending upload entries when other changed files are readable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const pendingFile = join(sessionsDir, '2026', '05', '22', 'pending.jsonl')
    const changedFile = join(sessionsDir, '2026', '05', '22', 'changed.jsonl')

    try {
      await writeSession(pendingFile, 'pending', '2026-05-22T01:00:00.000Z')
      const first = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })
      first.markPendingUpload()
      await first.commit()
      await rm(pendingFile)
      await writeSession(changedFile, 'changed', '2026-05-22T02:00:00.000Z')

      const retry = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })

      expect(retry.files.map((item) => item.relativePath)).toEqual(['2026/05/22/changed.jsonl'])
      expect(retry.hasPendingUpload).toBe(false)
      expect(retry.hasUnreadablePendingUpload).toBe(false)
      expect(retry.hasCursorCleanup).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('returns missing pending upload snapshots for cached recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const changedFile = join(sessionsDir, '2026', '05', '23', 'changed.jsonl')

    try {
      await mkdir(dirname(cursorPath), { recursive: true })
      await writeFile(cursorPath, `${JSON.stringify({
        version: 1,
        source: 'codex',
        files: {
          '2026/05/22/missing.jsonl': {
            size: 123,
            mtimeMs: Date.parse('2026-05-22T01:00:00.000Z'),
            sha256: 'missing',
            snapshots: [
              {
                source: 'codex',
                usageDate: '2026-05-22',
                timezone: 'Asia/Shanghai',
                model: 'gpt-5',
                inputTokens: 10,
                outputTokens: 5,
                cacheCreationTokens: 0,
                cacheReadTokens: 0,
                totalTokens: 15,
                costUsd: 0.03,
                sessionCount: 1
              }
            ],
            missingCost: false,
            pendingUpload: true,
            updatedAt: '2026-05-22T01:00:00.000Z'
          }
        },
        lastScanHighWaterMs: Date.parse('2026-05-22T01:00:00.000Z')
      }, null, 2)}\n`)
      await writeSession(changedFile, 'changed', '2026-05-23T02:00:00.000Z')

      const retry = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })

      expect(retry.files.map((item) => item.relativePath)).toEqual(['2026/05/23/changed.jsonl'])
      expect(retry.hasPendingUpload).toBe(true)
      expect(retry.hasUnreadablePendingUpload).toBe(false)
      expect(retry.missingPendingSnapshots).toEqual([
        {
          relativePath: '2026/05/22/missing.jsonl',
          snapshots: [
            expect.objectContaining({
              usageDate: '2026-05-22',
              model: 'gpt-5',
              totalTokens: 15
            })
          ]
        }
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test.skipIf(!canDenyFileReadWithModeBits)('reports unreadable new changed files instead of silently advancing the scan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const unreadableFile = join(sessionsDir, '2026', '05', '22', 'unreadable.jsonl')

    try {
      await writeSession(unreadableFile, 'unreadable', '2026-05-22T01:00:00.000Z')
      await chmod(unreadableFile, 0o000)

      const result = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })

      expect(result.files).toEqual([])
      expect(result.hasUnreadableChangedFile).toBe(true)
      await expect(readFile(cursorPath, 'utf8')).rejects.toThrow()
    } finally {
      await chmod(unreadableFile, 0o600).catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  })

  test('skips old unchanged files after high-water scan advances', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const first = join(sessionsDir, '2026', '05', '22', 'first.jsonl')
    const second = join(sessionsDir, '2026', '05', '22', 'second.jsonl')

    try {
      await writeSession(first, 'one', '2026-05-22T01:00:00.000Z')
      const initial = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath,
        scanSafetyMs: 0
      })
      await initial.commit()

      await writeSession(second, 'two', '2026-05-22T02:00:00.000Z')
      const result = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath,
        scanSafetyMs: 0
      })

      expect(result.files.map((file) => file.relativePath)).toEqual(['2026/05/22/second.jsonl'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('warms high-water from collection start time instead of current file mtimes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const file = join(sessionsDir, '2026', '05', '22', 'session.jsonl')

    try {
      await writeSession(file, 'one', '2026-05-22T02:00:00.000Z')
      await warmHookCursorHighWater({
        stateDir: root,
        source: 'codex',
        sessionsDir,
        highWaterMs: Date.parse('2026-05-22T01:00:00.000Z')
      })

      const cursor = JSON.parse(await readFile(cursorPath, 'utf8'))
      expect(cursor.lastScanHighWaterMs).toBe(Date.parse('2026-05-22T01:00:00.000Z'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function writeSession(file: string, content: string, timestamp: string) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content)
  const date = new Date(timestamp)
  await utimes(file, date, date)
}
