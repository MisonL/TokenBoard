import { mkdtemp, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { collectAntigravityGuiUsage } from './antigravity-gui'
import {
  lastSeenDbRowIndexByCascadeHash,
  prepareGuiHistoryScope
} from './antigravity-gui-cursor'
import { resolveAntigravityCollectionRange } from './antigravity-since'
import { clearPendingUploadCursors } from './session-cursor'

describe('collectAntigravityGuiUsage since ranges', () => {
  test('max-merges reusable bounded DB cursors across residual scopes', () => {
    const earlierScope = resolveAntigravityCollectionRange({ since: '20260601', timezone: 'UTC' }).historyScope
    const residualScope = resolveAntigravityCollectionRange({ since: '20260620', timezone: 'UTC' }).historyScope
    const currentScope = resolveAntigravityCollectionRange({ since: '20260624', timezone: 'UTC' }).historyScope
    const cascadeId = 'conversation-a'
    const cascadeHash = createHash('sha256').update(cascadeId).digest('hex')
    const entry = (rowIndex: number) => ({
      size: 0,
      mtimeMs: rowIndex,
      sha256: 'a'.repeat(64),
      snapshots: [],
      missingCost: true,
      pendingUpload: false,
      updatedAt: '2026-06-24T00:00:00.000Z'
    })
    const cursor = {
      version: 1 as const,
      source: 'antigravity' as const,
      files: {
        [`db\0antigravity\0since:${earlierScope}\0${cascadeHash}`]: entry(7),
        [`db\0antigravity\0since:${residualScope}\0${cascadeHash}`]: entry(5)
      }
    }

    prepareGuiHistoryScope({ cursor, source: 'antigravity', historyScope: currentScope })

    expect(lastSeenDbRowIndexByCascadeHash({
      cursor,
      source: 'antigravity',
      historyScope: currentScope
    }).get(cascadeHash)).toBe(7)
  })

  test('excludes SQLite and language-server events before the configured date', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-since-'))
    try {
      const snapshots = await collectAntigravityGuiUsage({
        ...baseOptions(root),
        since: '20260624',
        readDbUsageEvents: async () => ({
          cascadeIds: new Set(['conversation-db']),
          events: [
            dbEvent('b', '2026-06-23T15:59:59.000Z', 'gemini-db-old', 10),
            dbEvent('c', '2026-06-23T16:00:00.000Z', 'gemini-db-new', 20)
          ]
        }),
        requestGeneratorMetadata: async () => metadataResponse()
      })

      expect(snapshots).toEqual(expect.arrayContaining([
        expect.objectContaining({ model: 'gemini-db-new', inputTokens: 20 }),
        expect.objectContaining({ model: 'gemini-ls-new', inputTokens: 40 })
      ]))
      expect(snapshots).toHaveLength(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('can backfill SQLite rows after an earlier bounded cursor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-since-db-backfill-'))
    try {
      const cursorSizes: number[] = []
      const readDbUsageEvents = async (input?: { lastSeenRowIndexByCascadeHash?: Map<string, number> }) => {
        const cursorSize = input?.lastSeenRowIndexByCascadeHash?.size ?? 0
        cursorSizes.push(cursorSize)
        if (cursorSize > 0) return { cascadeIds: new Set<string>(), events: [] }
        return {
          cascadeIds: new Set(['conversation-a']),
          events: [
            dbEvent('b', '2026-06-23T15:59:59.000Z', 'gemini-old', 10),
            dbEvent('c', '2026-06-23T16:00:00.000Z', 'gemini-new', 20)
          ],
          lastReadRowIndexByCascade: new Map([['conversation-a', 2]])
        }
      }

      const bounded = await collectAntigravityGuiUsage({
        ...baseOptions(root),
        since: '20260624',
        listCascades: async () => [],
        readDbUsageEvents
      })
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity' })
      const full = await collectAntigravityGuiUsage({
        ...baseOptions(root),
        since: 'all',
        listCascades: async () => [],
        readDbUsageEvents
      })

      expect(cursorSizes).toEqual([0, 0])
      expect(bounded).toEqual([expect.objectContaining({ model: 'gemini-new' })])
      expect(full).toEqual([expect.objectContaining({ model: 'gemini-old' })])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not reuse a bounded SQLite cursor across timezones', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-since-timezone-'))
    try {
      const cursorSizes: number[] = []
      const readDbUsageEvents = async (input?: { lastSeenRowIndexByCascadeHash?: Map<string, number> }) => {
        const cursorSize = input?.lastSeenRowIndexByCascadeHash?.size ?? 0
        cursorSizes.push(cursorSize)
        if (cursorSize > 0) return { cascadeIds: new Set<string>(), events: [] }
        return {
          cascadeIds: new Set(['conversation-a']),
          events: [dbEvent('b', '2026-06-23T16:00:00.000Z', 'gemini', 20)],
          lastReadRowIndexByCascade: new Map([['conversation-a', 1]])
        }
      }

      const utc = await collectAntigravityGuiUsage({
        ...baseOptions(root),
        timezone: 'UTC',
        since: '20260624',
        listCascades: async () => [],
        readDbUsageEvents
      })
      const shanghai = await collectAntigravityGuiUsage({
        ...baseOptions(root),
        timezone: 'Asia/Shanghai',
        since: '20260624',
        listCascades: async () => [],
        readDbUsageEvents
      })

      expect(cursorSizes).toEqual([0, 0])
      expect(utc).toEqual([])
      expect(shanghai).toEqual([expect.objectContaining({ inputTokens: 20 })])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('can backfill language-server events after an earlier bounded cascade cursor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-since-ls-backfill-'))
    try {
      let requests = 0
      const options = {
        ...baseOptions(root),
        readDbUsageEvents: async () => ({ cascadeIds: new Set<string>(), events: [] }),
        requestGeneratorMetadata: async () => {
          requests += 1
          return metadataResponse()
        }
      }

      const bounded = await collectAntigravityGuiUsage({ ...options, since: '20260624' })
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity' })
      const full = await collectAntigravityGuiUsage({ ...options, since: 'all' })

      expect(requests).toBe(2)
      expect(bounded).toEqual([expect.objectContaining({ model: 'gemini-ls-new' })])
      expect(full).toEqual([expect.objectContaining({ model: 'gemini-ls-old' })])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not let out-of-range SQLite rows hide current language-server events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-since-db-cover-'))
    const cascadeId = 'conversation-shared'
    try {
      let requests = 0
      const snapshots = await collectAntigravityGuiUsage({
        source: 'antigravity',
        stateDir: root,
        timezone: 'Asia/Shanghai',
        since: '20260624',
        listCascades: async () => [
          { id: cascadeId, mtimeMs: Date.parse('2026-06-24T01:00:00.000Z'), size: 20 }
        ],
        readDbUsageEvents: async () => ({
          cascadeIds: new Set([cascadeId]),
          events: [{
            ...dbEvent('b', '2026-06-23T15:59:59.000Z', 'gemini-old', 10),
            cascadeHash: createHash('sha256').update(cascadeId).digest('hex')
          }],
          lastReadRowIndexByCascade: new Map([[cascadeId, 1]])
        }),
        requestGeneratorMetadata: async () => {
          requests += 1
          return {
            generatorMetadata: [
              metadataItem('2026-06-23T16:00:00.000Z', 'gemini-current', '40', 'response-current')
            ]
          }
        }
      })

      expect(requests).toBe(1)
      expect(snapshots).toEqual([expect.objectContaining({ model: 'gemini-current', inputTokens: 40 })])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function baseOptions(stateDir: string) {
  return {
    source: 'antigravity' as const,
    stateDir,
    timezone: 'Asia/Shanghai',
    listCascades: async () => [
      { id: 'conversation-language-server', mtimeMs: Date.parse('2026-06-24T01:00:00.000Z'), size: 20 }
    ]
  }
}

function dbEvent(hash: string, createdAt: string, model: string, inputTokens: number) {
  return {
    cascadeHash: 'a'.repeat(64),
    eventHash: hash.repeat(64),
    createdAt,
    model,
    inputTokens,
    outputTokens: 2,
    cacheCreationTokens: 0,
    cacheReadTokens: 0
  }
}

function metadataResponse() {
  return {
    generatorMetadata: [
      metadataItem('2026-06-23T15:59:59.000Z', 'gemini-ls-old', '30', 'response-old'),
      metadataItem('2026-06-23T16:00:00.000Z', 'gemini-ls-new', '40', 'response-new')
    ]
  }
}

function metadataItem(createdAt: string, model: string, inputTokens: string, responseId: string) {
  return {
    executionId: responseId,
    stepIndices: [3],
    chatModel: {
      model,
      chatStartMetadata: { createdAt },
      usage: { model, inputTokens, outputTokens: '2', cacheReadTokens: '0', responseId }
    }
  }
}
