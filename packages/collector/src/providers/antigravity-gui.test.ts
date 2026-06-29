import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { clearPendingUploadCursors } from './session-cursor'
import {
  collectAntigravityGuiUsage,
  collectAntigravityIdeUsage,
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

  test('fails when language server metadata is unavailable for uncaptured cascades', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-db-without-ls-'))
    try {
      await expect(collectAntigravityGuiUsage({
        source: 'antigravity',
        stateDir: root,
        timezone: 'UTC',
        collectedAt: '2026-06-24T02:00:00.000Z',
        languageServerPath: '/missing/tokenboard-antigravity-language-server',
        listCascades: async () => [
          { id: 'conversation-a', mtimeMs: 2000, size: 20 }
        ],
        readDbUsageEvents: async () => ({
          cascadeIds: new Set(['conversation-db']),
          events: [{
            cascadeHash: 'c'.repeat(64),
            eventHash: 'e'.repeat(64),
            createdAt: '2026-06-23T16:30:00.000Z',
            model: 'gemini-3-flash-a',
            inputTokens: 100,
            outputTokens: 20,
            cacheCreationTokens: 0,
            cacheReadTokens: 30
          }]
        })
      })).rejects.toThrow('spawn /missing/tokenboard-antigravity-language-server ENOENT')
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
