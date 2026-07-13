import { describe, expect, test } from 'vitest'
import { parseGeneratorMetadata } from './antigravity-gui-parser'

describe('parseGeneratorMetadata', () => {
  test.each([
    '2025-02-29T00:00:00Z',
    '2026-02-30T00:00:00Z',
    '2026-04-31T00:00:00Z'
  ])('rejects nonexistent calendar date %s', (createdAt) => {
    expect(() => parseGeneratorMetadata(metadataResponse(createdAt), 'conversation-a'))
      .toThrow('createdAt must be an ISO datetime')
  })

  test('accepts a valid leap day with fractional seconds and an offset', () => {
    const createdAt = '2024-02-29T23:59:59.123456789+14:00'

    expect(parseGeneratorMetadata(metadataResponse(createdAt), 'conversation-a')[0]?.createdAt)
      .toBe(createdAt)
  })
})

function metadataResponse(createdAt: string) {
  return {
    generatorMetadata: [{
      executionId: 'execution-a',
      stepIndices: [3],
      chatModel: {
        model: 'Gemini 3.5 Flash (Medium)',
        chatStartMetadata: { createdAt },
        usage: {
          inputTokens: '10',
          outputTokens: '2',
          responseId: 'response-a'
        }
      }
    }]
  }
}
