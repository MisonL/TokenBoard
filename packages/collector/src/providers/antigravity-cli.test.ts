import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { clearPendingUploadCursors } from './session-cursor'
import { collectAntigravityCliUsage } from './antigravity-cli'

const conversationA = 'a'.repeat(64)
const conversationB = 'b'.repeat(64)
const defaultConversationHash = '0'.repeat(64)

describe('collectAntigravityCliUsage', () => {
  test('dedupes repeated statusline events and counts a conversation session once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-'))
    try {
      const eventPath = join(root, 'events.jsonl')
      await writeEvents(eventPath, [
        event({ usage: { inputTokens: 100, outputTokens: 10 } }),
        event({ usage: { inputTokens: 100, outputTokens: 10 } }),
        event({ usage: { inputTokens: 20, outputTokens: 5 } })
      ])

      const snapshots = await collectAntigravityCliUsage({
        stateDir: root,
        eventPath,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-06-23T10:00:00.000Z',
        readDbUsageEvents: emptyDbUsage
      })

      expect(snapshots).toEqual([
        {
          source: 'antigravity-cli',
          usageDate: '2026-06-23',
          timezone: 'Asia/Shanghai',
          model: 'Gemini 3.5 Flash (Medium)',
          inputTokens: 120,
          outputTokens: 15,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          totalTokens: 135,
          costUsd: 0,
          sessionCount: 1,
          collectedAt: '2026-06-23T10:00:00.000Z'
        }
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('retries pending snapshots until the cursor is acknowledged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-'))
    try {
      const eventPath = join(root, 'events.jsonl')
      await writeEvents(eventPath, [event({ usage: { inputTokens: 10, outputTokens: 2 } })])

      const first = await collectAntigravityCliUsage({ stateDir: root, eventPath, timezone: 'UTC', collectedAt: '2026-06-23T10:00:00.000Z', readDbUsageEvents: emptyDbUsage })
      const second = await collectAntigravityCliUsage({ stateDir: root, eventPath, timezone: 'UTC', collectedAt: '2026-06-23T10:05:00.000Z', readDbUsageEvents: emptyDbUsage })
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity-cli' })
      const third = await collectAntigravityCliUsage({ stateDir: root, eventPath, timezone: 'UTC', collectedAt: '2026-06-23T10:10:00.000Z', readDbUsageEvents: emptyDbUsage })

      expect(first).toHaveLength(1)
      expect(second).toEqual([{ ...first[0], collectedAt: '2026-06-23T10:05:00.000Z' }])
      expect(third).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('uses the configured timezone for usage dates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-'))
    try {
      const eventPath = join(root, 'events.jsonl')
      await writeEvents(eventPath, [event({ capturedAt: '2026-06-23T16:30:00.000Z', usage: { inputTokens: 1, outputTokens: 1 } })])

      const snapshots = await collectAntigravityCliUsage({ stateDir: root, eventPath, timezone: 'Asia/Shanghai', readDbUsageEvents: emptyDbUsage })

      expect(snapshots[0]?.usageDate).toBe('2026-06-24')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('continues statusline collection when optional SQLite history is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-statusline-without-sqlite-'))
    try {
      const eventPath = join(root, 'events.jsonl')
      await writeEvents(eventPath, [event({ usage: { inputTokens: 10, outputTokens: 2 } })])

      const snapshots = await collectAntigravityCliUsage({
        stateDir: root,
        eventPath,
        timezone: 'UTC',
        collectedAt: '2026-06-23T10:00:00.000Z',
        readDbUsageEvents: async () => {
          throw new Error('Antigravity SQLite reader unavailable: sqlite3 not found')
        }
      })

      expect(snapshots).toEqual([{
        source: 'antigravity-cli',
        usageDate: '2026-06-23',
        timezone: 'UTC',
        model: 'Gemini 3.5 Flash (Medium)',
        inputTokens: 10,
        outputTokens: 2,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 12,
        costUsd: 0,
        sessionCount: 1,
        collectedAt: '2026-06-23T10:00:00.000Z'
      }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('continues statusline collection when SQLite history directory is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-statusline-without-history-dir-'))
    try {
      const eventPath = join(root, 'events.jsonl')
      await writeEvents(eventPath, [event({ usage: { inputTokens: 10, outputTokens: 2 } })])

      const snapshots = await collectAntigravityCliUsage({
        stateDir: root,
        eventPath,
        conversationDir: join(root, 'missing-conversations'),
        timezone: 'UTC',
        collectedAt: '2026-06-23T10:00:00.000Z'
      })

      expect(snapshots).toEqual([{
        source: 'antigravity-cli',
        usageDate: '2026-06-23',
        timezone: 'UTC',
        model: 'Gemini 3.5 Flash (Medium)',
        inputTokens: 10,
        outputTokens: 2,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 12,
        costUsd: 0,
        sessionCount: 1,
        collectedAt: '2026-06-23T10:00:00.000Z'
      }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails when both statusline and SQLite history directory are absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-no-local-history-'))
    try {
      await expect(collectAntigravityCliUsage({
        stateDir: root,
        eventPath: join(root, 'missing-events.jsonl'),
        conversationDir: join(root, 'missing-conversations'),
        timezone: 'UTC',
        collectedAt: '2026-06-23T10:00:00.000Z'
      })).rejects.toThrow(`Antigravity conversations directory not found: ${join(root, 'missing-conversations')}`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails statusline collection when optional SQLite history has a real parse error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-statusline-with-bad-db-'))
    try {
      const eventPath = join(root, 'events.jsonl')
      await writeEvents(eventPath, [event({ usage: { inputTokens: 10, outputTokens: 2 } })])

      await expect(collectAntigravityCliUsage({
        stateDir: root,
        eventPath,
        timezone: 'UTC',
        collectedAt: '2026-06-23T10:00:00.000Z',
        readDbUsageEvents: async () => {
          throw new Error(`Failed to read Antigravity SQLite metadata from /tmp/tokenboard-agy-statusline-with-bad-db/conversation.db: Invalid Antigravity SQLite metadata row in /tmp/tokenboard-agy-statusline-with-bad-db/conversation.db`)
        }
      })).rejects.toThrow('Failed to read Antigravity SQLite metadata from /tmp/tokenboard-agy-statusline-with-bad-db/conversation.db')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('collects local conversation history when the statusline log is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-history-'))
    try {
      const snapshots = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-06-24T02:00:00.000Z',
        readDbUsageEvents: async () => ({
          cascadeIds: new Set(['conversation-a']),
          events: [{
            cascadeHash: 'c'.repeat(64),
            eventHash: 'e'.repeat(64),
            createdAt: '2026-06-23T16:30:00.000Z',
            model: 'gemini-3-flash-a',
            inputTokens: 100,
            outputTokens: 12,
            cacheCreationTokens: 0,
            cacheReadTokens: 50
          }]
        })
      })

      expect(snapshots).toEqual([{
        source: 'antigravity-cli',
        usageDate: '2026-06-24',
        timezone: 'Asia/Shanghai',
        model: 'gemini-3-flash-a',
        inputTokens: 100,
        outputTokens: 12,
        cacheCreationTokens: 0,
        cacheReadTokens: 50,
        totalTokens: 162,
        costUsd: 0,
        sessionCount: 1,
        collectedAt: '2026-06-24T02:00:00.000Z'
      }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps distinct local history rows with identical token counts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-history-same-shape-'))
    try {
      const snapshots = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        collectedAt: '2026-06-24T02:00:00.000Z',
        readDbUsageEvents: async () => ({
          cascadeIds: new Set(['conversation-a']),
          events: [
            {
              cascadeHash: conversationA,
              eventHash: 'e'.repeat(64),
              createdAt: '2026-06-23T16:30:00.000Z',
              model: 'gemini-3-flash-a',
              inputTokens: 100,
              outputTokens: 12,
              cacheCreationTokens: 0,
              cacheReadTokens: 50
            },
            {
              cascadeHash: conversationA,
              eventHash: 'f'.repeat(64),
              createdAt: '2026-06-23T16:31:00.000Z',
              model: 'gemini-3-flash-a',
              inputTokens: 100,
              outputTokens: 12,
              cacheCreationTokens: 0,
              cacheReadTokens: 50
            }
          ]
        })
      })

      expect(snapshots).toEqual([{
        source: 'antigravity-cli',
        usageDate: '2026-06-23',
        timezone: 'UTC',
        model: 'gemini-3-flash-a',
        inputTokens: 200,
        outputTokens: 24,
        cacheCreationTokens: 0,
        cacheReadTokens: 100,
        totalTokens: 324,
        costUsd: 0,
        sessionCount: 1,
        collectedAt: '2026-06-24T02:00:00.000Z'
      }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('collects local conversation history even when a statusline log path is configured', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-history-configured-log-'))
    try {
      const eventPath = join(root, 'events.jsonl')
      await writeEvents(eventPath, [])
      let dbRead = false
      const snapshots = await collectAntigravityCliUsage({
        stateDir: root,
        eventPath,
        timezone: 'UTC',
        collectedAt: '2026-06-24T02:00:00.000Z',
        readDbUsageEvents: async () => {
          dbRead = true
          return {
            cascadeIds: new Set(['conversation-a']),
            events: [{
              cascadeHash: conversationA,
              eventHash: 'e'.repeat(64),
              createdAt: '2026-06-24T01:30:00.000Z',
              model: 'gemini-3-flash-a',
              inputTokens: 100,
              outputTokens: 12,
              cacheCreationTokens: 0,
              cacheReadTokens: 50
            }]
          }
        }
      })

      expect(dbRead).toBe(true)
      expect(snapshots).toHaveLength(1)
      expect(snapshots[0]?.inputTokens).toBe(100)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('dedupes one matching statusline row while keeping distinct history rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-history-statusline-'))
    try {
      const eventPath = join(root, 'events.jsonl')
      await writeEvents(eventPath, [
        event({
          conversationHash: conversationA,
          capturedAt: '2026-06-23T16:30:00.000Z',
          usage: {
            inputTokens: 100,
            outputTokens: 12,
            cacheCreationTokens: 0,
            cacheReadTokens: 50
          }
        })
      ])

      const snapshots = await collectAntigravityCliUsage({
        stateDir: root,
        eventPath,
        conversationDir: root,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-06-24T02:00:00.000Z',
        readDbUsageEvents: async () => ({
          cascadeIds: new Set(['conversation-a']),
          events: [
            {
              cascadeHash: conversationA,
              eventHash: 'e'.repeat(64),
              createdAt: '2026-06-23T16:30:00.000Z',
              model: 'Gemini 3.5 Flash (Medium)',
              inputTokens: 100,
              outputTokens: 12,
              cacheCreationTokens: 0,
              cacheReadTokens: 50
            },
            {
              cascadeHash: conversationA,
              eventHash: 'f'.repeat(64),
              createdAt: '2026-06-23T16:31:00.000Z',
              model: 'Gemini 3.5 Flash (Medium)',
              inputTokens: 100,
              outputTokens: 12,
              cacheCreationTokens: 0,
              cacheReadTokens: 50
            }
          ]
        })
      })

      expect(snapshots).toEqual([{
        source: 'antigravity-cli',
        usageDate: '2026-06-24',
        timezone: 'Asia/Shanghai',
        model: 'Gemini 3.5 Flash (Medium)',
        inputTokens: 200,
        outputTokens: 24,
        cacheCreationTokens: 0,
        cacheReadTokens: 100,
        totalTokens: 324,
        costUsd: 0,
        sessionCount: 1,
        collectedAt: '2026-06-24T02:00:00.000Z'
      }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('dedupes history events after the matching statusline event was acknowledged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-history-after-statusline-'))
    try {
      const eventPath = join(root, 'events.jsonl')
      await writeEvents(eventPath, [
        event({
          conversationHash: conversationA,
          capturedAt: '2026-06-23T16:30:00.000Z',
          usage: {
            inputTokens: 100,
            outputTokens: 12,
            cacheCreationTokens: 0,
            cacheReadTokens: 50
          }
        })
      ])

      const first = await collectAntigravityCliUsage({
        stateDir: root,
        eventPath,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-06-24T02:00:00.000Z',
        readDbUsageEvents: emptyDbUsage
      })
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity-cli' })
      const second = await collectAntigravityCliUsage({
        stateDir: root,
        eventPath,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-06-24T02:05:00.000Z',
        readDbUsageEvents: async () => ({
          cascadeIds: new Set(['conversation-a']),
          events: [{
            cascadeHash: conversationA,
            eventHash: 'e'.repeat(64),
            createdAt: '2026-06-23T16:30:00.000Z',
            model: 'Gemini 3.5 Flash (Medium)',
            inputTokens: 100,
            outputTokens: 12,
            cacheCreationTokens: 0,
            cacheReadTokens: 50
          }]
        })
      })

      expect(first).toHaveLength(1)
      expect(second).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('dedupes statusline events after matching DB history alias cursor entries exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-statusline-after-history-'))
    try {
      const eventPath = join(root, 'events.jsonl')
      const historyEvent = {
        cascadeHash: conversationA,
        eventHash: 'e'.repeat(64),
        createdAt: '2026-06-23T16:30:00.000Z',
        model: 'Gemini 3.5 Flash (Medium)',
        inputTokens: 100,
        outputTokens: 12,
        cacheCreationTokens: 0,
        cacheReadTokens: 50
      }

      const first = await collectAntigravityCliUsage({
        stateDir: root,
        eventPath,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-06-24T02:00:00.000Z',
        readDbUsageEvents: async () => ({
          cascadeIds: new Set(['conversation-a']),
          events: [historyEvent]
        })
      })
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity-cli' })
      await appendFile(eventPath, `${JSON.stringify(event({
        conversationHash: conversationA,
        capturedAt: '2026-06-23T16:30:00.000Z',
        usage: {
          inputTokens: 100,
          outputTokens: 12,
          cacheCreationTokens: 0,
          cacheReadTokens: 50
        }
      }))}\n`)
      const second = await collectAntigravityCliUsage({
        stateDir: root,
        eventPath,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-06-24T02:05:00.000Z',
        readDbUsageEvents: async () => ({
          cascadeIds: new Set(['conversation-a']),
          events: [historyEvent]
        })
      })

      expect(first).toHaveLength(1)
      expect(second).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('dedupes DB history against acknowledged legacy statusline cursor keys', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-history-legacy-statusline-'))
    try {
      const eventPath = join(root, 'events.jsonl')
      const rawConversationId = 'conversation-a'
      const legacyConversationHash = legacyHash(rawConversationId)
      const dbConversationHash = plainHash(rawConversationId)
      await writeEvents(eventPath, [
        event({
          conversationHash: legacyConversationHash,
          capturedAt: '2026-06-23T16:30:00.000Z',
          usage: {
            inputTokens: 100,
            outputTokens: 12,
            cacheCreationTokens: 0,
            cacheReadTokens: 50
          }
        })
      ])

      const first = await collectAntigravityCliUsage({
        stateDir: root,
        eventPath,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-06-24T02:00:00.000Z',
        readDbUsageEvents: emptyDbUsage
      })
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity-cli' })
      const second = await collectAntigravityCliUsage({
        stateDir: root,
        eventPath,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-06-24T02:05:00.000Z',
        readDbUsageEvents: async () => ({
          cascadeIds: new Set([rawConversationId]),
          events: [{
            cascadeHash: dbConversationHash,
            cascadeHashAliases: [legacyConversationHash],
            eventHash: 'e'.repeat(64),
            createdAt: '2026-06-23T16:30:00.000Z',
            model: 'Gemini 3.5 Flash (Medium)',
            inputTokens: 100,
            outputTokens: 12,
            cacheCreationTokens: 0,
            cacheReadTokens: 50
          }]
        })
      })

      expect(first).toHaveLength(1)
      expect(second).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('counts mixed legacy statusline and plain-hash history events as one session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-history-legacy-session-'))
    try {
      const eventPath = join(root, 'events.jsonl')
      const rawConversationId = 'conversation-a'
      const legacyConversationHash = legacyHash(rawConversationId)
      const dbConversationHash = plainHash(rawConversationId)
      await writeEvents(eventPath, [
        event({
          conversationHash: legacyConversationHash,
          capturedAt: '2026-06-23T16:30:00.000Z',
          usage: {
            inputTokens: 100,
            outputTokens: 12,
            cacheCreationTokens: 0,
            cacheReadTokens: 50
          }
        })
      ])

      const snapshots = await collectAntigravityCliUsage({
        stateDir: root,
        eventPath,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-06-24T02:00:00.000Z',
        readDbUsageEvents: async () => ({
          cascadeIds: new Set([rawConversationId]),
          events: [{
            cascadeHash: dbConversationHash,
            cascadeHashAliases: [legacyConversationHash],
            eventHash: 'f'.repeat(64),
            createdAt: '2026-06-23T16:31:00.000Z',
            model: 'Gemini 3.5 Flash (Medium)',
            inputTokens: 20,
            outputTokens: 4,
            cacheCreationTokens: 0,
            cacheReadTokens: 0
          }]
        })
      })

      expect(snapshots).toEqual([{
        source: 'antigravity-cli',
        usageDate: '2026-06-24',
        timezone: 'Asia/Shanghai',
        model: 'Gemini 3.5 Flash (Medium)',
        inputTokens: 120,
        outputTokens: 16,
        cacheCreationTokens: 0,
        cacheReadTokens: 50,
        totalTokens: 186,
        costUsd: 0,
        sessionCount: 1,
        collectedAt: '2026-06-24T02:00:00.000Z'
      }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('scans only appended statusline events after acknowledged uploads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-'))
    try {
      const eventPath = join(root, 'events.jsonl')
      await writeEvents(eventPath, [event({ conversationHash: conversationA, usage: { inputTokens: 10, outputTokens: 2 } })])

      const first = await collectAntigravityCliUsage({ stateDir: root, eventPath, timezone: 'UTC', collectedAt: '2026-06-23T10:00:00.000Z', readDbUsageEvents: emptyDbUsage })
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity-cli' })
      await appendFile(eventPath, `${JSON.stringify(event({ conversationHash: conversationB, usage: { inputTokens: 20, outputTokens: 4 } }))}\n`)
      const second = await collectAntigravityCliUsage({ stateDir: root, eventPath, timezone: 'UTC', collectedAt: '2026-06-23T10:05:00.000Z', readDbUsageEvents: emptyDbUsage })

      expect(first[0]?.inputTokens).toBe(10)
      expect(second).toEqual([
        {
          source: 'antigravity-cli',
          usageDate: '2026-06-23',
          timezone: 'UTC',
          model: 'Gemini 3.5 Flash (Medium)',
          inputTokens: 20,
          outputTokens: 4,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          totalTokens: 24,
          costUsd: 0,
          sessionCount: 1,
          collectedAt: '2026-06-23T10:05:00.000Z'
        }
      ])
      const cursor = JSON.parse(await readFile(join(root, 'antigravity-cli-cursor.json'), 'utf8'))
      expect(cursor.lastScanOffsetBytes).toBeGreaterThan(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps recently acknowledged old cursor entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-'))
    try {
      const eventPath = join(root, 'events.jsonl')
      await writeEvents(eventPath, [event({
        capturedAt: '2026-01-01T10:00:00.000Z',
        conversationHash: conversationA,
        usage: { inputTokens: 10, outputTokens: 2 }
      })])

      await collectAntigravityCliUsage({ stateDir: root, eventPath, timezone: 'UTC', collectedAt: '2026-01-01T10:00:00.000Z', readDbUsageEvents: emptyDbUsage })
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity-cli' })
      await appendFile(eventPath, `${JSON.stringify(event({
        capturedAt: '2026-06-23T10:00:00.000Z',
        conversationHash: conversationB,
        usage: { inputTokens: 20, outputTokens: 4 }
      }))}\n`)
      await collectAntigravityCliUsage({ stateDir: root, eventPath, timezone: 'UTC', collectedAt: '2026-06-23T10:05:00.000Z', readDbUsageEvents: emptyDbUsage })

      const cursor = JSON.parse(await readFile(join(root, 'antigravity-cli-cursor.json'), 'utf8'))
      expect(Object.keys(cursor.files).some((key) => key.includes(conversationA))).toBe(true)
      expect(Object.keys(cursor.files).some((key) => key.includes(conversationB))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not re-emit acknowledged DB history events after cursor ack', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-history-expired-'))
    try {
      const oldHistoryEvent = {
        cascadeHash: conversationA,
        eventHash: 'e'.repeat(64),
        createdAt: '2026-01-01T10:00:00.000Z',
        model: 'gemini-3-flash-a',
        inputTokens: 100,
        outputTokens: 12,
        cacheCreationTokens: 0,
        cacheReadTokens: 50
      }

      const first = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        collectedAt: '2026-01-01T10:05:00.000Z',
        readDbUsageEvents: async () => ({
          cascadeIds: new Set(['conversation-a']),
          events: [oldHistoryEvent]
        })
      })
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity-cli' })
      const second = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        collectedAt: '2026-06-23T10:05:00.000Z',
        readDbUsageEvents: async () => ({
          cascadeIds: new Set(['conversation-a']),
          events: [oldHistoryEvent]
        })
      })

      expect(first).toHaveLength(1)
      expect(second).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('treats statusline and DB history as the same usage stream', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-history-dedupe-'))
    try {
      const eventPath = join(root, 'events.jsonl')
      await writeEvents(eventPath, [event({
        conversationHash: conversationA,
        capturedAt: '2026-06-23T16:30:00.000Z',
        usage: { inputTokens: 100, outputTokens: 12, cacheReadTokens: 50 }
      })])

      const snapshots = await collectAntigravityCliUsage({
        stateDir: root,
        eventPath,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-06-24T02:00:00.000Z',
        readDbUsageEvents: async () => ({
          cascadeIds: new Set(['conversation-a']),
          events: [{
            cascadeHash: conversationA,
            eventHash: 'e'.repeat(64),
            createdAt: '2026-06-23T16:30:00.000Z',
            model: 'Gemini 3.5 Flash (Medium)',
            inputTokens: 100,
            outputTokens: 12,
            cacheCreationTokens: 0,
            cacheReadTokens: 50
          }]
        })
      })

      expect(snapshots).toEqual([{
        source: 'antigravity-cli',
        usageDate: '2026-06-24',
        timezone: 'Asia/Shanghai',
        model: 'Gemini 3.5 Flash (Medium)',
        inputTokens: 100,
        outputTokens: 12,
        cacheCreationTokens: 0,
        cacheReadTokens: 50,
        totalTokens: 162,
        costUsd: 0,
        sessionCount: 1,
        collectedAt: '2026-06-24T02:00:00.000Z'
      }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('uses statusline eventHash for precise DB history dedupe', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-statusline-event-hash-'))
    try {
      const eventPath = join(root, 'events.jsonl')
      await writeEvents(eventPath, [
        event({
          conversationHash: conversationA,
          eventHash: 'e'.repeat(64),
          capturedAt: '2026-06-23T16:30:00.000Z',
          usage: {
            inputTokens: 100,
            outputTokens: 12,
            cacheCreationTokens: 0,
            cacheReadTokens: 50
          }
        })
      ])

      const snapshots = await collectAntigravityCliUsage({
        stateDir: root,
        eventPath,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-06-24T02:00:00.000Z',
        readDbUsageEvents: async () => ({
          cascadeIds: new Set(['conversation-a']),
          events: [{
            cascadeHash: conversationA,
            eventHash: 'e'.repeat(64),
            createdAt: '2026-06-23T16:30:00.000Z',
            model: 'Gemini 3.5 Flash (Medium)',
            inputTokens: 100,
            outputTokens: 12,
            cacheCreationTokens: 0,
            cacheReadTokens: 50
          }]
        })
      })

      expect(snapshots).toEqual([{
        source: 'antigravity-cli',
        usageDate: '2026-06-24',
        timezone: 'Asia/Shanghai',
        model: 'Gemini 3.5 Flash (Medium)',
        inputTokens: 100,
        outputTokens: 12,
        cacheCreationTokens: 0,
        cacheReadTokens: 50,
        totalTokens: 162,
        costUsd: 0,
        sessionCount: 1,
        collectedAt: '2026-06-24T02:00:00.000Z'
      }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects malformed and unsanitized statusline events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-'))
    try {
      const malformedPath = join(root, 'malformed.jsonl')
      await mkdir(root, { recursive: true })
      await writeFile(malformedPath, '{bad json}\n')
      await expect(collectAntigravityCliUsage({ stateDir: root, eventPath: malformedPath, readDbUsageEvents: emptyDbUsage }))
        .rejects.toThrow('Malformed Antigravity statusline JSON')

      const unsafePath = join(root, 'unsafe.jsonl')
      await writeFile(unsafePath, `${JSON.stringify({ ...event({}), cwd: '/Users/example/project' })}\n`)
      await expect(collectAntigravityCliUsage({ stateDir: root, eventPath: unsafePath, readDbUsageEvents: emptyDbUsage }))
        .rejects.toThrow('sensitive field cwd')

      const nestedUnsafePath = join(root, 'nested-unsafe.jsonl')
      await writeFile(nestedUnsafePath, `${JSON.stringify({ ...event({}), metadata: { prompt: 'raw prompt' } })}\n`)
      await expect(collectAntigravityCliUsage({ stateDir: root, eventPath: nestedUnsafePath, readDbUsageEvents: emptyDbUsage }))
        .rejects.toThrow('sensitive field prompt')

      const camelCaseUnsafePath = join(root, 'camel-unsafe.jsonl')
      await writeFile(camelCaseUnsafePath, `${JSON.stringify({ ...event({}), metadata: { responseId: 'raw-response-id' } })}\n`)
      await expect(collectAntigravityCliUsage({ stateDir: root, eventPath: camelCaseUnsafePath, readDbUsageEvents: emptyDbUsage }))
        .rejects.toThrow('sensitive field responseId')

      const credentialUnsafePath = join(root, 'credential-unsafe.jsonl')
      await writeFile(credentialUnsafePath, `${JSON.stringify({ ...event({}), metadata: { apiKey: 'secret-api-key' } })}\n`)
      await expect(collectAntigravityCliUsage({ stateDir: root, eventPath: credentialUnsafePath, readDbUsageEvents: emptyDbUsage }))
        .rejects.toThrow('sensitive field apiKey')

      const looseDatePath = join(root, 'loose-date.jsonl')
      await writeFile(looseDatePath, `${JSON.stringify(event({ capturedAt: 'June 23, 2026 10:00:00' }))}\n`)
      await expect(collectAntigravityCliUsage({ stateDir: root, eventPath: looseDatePath, readDbUsageEvents: emptyDbUsage }))
        .rejects.toThrow('capturedAt must be an ISO datetime')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects unbounded token values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-'))
    try {
      const eventPath = join(root, 'events.jsonl')
      await writeEvents(eventPath, [event({ usage: { inputTokens: 1_000_000_001 } })])

      await expect(collectAntigravityCliUsage({ stateDir: root, eventPath, readDbUsageEvents: emptyDbUsage }))
        .rejects.toThrow('inputTokens must be a bounded nonnegative integer')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function writeEvents(path: string, events: unknown[]) {
  await writeFile(path, `${events.map((item) => JSON.stringify(item)).join('\n')}\n`)
}

function event(overrides: Partial<Omit<ReturnType<typeof baseEvent>, 'usage'>> & { usage?: Partial<ReturnType<typeof baseEvent>['usage']> } = {}) {
  return {
    ...baseEvent(),
    ...overrides,
    usage: {
      ...baseEvent().usage,
      ...(overrides as { usage?: object }).usage
    }
  }
}

function baseEvent() {
  return {
    schemaVersion: 'antigravity-statusline/v1',
    capturedAt: '2026-06-23T10:00:00.000Z',
    conversationHash: defaultConversationHash,
    eventHash: undefined as string | undefined,
    model: 'Gemini 3.5 Flash (Medium)',
    usage: {
      inputTokens: 10,
      outputTokens: 2,
      cacheCreationTokens: 0,
      cacheReadTokens: 0
    }
  }
}

async function emptyDbUsage() {
  return { cascadeIds: new Set<string>(), events: [] }
}

function plainHash(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function legacyHash(value: string) {
  return createHash('sha256')
    .update('tokenboard-antigravity-cli\0')
    .update(value)
    .digest('hex')
}
