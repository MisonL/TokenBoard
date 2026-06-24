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

  test('rejects generator metadata that contains raw conversation content fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-unsafe-'))
    try {
      await expect(collectAntigravityGuiUsage({
        source: 'antigravity',
        stateDir: root,
        listCascadeIds: async () => ['conversation-a'],
        requestGeneratorMetadata: async () => ({
          generatorMetadata: [{
            ...generatorMetadataItem(),
            conversationHistory: [{ content: 'raw prompt text' }]
          }]
        })
      })).rejects.toThrow('raw content field generatorMetadata[0].conversationHistory')
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
})

function generatorMetadataResponse(options: { source?: AntigravityGuiSource } = {}) {
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
          responseId: 'response-a',
          responseHeader: { sessionID: 'session-a' }
        }
      }),
      generatorMetadataItem({
        usage: {
          model: 'Gemini 3.5 Flash (Medium)',
          inputTokens: '100',
          outputTokens: '20',
          cacheReadTokens: '30',
          responseId: 'response-a',
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
} = {}) {
  return {
    executionId: overrides.executionId ?? 'execution-a',
    stepIndices: overrides.stepIndices ?? [3],
    chatModel: {
      model: 'Gemini 3.5 Flash (Medium)',
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
