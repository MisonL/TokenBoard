import { describe, expect, test } from 'vitest'
import type { UsageSnapshot } from '@tokenboard/usage-core'
import { runCollectorCli } from './cli'

const antigravitySnapshot: UsageSnapshot = {
  source: 'antigravity-cli',
  usageDate: '2026-06-23',
  timezone: 'Asia/Shanghai',
  model: 'Gemini 3.5 Flash (Medium)',
  inputTokens: 10,
  outputTokens: 2,
  cacheCreationTokens: 0,
  cacheReadTokens: 5,
  totalTokens: 17,
  costUsd: 0,
  sessionCount: 1,
  collectedAt: '2026-06-23T10:00:00.000Z'
}

describe('runCollectorCli Antigravity source', () => {
  test('previews the selected Antigravity CLI source', async () => {
    const stdout: string[] = []

    const result = await runCollectorCli(
      ['preview', '--source', 'antigravity-cli'],
      { TOKENBOARD_TIMEZONE: 'Asia/Shanghai', TOKENBOARD_STATE_DIR: '/state' },
      deps({
        stdout: (line) => stdout.push(line),
        collectAntigravityCliUsage: async (options) => {
          expect(options?.stateDir).toBe('/state')
          return [antigravitySnapshot]
        }
      })
    )

    expect(result).toBe(0)
    expect(JSON.parse(stdout[0])).toEqual([antigravitySnapshot])
  })

  test('treats missing Antigravity statusline capture as optional in all mode', async () => {
    const stderr: string[] = []

    const result = await runCollectorCli(
      ['preview', '--source', 'all'],
      { TOKENBOARD_TIMEZONE: 'Asia/Shanghai' },
      deps({
        stderr: (line) => stderr.push(line),
        collectAntigravityCliUsage: async () => {
          throw new Error('Antigravity CLI statusline log not found: /state/antigravity-cli-statusline.jsonl')
        }
      })
    )

    expect(result).toBe(0)
    expect(stderr).toEqual([
      'Skipping antigravity-cli source: Antigravity CLI statusline log not found: /state/antigravity-cli-statusline.jsonl'
    ])
  })
})

function deps(overrides: Partial<Parameters<typeof runCollectorCli>[2]> = {}) {
  return {
    stdout: () => undefined,
    stderr: () => undefined,
    collectClaudeCodeUsage: async () => [],
    collectCodexUsage: async () => [],
    uploadSnapshots: async () => ({ upserted: 0, skipped: 0 }),
    ...overrides
  }
}
