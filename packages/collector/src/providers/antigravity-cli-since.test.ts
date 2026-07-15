import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { collectAntigravityCliUsage } from './antigravity-cli'
import { clearPendingUploadCursors } from './session-cursor'

const conversationA = 'a'.repeat(64)
const conversationB = 'b'.repeat(64)

describe('collectAntigravityCliUsage since ranges', () => {
  test('excludes statusline and SQLite events before the configured date', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-since-'))
    try {
      const eventPath = join(root, 'events.jsonl')
      await writeEvents(eventPath)
      const snapshots = await collectAntigravityCliUsage({
        stateDir: root,
        eventPath,
        timezone: 'Asia/Shanghai',
        since: '20260624',
        readDbUsageEvents: async () => ({
          cascadeIds: new Set(['conversation-db']),
          events: [
            historyEvent('d', '2026-06-23T15:59:59.000Z', 'gemini-old', 30),
            historyEvent('f', '2026-06-23T16:00:00.000Z', 'gemini-new', 40)
          ]
        })
      })

      expect(snapshots).toEqual(expect.arrayContaining([
        expect.objectContaining({ model: 'Gemini 3.5 Flash (Medium)', inputTokens: 20 }),
        expect.objectContaining({ model: 'gemini-new', inputTokens: 40 })
      ]))
      expect(snapshots).toHaveLength(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('can backfill statusline events after an earlier bounded scan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-since-statusline-backfill-'))
    try {
      const eventPath = join(root, 'events.jsonl')
      await writeEvents(eventPath)
      const bounded = await collectAntigravityCliUsage({
        stateDir: root,
        eventPath,
        timezone: 'Asia/Shanghai',
        since: '20260624',
        readDbUsageEvents: emptyDbUsage
      })
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity-cli' })
      const full = await collectAntigravityCliUsage({
        stateDir: root,
        eventPath,
        timezone: 'Asia/Shanghai',
        since: 'all',
        readDbUsageEvents: emptyDbUsage
      })

      expect(bounded).toEqual([expect.objectContaining({ inputTokens: 20 })])
      expect(full).toEqual([expect.objectContaining({ inputTokens: 10 })])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not reuse a bounded statusline offset across timezones', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-since-timezone-'))
    try {
      const eventPath = join(root, 'events.jsonl')
      await writeEvents(eventPath)
      const utc = await collectAntigravityCliUsage({
        stateDir: root,
        eventPath,
        timezone: 'UTC',
        since: '20260624',
        readDbUsageEvents: emptyDbUsage
      })
      const shanghai = await collectAntigravityCliUsage({
        stateDir: root,
        eventPath,
        timezone: 'Asia/Shanghai',
        since: '20260624',
        readDbUsageEvents: emptyDbUsage
      })

      expect(utc).toEqual([])
      expect(shanghai).toEqual([expect.objectContaining({ inputTokens: 20 })])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('can backfill SQLite rows after an earlier bounded row cursor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-since-db-backfill-'))
    try {
      const cursorSizes: number[] = []
      const readDbUsageEvents = async ({ lastSeenRowIndexByCascadeHash }: {
        lastSeenRowIndexByCascadeHash: Map<string, number>
      }) => {
        cursorSizes.push(lastSeenRowIndexByCascadeHash.size)
        if (lastSeenRowIndexByCascadeHash.size > 0) return { cascadeIds: new Set<string>(), events: [] }
        return {
          cascadeIds: new Set(['conversation-a']),
          events: [
            historyEvent('d', '2026-06-23T15:59:59.000Z', 'gemini', 10),
            historyEvent('f', '2026-06-23T16:00:00.000Z', 'gemini', 20)
          ],
          lastReadRowIndexByCascade: new Map([['conversation-a', 2]])
        }
      }

      const bounded = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'Asia/Shanghai',
        since: '20260624',
        readDbUsageEvents
      })
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity-cli' })
      const full = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'Asia/Shanghai',
        since: 'all',
        readDbUsageEvents
      })

      expect(cursorSizes).toEqual([0, 0])
      expect(bounded).toEqual([expect.objectContaining({ inputTokens: 20 })])
      expect(full).toEqual([expect.objectContaining({ inputTokens: 10 })])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function writeEvents(path: string) {
  const events = [
    statuslineEvent('2026-06-23T15:59:59.000Z', conversationA, 10, 1),
    statuslineEvent('2026-06-23T16:00:00.000Z', conversationB, 20, 2)
  ]
  await writeFile(path, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`)
}

function statuslineEvent(capturedAt: string, conversationHash: string, inputTokens: number, outputTokens: number) {
  return {
    schemaVersion: 'antigravity-statusline/v1',
    capturedAt,
    conversationHash,
    model: 'Gemini 3.5 Flash (Medium)',
    usage: { inputTokens, outputTokens, cacheCreationTokens: 0, cacheReadTokens: 0 }
  }
}

function historyEvent(hash: string, createdAt: string, model: string, inputTokens: number) {
  return {
    cascadeHash: conversationA,
    eventHash: hash.repeat(64),
    createdAt,
    model,
    inputTokens,
    outputTokens: 2,
    cacheCreationTokens: 0,
    cacheReadTokens: 0
  }
}

async function emptyDbUsage() {
  return { cascadeIds: new Set<string>(), events: [] }
}
