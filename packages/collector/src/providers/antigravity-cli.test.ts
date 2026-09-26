import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { AntigravityUsageEvent } from './antigravity-gui-parser'
import { collectAntigravityCliUsage } from './antigravity-cli'
import { clearPendingUploadCursors } from './session-cursor'

const conversationA = 'a'.repeat(64)
const conversationB = 'b'.repeat(64)

describe('collectAntigravityCliUsage', () => {
  test('collects canonical SQLite history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-history-'))
    try {
      const snapshots = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'Asia/Shanghai',
        collectedAt: fixtureNextDayEarlyUtc,
        readDbUsageEvents: async () => ({
          cascadeIds: new Set(['cascade-a']),
          events: [
            historyEvent({
              createdAt: fixtureEveningUtc,
              model: 'gemini-3-flash-a',
              inputTokens: 100,
              outputTokens: 12,
              cacheReadTokens: 50
            })
          ],
          lastReadRowIndexByCascade: new Map([['cascade-a', 1]])
        })
      })

      expect(snapshots).toEqual([
        {
          source: 'antigravity-cli',
          usageDate: fixtureNextDay,
          timezone: 'Asia/Shanghai',
          model: 'gemini-3-flash-a',
          inputTokens: 100,
          outputTokens: 12,
          cacheCreationTokens: 0,
          cacheReadTokens: 50,
          totalTokens: 162,
          costUsd: 0,
          sessionCount: 1,
          collectedAt: fixtureNextDayEarlyUtc
        }
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps distinct history events with identical token counts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-history-shape-'))
    try {
      const snapshots = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        collectedAt: fixtureNextDayEarlyUtc,
        readDbUsageEvents: async () => ({
          cascadeIds: new Set(['cascade-a']),
          events: [
            historyEvent({ eventHash: 'e'.repeat(64), inputTokens: 100, outputTokens: 12, cacheReadTokens: 50 }),
            historyEvent({
              eventHash: 'f'.repeat(64),
              createdAt: `${fixtureDay}T16:31:00.000Z`,
              inputTokens: 100,
              outputTokens: 12,
              cacheReadTokens: 50
            })
          ],
          lastReadRowIndexByCascade: new Map([['cascade-a', 2]])
        })
      })

      expect(snapshots).toEqual([
        expect.objectContaining({
          inputTokens: 200,
          outputTokens: 24,
          cacheReadTokens: 100,
          totalTokens: 324,
          sessionCount: 1
        })
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps same event hashes from separate conversations distinct', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-history-conversations-'))
    try {
      const snapshots = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        readDbUsageEvents: async () => ({
          cascadeIds: new Set(['cascade-a', 'cascade-b']),
          events: [
            historyEvent({ cascadeHash: conversationA, eventHash: 'e'.repeat(64), inputTokens: 10 }),
            historyEvent({ cascadeHash: conversationB, eventHash: 'e'.repeat(64), inputTokens: 10 })
          ],
          lastReadRowIndexByCascade: new Map([
            ['cascade-a', 1],
            ['cascade-b', 1]
          ])
        })
      })

      expect(snapshots).toEqual([expect.objectContaining({ inputTokens: 20, totalTokens: 22, sessionCount: 2 })])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('retries pending history snapshots until they are acknowledged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-pending-history-'))
    const event = historyEvent({ inputTokens: 10, outputTokens: 2, createdAt: fixtureIso() })
    const readDbUsageEvents = async () => ({
      cascadeIds: new Set(['cascade-a']),
      events: [event],
      lastReadRowIndexByCascade: new Map([['cascade-a', 1]])
    })
    const firstCollectedAt = fixtureIso(60_000)
    const secondCollectedAt = fixtureIso(120_000)
    try {
      const first = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        collectedAt: firstCollectedAt,
        readDbUsageEvents
      })
      const second = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        collectedAt: secondCollectedAt,
        readDbUsageEvents
      })
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity-cli', timezone: 'UTC' })
      const third = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        collectedAt: fixtureIso(180_000),
        readDbUsageEvents
      })

      expect(first).toHaveLength(1)
      expect(second).toEqual([{ ...first[0], collectedAt: secondCollectedAt }])
      expect(third).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('uses independent hashed cursors for each server origin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-server-cursor-'))
    const event = historyEvent({ inputTokens: 10, outputTokens: 2 })
    const readDbUsageEvents = async () => ({
      cascadeIds: new Set(['cascade-a']),
      events: [event],
      lastReadRowIndexByCascade: new Map([['cascade-a', 1]])
    })
    const serverA = 'https://prod.example.com'
    const serverB = 'https://private.example.com'
    try {
      const first = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        cursorScope: serverA,
        collectedAt: fixtureIso(60_000),
        readDbUsageEvents
      })
      await clearPendingUploadCursors({
        stateDir: root,
        source: 'antigravity-cli',
        cursorScope: serverA,
        timezone: 'UTC'
      })
      const second = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        cursorScope: serverB,
        collectedAt: fixtureIso(120_000),
        readDbUsageEvents
      })

      expect(first).toHaveLength(1)
      expect(second).toEqual([{ ...first[0], collectedAt: fixtureIso(120_000) }])
      const cursorFiles = (await readdir(root)).filter((name) => name.includes('cursor'))
      expect(cursorFiles).toHaveLength(2)
      expect(cursorFiles.join('\n')).not.toContain('prod.example.com')
      expect(cursorFiles.join('\n')).not.toContain('private.example.com')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('uses the configured timezone for history dates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-history-timezone-'))
    try {
      const snapshots = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'Asia/Shanghai',
        readDbUsageEvents: async () => ({
          cascadeIds: new Set(['cascade-a']),
          events: [historyEvent({ createdAt: fixtureEveningUtc })],
          lastReadRowIndexByCascade: new Map([['cascade-a', 1]])
        })
      })

      expect(snapshots[0]?.usageDate).toBe(fixtureNextDay)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('propagates unavailable and malformed SQLite history errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-history-errors-'))
    try {
      await expect(
        collectAntigravityCliUsage({
          stateDir: root,
          timezone: 'UTC',
          readDbUsageEvents: async () => {
            throw new Error('Antigravity SQLite reader unavailable: sqlite3 not found')
          }
        })
      ).rejects.toThrow('Antigravity SQLite reader unavailable: sqlite3 not found')

      await expect(
        collectAntigravityCliUsage({
          stateDir: root,
          timezone: 'UTC',
          readDbUsageEvents: async () => {
            throw new Error('Failed to read Antigravity SQLite metadata: invalid row')
          }
        })
      ).rejects.toThrow('Failed to read Antigravity SQLite metadata: invalid row')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('passes DB row cursors and uploads complete daily snapshots after acknowledgement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-history-cursor-'))
    const firstEvent = historyEvent({
      inputTokens: 100,
      outputTokens: 12,
      cacheReadTokens: 50,
      createdAt: fixtureIso()
    })
    const secondEvent = historyEvent({
      eventHash: 'f'.repeat(64),
      createdAt: fixtureIso(60_000),
      inputTokens: 25,
      outputTokens: 3,
      cacheReadTokens: 10
    })
    const dbCursorReads: Array<Map<string, number>> = []
    try {
      const first = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        collectedAt: fixtureIso(120_000),
        readDbUsageEvents: async ({ lastSeenRowIndexByCascadeHash }) => {
          dbCursorReads.push(lastSeenRowIndexByCascadeHash)
          return {
            cascadeIds: new Set(['cascade-a']),
            events: [firstEvent],
            lastReadRowIndexByCascade: new Map([['cascade-a', 1]])
          }
        }
      })
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity-cli', timezone: 'UTC' })
      const second = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        collectedAt: fixtureIso(180_000),
        readDbUsageEvents: async ({ lastSeenRowIndexByCascadeHash }) => {
          dbCursorReads.push(lastSeenRowIndexByCascadeHash)
          return {
            cascadeIds: new Set(['cascade-a']),
            events: [secondEvent],
            lastReadRowIndexByCascade: new Map([['cascade-a', 2]])
          }
        }
      })

      expect(first[0]?.inputTokens).toBe(100)
      expect(dbCursorReads[0]?.size).toBe(0)
      expect(dbCursorReads[1]?.get(hash('cascade-a'))).toBe(1)
      expect(second).toEqual([
        expect.objectContaining({
          inputTokens: 125,
          outputTokens: 15,
          cacheReadTokens: 60,
          totalTokens: 200,
          sessionCount: 1
        })
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps DB reads bounded unless full history is explicitly requested', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-db-limit-'))
    const reads: Array<{ maxDbFiles?: number | null; requireCompleteDirectoryScan?: boolean }> = []
    const readDbUsageEvents = async (input: { maxDbFiles?: number | null; requireCompleteDirectoryScan?: boolean }) => {
      reads.push(input)
      return { cascadeIds: new Set<string>(), events: [] }
    }
    try {
      await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: fixtureSince,
        readDbUsageEvents
      })
      await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: fixtureSince,
        maxDbFiles: null,
        readDbUsageEvents
      })
      await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: 'all',
        readDbUsageEvents
      })

      expect(reads).toEqual([
        {
          maxDbFiles: undefined,
          sinceDate: fixtureNextDay,
          timezone: 'UTC',
          detectRowCursorReset: false,
          lastSeenRowIndexByCascadeHash: new Map(),
          requireCompleteDirectoryScan: false
        },
        {
          maxDbFiles: null,
          sinceDate: fixtureNextDay,
          timezone: 'UTC',
          detectRowCursorReset: false,
          lastSeenRowIndexByCascadeHash: new Map(),
          requireCompleteDirectoryScan: true
        },
        {
          maxDbFiles: null,
          sinceDate: undefined,
          timezone: 'UTC',
          detectRowCursorReset: false,
          lastSeenRowIndexByCascadeHash: new Map(),
          requireCompleteDirectoryScan: true
        }
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps legacy unanchored cursor recovery within the bounded file budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-unanchored-bounded-'))
    const reads: Array<{
      maxDbFiles?: number | null
      forceFullScanCascadeHashes?: ReadonlySet<string>
    }> = []
    const readDbUsageEvents = async (input: {
      maxDbFiles?: number | null
      forceFullScanCascadeHashes?: ReadonlySet<string>
    }) => {
      reads.push(input)
      return {
        cascadeIds: new Set<string>(),
        events: [],
        lastReadRowIndexByCascade: new Map([['cascade-a', 1]])
      }
    }
    try {
      await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: fixtureSince,
        readDbUsageEvents
      })
      await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: fixtureSince,
        readDbUsageEvents
      })

      expect(reads[1]?.maxDbFiles).toBeUndefined()
      expect(reads[1]?.forceFullScanCascadeHashes?.size).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// Antigravity cursor retention prunes acknowledged identities older than 90
