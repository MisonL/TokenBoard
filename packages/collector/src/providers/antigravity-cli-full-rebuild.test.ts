import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { collectAntigravityCliUsage } from './antigravity-cli'
import { clearPendingUploadCursors } from './session-cursor'

const cascadeHash = 'a'.repeat(64)
const eventHash = 'b'.repeat(64)
const createdAt = '2026-07-20T10:00:00.000Z'

describe('Antigravity CLI full history rebuild', () => {
  test('rebuilds acknowledged bounded history without adding the retained daily total', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-full-rebuild-'))
    const event = historyEvent()
    try {
      const bounded = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: '20260720',
        collectedAt: createdAt,
        readDbUsageEvents: async () => ({
          cascadeIds: new Set(['cascade-a']),
          events: [event],
          lastReadRowIndexByCascade: new Map([['cascade-a', 1]])
        })
      })
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity-cli', timezone: 'UTC' })

      const rebuilt = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: 'all',
        collectedAt: '2026-07-20T11:00:00.000Z',
        readDbUsageEvents: async ({ lastSeenRowIndexByCascadeHash, requireCompleteDirectoryScan }) => {
          expect(lastSeenRowIndexByCascadeHash).toEqual(new Map())
          expect(requireCompleteDirectoryScan).toBe(true)
          return {
            cascadeIds: new Set(['cascade-a']),
            events: [event],
            lastReadRowIndexByCascade: new Map([['cascade-a', 1]])
          }
        }
      })

      expect(bounded).toEqual([expect.objectContaining({
        inputTokens: 10,
        totalTokens: 10,
        sessionCount: 1
      })])
      expect(rebuilt).toEqual([expect.objectContaining({
        inputTokens: 10,
        totalTokens: 10,
        sessionCount: 1
      })])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rebuilds a compacted old daily model from SQLite without accumulating prior totals', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-compacted-full-rebuild-'))
    const oldCreatedAt = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString()
    const event = historyEvent(oldCreatedAt)
    const readDbUsageEvents = async () => ({
      cascadeIds: new Set(['cascade-a']),
      events: [event],
      lastReadRowIndexByCascade: new Map([['cascade-a', 1]])
    })
    try {
      const first = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: 'all',
        readDbUsageEvents
      })
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity-cli', timezone: 'UTC' })

      const rebuilt = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: 'all',
        readDbUsageEvents
      })
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity-cli', timezone: 'UTC' })

      const rebuiltAgain = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: 'all',
        readDbUsageEvents
      })

      for (const snapshots of [first, rebuilt, rebuiltAgain]) {
        expect(snapshots).toEqual([expect.objectContaining({
          inputTokens: 10,
          totalTokens: 10,
          sessionCount: 1
        })])
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps acknowledged retained history bounded and rebuilds it without duplicating the daily model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-bounded-full-rebuild-'))
    const oldCreatedAt = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString()
    const events = Array.from({ length: 3_000 }, (_, index) => historyEvent(
      oldCreatedAt,
      index.toString(16).padStart(64, '0')
    ))
    const readDbUsageEvents = async () => ({
      cascadeIds: new Set(['cascade-a']),
      events,
      lastReadRowIndexByCascade: new Map([['cascade-a', events.length]])
    })
    try {
      const first = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: 'all',
        readDbUsageEvents
      })
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity-cli', timezone: 'UTC' })

      const compacted = JSON.parse(await readFile(join(root, 'antigravity-cli-cursor.json'), 'utf8')) as {
        files: Record<string, unknown>
      }
      const persistedKeys = Object.keys(compacted.files)
      expect(persistedKeys).toHaveLength(1)
      expect(persistedKeys[0]).toMatch(/^db-row\0antigravity-cli\0[a-f0-9]{64}$/)

      const rebuilt = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: 'all',
        readDbUsageEvents
      })

      for (const snapshots of [first, rebuilt]) {
        expect(snapshots).toEqual([expect.objectContaining({
          inputTokens: events.length * 10,
          totalTokens: events.length * 10,
          sessionCount: 1
        })])
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects a finite database limit before a canonical full rebuild', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-partial-full-rebuild-'))
    let reads = 0
    try {
      await expect(collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: 'all',
        maxDbFiles: 1,
        readDbUsageEvents: async () => {
          reads += 1
          return {
            cascadeIds: new Set(['cascade-a']),
            events: [historyEvent()],
            lastReadRowIndexByCascade: new Map([['cascade-a', 1]])
          }
        }
      })).rejects.toThrow('requires an unbounded SQLite database scan')

      expect(reads).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function historyEvent(
  createdAt = '2026-07-20T10:00:00.000Z',
  hash = eventHash
) {
  return {
    cascadeHash,
    eventHash: hash,
    createdAt,
    model: 'gemini-3-flash-a',
    inputTokens: 10,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0
  }
}
