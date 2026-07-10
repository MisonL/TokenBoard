import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { clearPendingUploadCursors } from './session-cursor'
import {
  collectAntigravityGuiUsage,
  collectAntigravityIdeUsage,
  isAntigravityPartialUsageError,
  type AntigravityGuiSource
} from './antigravity-gui'

describe('collectAntigravityGuiUsage', () => {
  test('extracts standalone generator metadata without persisting raw local identifiers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-gui-'))
    try {
      const snapshots = await collectAntigravityGuiUsage({
        source: 'antigravity',
        stateDir: root,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-06-24T02:00:00.000Z',
        listCascadeIds: async () => ['conversation-a'],
        requestGeneratorMetadata: async () => generatorMetadataResponse()
      })

      expect(snapshots).toEqual([
        {
          source: 'antigravity',
          usageDate: '2026-06-24',
          timezone: 'Asia/Shanghai',
          model: 'Gemini 3.5 Flash (Medium)',
          inputTokens: 120,
          outputTokens: 24,
          cacheCreationTokens: 0,
          cacheReadTokens: 30,
          totalTokens: 174,
          costUsd: 0,
          sessionCount: 1,
          collectedAt: '2026-06-24T02:00:00.000Z'
        }
      ])

      const cursorText = await readFile(join(root, 'antigravity-cursor.json'), 'utf8')
      expect(cursorText).not.toContain('conversation-a')
      expect(cursorText).not.toContain('response-a')
      expect(cursorText).not.toContain('execution-a')
      expect(cursorText).not.toContain('session-a')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('retries pending Antigravity IDE snapshots until acknowledged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-ide-'))
    try {
      const options = {
        stateDir: root,
        timezone: 'UTC',
        listCascadeIds: async () => ['conversation-a'],
        requestGeneratorMetadata: async () => generatorMetadataResponse({ source: 'antigravity-ide' })
      }

      const first = await collectAntigravityIdeUsage({
        ...options,
        collectedAt: '2026-06-23T10:00:00.000Z'
      })
      const second = await collectAntigravityIdeUsage({
        ...options,
        collectedAt: '2026-06-23T10:05:00.000Z'
      })
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity-ide' })
      const third = await collectAntigravityIdeUsage({
        ...options,
        collectedAt: '2026-06-23T10:10:00.000Z'
      })

      expect(first).toHaveLength(1)
      expect(second).toEqual([{ ...first[0], collectedAt: '2026-06-23T10:05:00.000Z' }])
      expect(third).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test.each(['antigravity', 'antigravity-ide'] as const)(
    'isolates acknowledged %s cursors by server origin',
    async (source) => {
      const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-server-cursor-'))
      try {
        const serverA = 'https://prod.example.com'
        const serverB = 'https://private.example.com'
        const firstOptions = {
          source,
          stateDir: root,
          timezone: 'UTC',
          collectedAt: '2026-06-23T10:00:00.000Z',
          cursorScope: serverA,
          listCascadeIds: async () => ['conversation-a'],
          requestGeneratorMetadata: async () => generatorMetadataResponse({ source })
        }
        const secondOptions = {
          ...firstOptions,
          collectedAt: '2026-06-23T10:05:00.000Z',
          cursorScope: serverB
        }

        const first = await collectAntigravityGuiUsage(firstOptions)
        await clearPendingUploadCursors({ stateDir: root, source, cursorScope: serverA })
        const second = await collectAntigravityGuiUsage(secondOptions)

        expect(first).toHaveLength(1)
        expect(second).toEqual([{ ...first[0], collectedAt: '2026-06-23T10:05:00.000Z' }])
        const cursorFiles = (await readdir(root)).filter((name) => name.includes('cursor'))
        expect(cursorFiles).toHaveLength(2)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  test('uploads complete DB day snapshots after acknowledged uploads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-complete-db-'))
    try {
      const firstEvent = {
        cascadeHash: 'c'.repeat(64),
        eventHash: 'e'.repeat(64),
        createdAt: '2026-06-23T16:30:00.000Z',
        model: 'gemini-3-flash-a',
        inputTokens: 100,
        outputTokens: 20,
        cacheCreationTokens: 0,
        cacheReadTokens: 30
      }
      const secondEvent = {
        ...firstEvent,
        eventHash: 'f'.repeat(64),
        createdAt: '2026-06-23T16:35:00.000Z',
        inputTokens: 50,
        outputTokens: 10,
        cacheReadTokens: 5
      }
      const options = {
        source: 'antigravity' as const,
        stateDir: root,
        timezone: 'UTC',
        listCascades: async () => []
      }

      const first = await collectAntigravityGuiUsage({
        ...options,
        collectedAt: '2026-06-23T16:40:00.000Z',
        readDbUsageEvents: async () => ({
          cascadeIds: new Set(['conversation-db']),
          events: [firstEvent],
          lastReadRowIndexByCascade: new Map([['conversation-db', 1]])
        })
      })
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity' })
      const second = await collectAntigravityGuiUsage({
        ...options,
        collectedAt: '2026-06-23T16:45:00.000Z',
        readDbUsageEvents: async () => ({
          cascadeIds: new Set(['conversation-db']),
          events: [secondEvent],
          lastReadRowIndexByCascade: new Map([['conversation-db', 2]])
        })
      })

      expect(first[0]?.inputTokens).toBe(100)
      expect(second).toEqual([{
        source: 'antigravity',
        usageDate: '2026-06-23',
        timezone: 'UTC',
        model: 'gemini-3-flash-a',
        inputTokens: 150,
        outputTokens: 30,
        cacheCreationTokens: 0,
        cacheReadTokens: 35,
        totalTokens: 215,
        costUsd: 0,
        sessionCount: 1,
        collectedAt: '2026-06-23T16:45:00.000Z'
      }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('extracts usage from generator metadata that also contains raw local content fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-unsafe-'))
    try {
      const snapshots = await collectAntigravityGuiUsage({
        source: 'antigravity',
        stateDir: root,
        timezone: 'UTC',
        collectedAt: '2026-06-23T16:40:00.000Z',
        listCascadeIds: async () => ['conversation-a'],
        requestGeneratorMetadata: async () => ({
          generatorMetadata: [{
            ...generatorMetadataItem({
              usage: {
                model: 'MODEL_PLACEHOLDER_M132',
                inputTokens: '33',
                outputTokens: '7',
                cacheReadTokens: '5',
                responseId: 'response-a'
              },
              responseModel: 'gemini-3-flash-a'
            }),
            conversationHistory: [{ content: 'raw prompt text' }]
          }]
        })
      })

      expect(snapshots).toEqual([{
        source: 'antigravity',
        usageDate: '2026-06-23',
        timezone: 'UTC',
        model: 'gemini-3-flash-a',
        inputTokens: 33,
        outputTokens: 7,
        cacheCreationTokens: 0,
        cacheReadTokens: 5,
        totalTokens: 45,
        costUsd: 0,
        sessionCount: 1,
        collectedAt: '2026-06-23T16:40:00.000Z'
      }])

      const cursorText = await readFile(join(root, 'antigravity-cursor.json'), 'utf8')
      expect(cursorText).not.toContain('raw prompt text')
      expect(cursorText).not.toContain('conversation-a')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps Antigravity placeholder model ids when no resolved model exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-placeholder-'))
    try {
      const snapshots = await collectAntigravityGuiUsage({
        source: 'antigravity',
        stateDir: root,
        timezone: 'UTC',
        collectedAt: '2026-02-06T02:00:00.000Z',
        listCascadeIds: async () => ['conversation-a'],
        requestGeneratorMetadata: async () => ({
          generatorMetadata: [{
            executionId: 'execution-placeholder',
            stepIndices: [4],
            chatModel: {
              model: 'MODEL_PLACEHOLDER_M12',
              chatStartMetadata: { createdAt: '2026-02-06T01:51:19.941441Z' },
              usage: {
                model: 'MODEL_PLACEHOLDER_M12',
                inputTokens: '42',
                outputTokens: '8',
                responseId: 'response-placeholder'
              }
            }
          }]
        })
      })

      expect(snapshots).toEqual([{
        source: 'antigravity',
        usageDate: '2026-02-06',
        timezone: 'UTC',
        model: 'MODEL_PLACEHOLDER_M12',
        inputTokens: 42,
        outputTokens: 8,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 50,
        costUsd: 0,
        sessionCount: 1,
        collectedAt: '2026-02-06T02:00:00.000Z'
      }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('falls back when responseModel is empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-empty-response-model-'))
    try {
      const snapshots = await collectAntigravityGuiUsage({
        source: 'antigravity',
        stateDir: root,
        timezone: 'UTC',
        collectedAt: '2026-02-06T02:00:00.000Z',
        listCascadeIds: async () => ['conversation-a'],
        requestGeneratorMetadata: async () => ({
          generatorMetadata: [{
            executionId: 'execution-empty-response-model',
            stepIndices: [4],
            chatModel: {
              model: 'MODEL_PLACEHOLDER_M12',
              responseModel: '',
              chatStartMetadata: { createdAt: '2026-02-06T01:51:19.941441Z' },
              usage: {
                model: 'gemini-3-flash-a',
                inputTokens: '42',
                outputTokens: '8',
                responseId: 'response-empty-response-model'
              }
            }
          }]
        })
      })

      expect(snapshots[0]?.model).toBe('gemini-3-flash-a')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('skips generator metadata items with empty usage payloads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-empty-usage-'))
    try {
      const snapshots = await collectAntigravityGuiUsage({
        source: 'antigravity',
        stateDir: root,
        timezone: 'UTC',
        collectedAt: '2026-02-06T02:00:00.000Z',
        listCascadeIds: async () => ['conversation-a'],
        requestGeneratorMetadata: async () => ({
          generatorMetadata: [
            {
              executionId: 'execution-empty',
              stepIndices: [47],
              error: { message: 'generation failed' },
              chatModel: {
                model: 'MODEL_PLACEHOLDER_M12',
                chatStartMetadata: { createdAt: '2026-02-06T01:51:19.941441Z' },
                usage: {}
              }
            },
            generatorMetadataItem()
          ]
        })
      })

      expect(snapshots).toHaveLength(1)
      expect(snapshots[0].inputTokens).toBe(10)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('distinguishes events that only differ by cache creation tokens', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-cache-create-'))
    try {
      const snapshots = await collectAntigravityGuiUsage({
        source: 'antigravity',
        stateDir: root,
        timezone: 'UTC',
        collectedAt: '2026-06-24T02:00:00.000Z',
        listCascadeIds: async () => ['conversation-a'],
        requestGeneratorMetadata: async () => ({
          generatorMetadata: [
            generatorMetadataItem({
              usage: {
                inputTokens: '10',
                outputTokens: '2',
                cacheCreationTokens: '3',
                responseId: 'response-cache-create'
              }
            }),
            generatorMetadataItem({
              usage: {
                inputTokens: '10',
                outputTokens: '2',
                cacheCreationTokens: '5',
                responseId: 'response-cache-create'
              }
            })
          ]
        })
      })

      expect(snapshots).toEqual([{
        source: 'antigravity',
        usageDate: '2026-06-23',
        timezone: 'UTC',
        model: 'Gemini 3.5 Flash (Medium)',
        inputTokens: 20,
        outputTokens: 4,
        cacheCreationTokens: 8,
        cacheReadTokens: 0,
        totalTokens: 32,
        costUsd: 0,
        sessionCount: 1,
        collectedAt: '2026-06-24T02:00:00.000Z'
      }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps sparse usage rows that only contain input and cache tokens', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-sparse-usage-'))
    try {
      const snapshots = await collectAntigravityGuiUsage({
        source: 'antigravity',
        stateDir: root,
        timezone: 'UTC',
        collectedAt: '2026-06-24T02:00:00.000Z',
        listCascadeIds: async () => ['conversation-a'],
        requestGeneratorMetadata: async () => ({
          generatorMetadata: [
            {
              executionId: 'execution-sparse',
              stepIndices: [145],
              chatModel: {
                model: 'MODEL_PLACEHOLDER_M47',
                responseModel: 'gemini-3-flash-c',
                chatStartMetadata: { createdAt: '2026-06-23T16:30:00.000Z' },
                usage: {
                  model: 'MODEL_PLACEHOLDER_M47',
                  inputTokens: '8901',
                  cacheReadTokens: '89389',
                  responseId: 'response-sparse'
                }
              }
            }
          ]
        })
      })

      expect(snapshots).toEqual([{
        source: 'antigravity',
        usageDate: '2026-06-23',
        timezone: 'UTC',
        model: 'gemini-3-flash-c',
        inputTokens: 8901,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 89389,
        totalTokens: 98290,
        costUsd: 0,
        sessionCount: 1,
        collectedAt: '2026-06-24T02:00:00.000Z'
      }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps invalid max language server limits bounded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-invalid-max-'))
    try {
      const calls: string[] = []
      await collectAntigravityGuiUsage({
        source: 'antigravity',
        stateDir: root,
        timezone: 'UTC',
        maxLanguageServerCascades: Number.NaN,
        listCascades: async () => Array.from({ length: 20 }, (_, index) => ({
          id: `conversation-${index}`,
          mtimeMs: 2000 - index,
          size: 20
        })),
        requestGeneratorMetadata: async (input: { cascadeId: string }) => {
          calls.push(input.cascadeId)
          return { generatorMetadata: [] }
        },
        readDbUsageEvents: async () => ({ cascadeIds: new Set<string>(), events: [] })
      })

      expect(calls).toHaveLength(12)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('bounds language server scans and resumes with cursor state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-bounded-'))
    try {
      const calls: string[] = []
      const options = {
        source: 'antigravity' as const,
        stateDir: root,
        timezone: 'UTC',
        maxLanguageServerCascades: 1,
        listCascades: async () => [
          { id: 'conversation-a', mtimeMs: 2000, size: 20 },
          { id: 'conversation-b', mtimeMs: 1000, size: 10 }
        ],
        requestGeneratorMetadata: async (input: { cascadeId: string }) => {
          calls.push(input.cascadeId)
          return generatorMetadataResponse({
            responseId: `response-${input.cascadeId}`
          })
        },
        readDbUsageEvents: async () => ({ cascadeIds: new Set<string>(), events: [] })
      }

      await collectAntigravityGuiUsage({
        ...options,
        collectedAt: '2026-06-24T02:00:00.000Z'
      })
      await collectAntigravityGuiUsage({
        ...options,
        collectedAt: '2026-06-24T02:05:00.000Z'
      })

      expect(calls).toEqual(['conversation-a', 'conversation-b'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('persists successful language server cursor progress before a later cascade fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-partial-ls-'))
    try {
      const calls: string[] = []
      const options = {
        source: 'antigravity' as const,
        stateDir: root,
        timezone: 'UTC',
        listCascades: async () => [
          { id: 'conversation-a', mtimeMs: 2000, size: 20 },
          { id: 'conversation-b', mtimeMs: 1000, size: 10 }
        ],
        requestGeneratorMetadata: async (input: { cascadeId: string }) => {
          calls.push(input.cascadeId)
          if (input.cascadeId === 'conversation-b') throw new Error('metadata unavailable')
          return generatorMetadataResponse({ responseId: `response-${input.cascadeId}` })
        },
        readDbUsageEvents: async () => ({ cascadeIds: new Set<string>(), events: [] })
      }

      await expect(collectAntigravityGuiUsage({
        ...options,
        collectedAt: '2026-06-24T02:00:00.000Z'
      })).rejects.toThrow('metadata unavailable')
      expect(calls).toEqual(['conversation-a', 'conversation-b'])

      calls.length = 0
      await expect(collectAntigravityGuiUsage({
        ...options,
        collectedAt: '2026-06-24T02:05:00.000Z'
      })).rejects.toThrow('metadata unavailable')
      expect(calls).toEqual(['conversation-b'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('throws partial usage with DB snapshots when optional language server metadata is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-db-without-ls-'))
    const dbEvent = {
      cascadeHash: 'c'.repeat(64),
      eventHash: 'e'.repeat(64),
      createdAt: '2026-06-23T16:30:00.000Z',
      model: 'gemini-3-flash-a',
      inputTokens: 100,
      outputTokens: 20,
      cacheCreationTokens: 0,
      cacheReadTokens: 30
    }
    try {
      let run = 0
      const options = {
        source: 'antigravity',
        stateDir: root,
        timezone: 'UTC',
        languageServerPath: '/missing/tokenboard-antigravity-language-server',
        listCascades: async () => [
          { id: 'conversation-a', mtimeMs: 2000, size: 20 }
        ],
        readDbUsageEvents: async () => ({
          cascadeIds: run++ === 0 ? new Set(['conversation-db']) : new Set<string>(),
          events: run === 1 ? [dbEvent] : [],
          lastReadRowIndexByCascade: new Map([['conversation-db', 3]])
        })
      } satisfies Parameters<typeof collectAntigravityGuiUsage>[0]

      const first = await expectPartialAntigravitySnapshots(collectAntigravityGuiUsage({
        ...options,
        collectedAt: '2026-06-24T02:00:00.000Z'
      }))
      const second = await expectPartialAntigravitySnapshots(collectAntigravityGuiUsage({
        ...options,
        collectedAt: '2026-06-24T02:05:00.000Z'
      }))

      expect(first).toEqual([{
        source: 'antigravity',
        usageDate: '2026-06-23',
        timezone: 'UTC',
        model: 'gemini-3-flash-a',
        inputTokens: 100,
        outputTokens: 20,
        cacheCreationTokens: 0,
        cacheReadTokens: 30,
        totalTokens: 150,
        costUsd: 0,
        sessionCount: 1,
        collectedAt: '2026-06-24T02:00:00.000Z'
      }])
      expect(second).toEqual([{
        ...first[0],
        collectedAt: '2026-06-24T02:05:00.000Z'
      }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not treat empty DB history as already covered when language server data remains available', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-empty-db-gating-'))
    try {
      const calls: string[] = []
      const snapshots = await collectAntigravityGuiUsage({
        source: 'antigravity',
        stateDir: root,
        timezone: 'UTC',
        collectedAt: '2026-06-24T02:00:00.000Z',
        listCascades: async () => [
          { id: 'conversation-a', mtimeMs: 2000, size: 20 }
        ],
        readDbUsageEvents: async () => ({ cascadeIds: new Set<string>(), events: [] }),
        requestGeneratorMetadata: async (input: { cascadeId: string }) => {
          calls.push(input.cascadeId)
          return generatorMetadataResponse()
        }
      })

      expect(calls).toEqual(['conversation-a'])
      expect(snapshots).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('requests language server when DB rows produce no usable usage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-empty-db-row-'))
    const conversationDir = join(root, 'conversations')
    const cascadeId = '11111111-1111-1111-1111-111111111111'
    try {
      await mkdir(conversationDir)
      for (let index = 0; index < 300; index += 1) {
        await writeFile(join(conversationDir, `filler-${index}.txt`), 'filler')
      }
      await writeFile(join(conversationDir, `${cascadeId}.pb`), 'cascade')
      const calls: string[] = []
      const snapshots = await collectAntigravityGuiUsage({
        source: 'antigravity',
        stateDir: root,
        conversationDir,
        timezone: 'UTC',
        collectedAt: '2026-06-24T02:00:00.000Z',
        readDbUsageEvents: async () => ({
          cascadeIds: new Set<string>(),
          events: [],
          lastReadRowIndexByCascade: new Map([[cascadeId, 7]])
        }),
        requestGeneratorMetadata: async (input: { cascadeId: string }) => {
          calls.push(input.cascadeId)
          return generatorMetadataResponse()
        }
      })

      expect(calls).toEqual([cascadeId])
      expect(snapshots).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails when DB rows produce no usable usage and language server is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-empty-db-row-missing-ls-'))
    try {
      const seenCursorSizes: number[] = []
      const readDbUsageEvents = async (input?: { lastSeenRowIndexByCascadeHash?: Map<string, number> }) => {
        seenCursorSizes.push(input?.lastSeenRowIndexByCascadeHash?.size ?? 0)
        return {
          cascadeIds: new Set<string>(),
          events: [],
          lastReadRowIndexByCascade: new Map([['conversation-a', 7]])
        }
      }
      await expect(collectAntigravityGuiUsage({
        source: 'antigravity',
        stateDir: root,
        timezone: 'UTC',
        collectedAt: '2026-06-24T02:00:00.000Z',
        languageServerPath: '/missing/tokenboard-antigravity-language-server',
        listCascades: async () => [
          { id: 'conversation-a', mtimeMs: 2000, size: 20 }
        ],
        readDbUsageEvents
      })).rejects.toThrow('spawn /missing/tokenboard-antigravity-language-server ENOENT')
      await expect(collectAntigravityGuiUsage({
        source: 'antigravity',
        stateDir: root,
        timezone: 'UTC',
        collectedAt: '2026-06-24T02:05:00.000Z',
        languageServerPath: '/missing/tokenboard-antigravity-language-server',
        listCascades: async () => [
          { id: 'conversation-a', mtimeMs: 2000, size: 20 }
        ],
        readDbUsageEvents
      })).rejects.toThrow('spawn /missing/tokenboard-antigravity-language-server ENOENT')

      expect(seenCursorSizes).toEqual([0, 0])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps DB reads bounded unless full-history sync is requested', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-gui-db-limit-'))
    const previousSince = process.env.TOKENBOARD_SINCE
    const previousDefaultSince = process.env.TOKENBOARD_DEFAULT_SINCE
    try {
      const maxDbFiles: Array<number | null | undefined> = []
      const readDbUsageEvents = async (input?: { maxDbFiles?: number | null }) => {
        maxDbFiles.push(input?.maxDbFiles)
        return { cascadeIds: new Set<string>(), events: [] }
      }

      delete process.env.TOKENBOARD_SINCE
      delete process.env.TOKENBOARD_DEFAULT_SINCE
      await collectAntigravityGuiUsage({
        source: 'antigravity',
        stateDir: root,
        timezone: 'UTC',
        collectedAt: '2026-06-24T02:00:00.000Z',
        listCascades: async () => [],
        readDbUsageEvents
      })

      await collectAntigravityGuiUsage({
        source: 'antigravity',
        stateDir: root,
        timezone: 'UTC',
        collectedAt: '2026-06-24T02:03:00.000Z',
        listCascades: async () => [],
        maxDbFiles: null,
        readDbUsageEvents
      })

      process.env.TOKENBOARD_SINCE = 'all'
      await collectAntigravityGuiUsage({
        source: 'antigravity',
        stateDir: root,
        timezone: 'UTC',
        collectedAt: '2026-06-24T02:05:00.000Z',
        listCascades: async () => [],
        readDbUsageEvents
      })

      expect(maxDbFiles).toEqual([undefined, null, null])
    } finally {
      restoreEnv('TOKENBOARD_SINCE', previousSince)
      restoreEnv('TOKENBOARD_DEFAULT_SINCE', previousDefaultSince)
      await rm(root, { recursive: true, force: true })
    }
  })

  test('uses language server metadata when SQLite history is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-db-fallback-'))
    try {
      const calls: string[] = []
      const snapshots = await collectAntigravityGuiUsage({
        source: 'antigravity',
        stateDir: root,
        timezone: 'UTC',
        collectedAt: '2026-06-24T02:00:00.000Z',
        listCascades: async () => [
          { id: 'conversation-a', mtimeMs: 2000, size: 20 }
        ],
        readDbUsageEvents: async () => {
          throw new Error('Antigravity SQLite reader unavailable: sqlite3 not found')
        },
        requestGeneratorMetadata: async (input: { cascadeId: string }) => {
          calls.push(input.cascadeId)
          return generatorMetadataResponse()
        }
      })

      expect(calls).toEqual(['conversation-a'])
      expect(snapshots).toEqual([{
        source: 'antigravity',
        usageDate: '2026-06-23',
        timezone: 'UTC',
        model: 'Gemini 3.5 Flash (Medium)',
        inputTokens: 120,
        outputTokens: 24,
        cacheCreationTokens: 0,
        cacheReadTokens: 30,
        totalTokens: 174,
        costUsd: 0,
        sessionCount: 1,
        collectedAt: '2026-06-24T02:00:00.000Z'
      }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('uses language server metadata when SQLite history directory is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-missing-db-dir-fallback-'))
    try {
      const calls: string[] = []
      const snapshots = await collectAntigravityGuiUsage({
        source: 'antigravity',
        stateDir: root,
        conversationDir: join(root, 'missing-conversations'),
        timezone: 'UTC',
        collectedAt: '2026-06-24T02:00:00.000Z',
        listCascades: async () => [
          { id: 'conversation-a', mtimeMs: 2000, size: 20 }
        ],
        requestGeneratorMetadata: async (input: { cascadeId: string }) => {
          calls.push(input.cascadeId)
          return generatorMetadataResponse()
        }
      })

      expect(calls).toEqual(['conversation-a'])
      expect(snapshots).toEqual([{
        source: 'antigravity',
        usageDate: '2026-06-23',
        timezone: 'UTC',
        model: 'Gemini 3.5 Flash (Medium)',
        inputTokens: 120,
        outputTokens: 24,
        cacheCreationTokens: 0,
        cacheReadTokens: 30,
        totalTokens: 174,
        costUsd: 0,
        sessionCount: 1,
        collectedAt: '2026-06-24T02:00:00.000Z'
      }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('surfaces SQLite errors when language server fallback has no usable events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-db-fallback-empty-'))
    try {
      await expect(collectAntigravityGuiUsage({
        source: 'antigravity',
        stateDir: root,
        timezone: 'UTC',
        collectedAt: '2026-06-24T02:00:00.000Z',
        listCascades: async () => [
          { id: 'conversation-a', mtimeMs: 2000, size: 20 }
        ],
        readDbUsageEvents: async () => {
          throw new Error('Failed to read Antigravity SQLite metadata from conversation-a.db')
        },
        requestGeneratorMetadata: async () => ({ generatorMetadata: [] })
      })).rejects.toThrow('Failed to read Antigravity SQLite metadata from conversation-a.db')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('surfaces real SQLite errors before language server fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-db-fallback-real-error-'))
    try {
      const calls: string[] = []
      await expect(collectAntigravityGuiUsage({
        source: 'antigravity',
        stateDir: root,
        timezone: 'UTC',
        collectedAt: '2026-06-24T02:00:00.000Z',
        listCascades: async () => [
          { id: 'conversation-a', mtimeMs: 2000, size: 20 }
        ],
        readDbUsageEvents: async () => {
          throw new Error('Failed to read Antigravity SQLite metadata from conversation-a.db')
        },
        requestGeneratorMetadata: async (input: { cascadeId: string }) => {
          calls.push(input.cascadeId)
          return generatorMetadataResponse()
        }
      })).rejects.toThrow('Failed to read Antigravity SQLite metadata from conversation-a.db')

      expect(calls).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('retries language server cascades that produce no usable events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-empty-ls-retry-'))
    try {
      const calls: string[] = []
      const options = {
        source: 'antigravity' as const,
        stateDir: root,
        timezone: 'UTC',
        listCascades: async () => [
          { id: 'conversation-a', mtimeMs: 2000, size: 20 }
        ],
        readDbUsageEvents: async () => ({ cascadeIds: new Set<string>(), events: [] }),
        requestGeneratorMetadata: async (input: { cascadeId: string }) => {
          calls.push(input.cascadeId)
          return { generatorMetadata: [] }
        }
      }

      await collectAntigravityGuiUsage({
        ...options,
        collectedAt: '2026-06-24T02:00:00.000Z'
      })
      await collectAntigravityGuiUsage({
        ...options,
        collectedAt: '2026-06-24T02:05:00.000Z'
      })

      expect(calls).toEqual(['conversation-a', 'conversation-a'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps acknowledged DB history cursors so old events do not upload again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-old-db-'))
    const oldDbEvent = {
      cascadeHash: 'c'.repeat(64),
      eventHash: 'e'.repeat(64),
      createdAt: '2026-01-01T10:00:00.000Z',
      model: 'gemini-3-flash-a',
      inputTokens: 100,
      outputTokens: 20,
      cacheCreationTokens: 0,
      cacheReadTokens: 30
    }
    try {
      const options = {
        source: 'antigravity' as const,
        stateDir: root,
        timezone: 'UTC',
        listCascades: async () => [],
        readDbUsageEvents: async () => ({
          cascadeIds: new Set(['conversation-db']),
          events: [oldDbEvent]
        })
      }

      const first = await collectAntigravityGuiUsage({
        ...options,
        collectedAt: '2026-01-01T10:05:00.000Z'
      })
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity' })
      const second = await collectAntigravityGuiUsage({
        ...options,
        collectedAt: '2026-06-24T02:00:00.000Z'
      })

      expect(first).toHaveLength(1)
      expect(second).toEqual([])
      const cursorText = await readFile(join(root, 'antigravity-cursor.json'), 'utf8')
      expect(cursorText).toContain('gemini-3-flash-a')
      expect(cursorText).not.toContain('conversation-db')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps acknowledged DB-covered cascades from falling back to unavailable language server', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-db-covered-'))
    const oldDbEvent = {
      cascadeHash: 'c'.repeat(64),
      eventHash: 'e'.repeat(64),
      createdAt: '2026-01-01T10:00:00.000Z',
      model: 'gemini-3-flash-a',
      inputTokens: 100,
      outputTokens: 20,
      cacheCreationTokens: 0,
      cacheReadTokens: 30
    }
    try {
      let run = 0
      const options = {
        source: 'antigravity' as const,
        stateDir: root,
        timezone: 'UTC',
        languageServerPath: '/missing/tokenboard-antigravity-language-server',
        listCascades: async () => [
          { id: 'conversation-db', mtimeMs: 2000, size: 20 }
        ],
        readDbUsageEvents: async () => {
          run += 1
          return run === 1
            ? {
                cascadeIds: new Set(['conversation-db']),
                events: [oldDbEvent],
                lastReadRowIndexByCascade: new Map([['conversation-db', 1]])
              }
            : {
                cascadeIds: new Set<string>(),
                events: [],
                lastReadRowIndexByCascade: new Map()
              }
        }
      }

      const first = await collectAntigravityGuiUsage({
        ...options,
        collectedAt: '2026-01-01T10:05:00.000Z'
      })
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity' })
      const second = await collectAntigravityGuiUsage({
        ...options,
        collectedAt: '2026-06-24T02:00:00.000Z'
      })

      expect(first).toHaveLength(1)
      expect(second).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps DB-covered markers when default cascade listing filters language-server requests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-db-covered-default-list-'))
    const conversationDir = join(root, 'conversations')
    const cascadeId = '11111111-1111-1111-1111-111111111111'
    const oldDbEvent = {
      cascadeHash: 'c'.repeat(64),
      eventHash: 'e'.repeat(64),
      createdAt: '2026-01-01T10:00:00.000Z',
      model: 'gemini-3-flash-a',
      inputTokens: 100,
      outputTokens: 20,
      cacheCreationTokens: 0,
      cacheReadTokens: 30
    }
    try {
      await mkdir(conversationDir)
      for (let index = 0; index < 300; index += 1) {
        await writeFile(join(conversationDir, `filler-${index}.txt`), 'filler')
      }
      await writeFile(join(conversationDir, `${cascadeId}.pb`), 'cascade')
      let run = 0
      const options = {
        source: 'antigravity' as const,
        stateDir: root,
        conversationDir,
        timezone: 'UTC',
        languageServerPath: '/missing/tokenboard-antigravity-language-server',
        readDbUsageEvents: async () => {
          run += 1
          return run === 1
            ? {
                cascadeIds: new Set([cascadeId]),
                events: [oldDbEvent],
                lastReadRowIndexByCascade: new Map([[cascadeId, 1]])
              }
            : {
                cascadeIds: new Set<string>(),
                events: [],
                lastReadRowIndexByCascade: new Map([[cascadeId, 1]])
              }
        }
      }

      const first = await collectAntigravityGuiUsage({
        ...options,
        collectedAt: '2026-01-01T10:05:00.000Z'
      })
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity' })
      const second = await collectAntigravityGuiUsage({
        ...options,
        collectedAt: '2026-06-24T02:00:00.000Z'
      })

      expect(first).toHaveLength(1)
      expect(second).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('requests language server for DB-covered cascades after the cascade file changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-db-covered-changed-'))
    const oldDbEvent = {
      cascadeHash: 'c'.repeat(64),
      eventHash: 'e'.repeat(64),
      createdAt: '2026-01-01T10:00:00.000Z',
      model: 'gemini-3-flash-a',
      inputTokens: 100,
      outputTokens: 20,
      cacheCreationTokens: 0,
      cacheReadTokens: 30
    }
    try {
      let run = 0
      const calls: string[] = []
      const options = {
        source: 'antigravity' as const,
        stateDir: root,
        timezone: 'UTC',
        listCascades: async () => [
          run === 1
            ? { id: 'conversation-db', mtimeMs: 2000, size: 20 }
            : { id: 'conversation-db', mtimeMs: 3000, size: 30 }
        ],
        readDbUsageEvents: async () => {
          run += 1
          return run === 1
            ? {
                cascadeIds: new Set(['conversation-db']),
                events: [oldDbEvent],
                lastReadRowIndexByCascade: new Map([['conversation-db', 1]])
              }
            : {
                cascadeIds: new Set<string>(),
                events: [],
                lastReadRowIndexByCascade: new Map()
              }
        },
        requestGeneratorMetadata: async (input: { cascadeId: string }) => {
          calls.push(input.cascadeId)
          return generatorMetadataResponse({ responseId: 'response-new' })
        }
      }

      await collectAntigravityGuiUsage({
        ...options,
        collectedAt: '2026-01-01T10:05:00.000Z'
      })
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity' })
      const second = await collectAntigravityGuiUsage({
        ...options,
        collectedAt: '2026-06-24T02:00:00.000Z'
      })

      expect(calls).toEqual(['conversation-db'])
      expect(second).toHaveLength(1)
      expect(second[0]?.inputTokens).toBe(120)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps acknowledged language server cascade cursors so old cascades are not requested again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-old-ls-'))
    try {
      const calls: string[] = []
      const options = {
        source: 'antigravity' as const,
        stateDir: root,
        timezone: 'UTC',
        listCascades: async () => [
          { id: 'conversation-a', mtimeMs: Date.parse('2026-01-01T10:00:00.000Z'), size: 20 }
        ],
        requestGeneratorMetadata: async (input: { cascadeId: string }) => {
          calls.push(input.cascadeId)
          return generatorMetadataResponse()
        },
        readDbUsageEvents: async () => ({ cascadeIds: new Set<string>(), events: [] })
      }

      await collectAntigravityGuiUsage({
        ...options,
        collectedAt: '2026-01-01T10:05:00.000Z'
      })
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity' })
      await collectAntigravityGuiUsage({
        ...options,
        collectedAt: '2026-06-24T02:00:00.000Z'
      })

      expect(calls).toEqual(['conversation-a'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects unbounded and fractional token metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-invalid-'))
    try {
      await expect(collectAntigravityGuiUsage({
        source: 'antigravity',
        stateDir: root,
        listCascadeIds: async () => ['conversation-a'],
        requestGeneratorMetadata: async () => ({
          generatorMetadata: [generatorMetadataItem({
            usage: { inputTokens: '1.5' }
          })]
        })
      })).rejects.toThrow('inputTokens must be a bounded nonnegative integer')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects non-ISO generator metadata timestamps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-invalid-date-'))
    try {
      await expect(collectAntigravityGuiUsage({
        source: 'antigravity',
        stateDir: root,
        listCascadeIds: async () => ['conversation-a'],
        requestGeneratorMetadata: async () => ({
          generatorMetadata: [{
            executionId: 'execution-a',
            stepIndices: [3],
            chatModel: {
              model: 'Gemini 3.5 Flash (Medium)',
              chatStartMetadata: { createdAt: 'June 23, 2026 10:00:00' },
              usage: {
                model: 'Gemini 3.5 Flash (Medium)',
                inputTokens: '10',
                outputTokens: '2',
                responseId: 'response-a'
              }
            }
          }]
        })
      })).rejects.toThrow('createdAt must be an ISO datetime')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function generatorMetadataResponse(options: { source?: AntigravityGuiSource; responseId?: string } = {}) {
  const responseId = options.responseId ?? 'response-a'
  return {
    generatorMetadata: [
      generatorMetadataItem({
        usage: {
          model: 'Gemini 3.5 Flash (Medium)',
          inputTokens: '100',
          outputTokens: '20',
          thinkingOutputTokens: '15',
          responseOutputTokens: '5',
          cacheReadTokens: '30',
          responseId,
          responseHeader: { sessionID: 'session-a' }
        }
      }),
      generatorMetadataItem({
        usage: {
          model: 'Gemini 3.5 Flash (Medium)',
          inputTokens: '100',
          outputTokens: '20',
          cacheReadTokens: '30',
          responseId,
          responseHeader: { sessionID: 'session-a' }
        }
      }),
      generatorMetadataItem({
        executionId: options.source === 'antigravity-ide' ? 'execution-ide-b' : 'execution-b',
        stepIndices: [4],
        usage: {
          model: 'Gemini 3.5 Flash (Medium)',
          inputTokens: '20',
          outputTokens: '4',
          cacheReadTokens: '0',
          responseId: options.source === 'antigravity-ide' ? 'response-ide-b' : 'response-b'
        }
      })
    ]
  }
}

async function expectPartialAntigravitySnapshots(promise: Promise<unknown>) {
  try {
    await promise
    throw new Error('Expected partial Antigravity usage error')
  } catch (error) {
    expect(isAntigravityPartialUsageError(error)).toBe(true)
    if (!isAntigravityPartialUsageError(error)) throw error
    return error.snapshots
  }
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name]
    return
  }
  process.env[name] = value
}

function generatorMetadataItem(overrides: {
  executionId?: string
  stepIndices?: number[]
  usage?: Record<string, unknown>
  responseModel?: string
} = {}) {
  return {
    executionId: overrides.executionId ?? 'execution-a',
    stepIndices: overrides.stepIndices ?? [3],
    chatModel: {
      model: 'Gemini 3.5 Flash (Medium)',
      ...(overrides.responseModel ? { responseModel: overrides.responseModel } : {}),
      chatStartMetadata: { createdAt: '2026-06-23T16:30:00.000Z' },
      usage: {
        model: 'Gemini 3.5 Flash (Medium)',
        inputTokens: '10',
        outputTokens: '2',
        cacheReadTokens: '0',
        responseId: 'response-a',
        ...(overrides.usage ?? {})
      }
    }
  }
}