// days, after which replaying the same history event correctly fails closed and
// demands `--since all`. Anchoring these fixtures to the current clock keeps the
// acknowledgement-and-replay tests inside that window instead of silently
// expiring on a fixed calendar date.
//
// The fixtures keep their original shape: an event in the late UTC evening lands
// on the following calendar day in Asia/Shanghai, which is what the timezone
// assertions below depend on.
const fixtureBaseMs = Date.parse(
  `${new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)}T00:00:00.000Z`
)
const fixtureDay = new Date(fixtureBaseMs).toISOString().slice(0, 10)
const fixtureNextDay = new Date(fixtureBaseMs + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
const fixtureSince = fixtureNextDay.replaceAll('-', '')

function fixtureIso(offsetMs = 0) {
  return new Date(fixtureBaseMs + offsetMs).toISOString()
}

// Late-evening UTC event: still the previous day in UTC, already the next day in
// Asia/Shanghai (+08:00).
const fixtureEveningUtc = `${fixtureDay}T16:30:00.000Z`
const fixtureNextDayEarlyUtc = `${fixtureNextDay}T02:00:00.000Z`

function historyEvent(overrides: Partial<AntigravityUsageEvent> = {}): AntigravityUsageEvent {
  return {
    cascadeHash: conversationA,
    eventHash: 'e'.repeat(64),
    createdAt: fixtureEveningUtc,
    model: 'gemini-3-flash-a',
    inputTokens: 10,
    outputTokens: 1,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    ...overrides
  }
}

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex')
}
