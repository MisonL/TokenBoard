import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { collectAntigravityCliUsage } from './antigravity-cli'
import { clearPendingUploadCursors } from './session-cursor'

const cascadeHash = 'a'.repeat(64)

describe('collectAntigravityCliUsage since ranges', () => {
  test('excludes SQLite history before the configured local date', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-since-'))
    try {
      const snapshots = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'Asia/Shanghai',
        since: '20260624',
        readDbUsageEvents: async () => dbUsage([
          historyEvent('b', '2026-06-23T15:59:59.000Z', 'gemini-old', 30),
          historyEvent('c', '2026-06-23T16:00:00.000Z', 'gemini-new', 40)
        ], 2)
      })

      expect(snapshots).toEqual([expect.objectContaining({ model: 'gemini-new', inputTokens: 40 })])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('retries a pending SQLite group outside the active bounded range', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-since-pending-'))
    const old = historyEvent('b', '2026-06-23T16:00:00.000Z', 'gemini', 10)
    try {
      await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'Asia/Shanghai',
        since: 'all',
        readDbUsageEvents: async () => dbUsage([old], 1)
      })
      await clearPendingUploadCursors({
        stateDir: root,
        source: 'antigravity-cli',
        since: '20260625',
        timezone: 'Asia/Shanghai'
      })

      const retry = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'Asia/Shanghai',
        since: '20260625',
        readDbUsageEvents: async () => dbUsage([], 1)
      })

      expect(retry).toEqual([expect.objectContaining({ inputTokens: 10, totalTokens: 12 })])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('performs a fresh all-scope row scan after a bounded cursor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-since-full-'))
    const cursorSizes: number[] = []
    const events = [
      historyEvent('b', '2026-06-23T15:59:59.000Z', 'gemini', 10),
      historyEvent('c', '2026-06-23T16:00:00.000Z', 'gemini', 20)
    ]
    try {
      const bounded = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'Asia/Shanghai',
        since: '20260624',
        readDbUsageEvents: async ({ lastSeenRowIndexByCascadeHash }) => {
          cursorSizes.push(lastSeenRowIndexByCascadeHash.size)
          return dbUsage(events, 2)
        }
      })
      await clearPendingUploadCursors({
        stateDir: root,
        source: 'antigravity-cli',
        timezone: 'Asia/Shanghai'
      })
      const full = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'Asia/Shanghai',
        since: 'all',
        readDbUsageEvents: async ({ lastSeenRowIndexByCascadeHash }) => {
          cursorSizes.push(lastSeenRowIndexByCascadeHash.size)
          return dbUsage(events, 2)
        }
      })

      expect(cursorSizes).toEqual([0, 0])
      expect(bounded).toEqual([expect.objectContaining({ inputTokens: 20 })])
      expect(full).toEqual(expect.arrayContaining([
        expect.objectContaining({ usageDate: '2026-06-23', inputTokens: 10, sessionCount: 1 }),
        expect.objectContaining({ usageDate: '2026-06-24', inputTokens: 20, sessionCount: 1 })
      ]))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function historyEvent(hash: string, createdAt: string, model: string, inputTokens: number) {
  return {
    cascadeHash,
    eventHash: hash.repeat(64),
    createdAt,
    model,
    inputTokens,
    outputTokens: 2,
    cacheCreationTokens: 0,
    cacheReadTokens: 0
  }
}

function dbUsage(events: ReturnType<typeof historyEvent>[], rowIndex: number) {
  return {
    cascadeIds: new Set(events.length > 0 ? ['cascade-a'] : []),
    events,
    lastReadRowIndexByCascade: new Map([['cascade-a', rowIndex]])
  }
}
