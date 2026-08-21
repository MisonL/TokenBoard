import { describe, expect, test } from 'vitest'
import type { UsageSnapshot } from '@tokenboard/usage-core'
import { runCollectorCli } from './cli'

const openCodeSnapshot: UsageSnapshot = {
  source: 'opencode',
  usageDate: '2026-05-26',
  timezone: 'Asia/Shanghai',
  model: 'deepseek-v4-pro',
  inputTokens: 3272,
  outputTokens: 802,
  cacheCreationTokens: 0,
  cacheReadTokens: 52_480,
  totalTokens: 56_554,
  costUsd: 0.0023113,
  sessionCount: 1,
  collectedAt: '2026-05-26T10:00:00.000Z'
}

const claudeSnapshot: UsageSnapshot = {
  ...openCodeSnapshot,
  source: 'claude-code',
  model: 'claude-sonnet-4-5',
  costUsd: 0.01
}

const env = { TOKENBOARD_TIMEZONE: 'Asia/Shanghai', TOKENBOARD_STATE_DIR: '/state' }

describe('runCollectorCli OpenCode source', () => {
  test('previews the selected OpenCode source', async () => {
    const stdout: string[] = []

    const result = await runCollectorCli(
      ['preview', '--source', 'opencode'],
      env,
      deps({
        stdout: (line) => stdout.push(line),
        collectOpenCodeUsage: async (options) => {
          expect(options?.timezone).toBe('Asia/Shanghai')
          return [openCodeSnapshot]
        }
      })
    )

    expect(result).toBe(0)
    expect(JSON.parse(stdout[0])).toEqual([openCodeSnapshot])
  })

  test('includes OpenCode in an all-source collection', async () => {
    const stdout: string[] = []

    const result = await runCollectorCli(
      ['preview', '--source', 'all'],
      env,
      deps({
        stdout: (line) => stdout.push(line),
        collectClaudeCodeUsage: async () => [claudeSnapshot],
        collectOpenCodeUsage: async () => [openCodeSnapshot]
      })
    )

    expect(result).toBe(0)
    expect(JSON.parse(stdout[0]).map((item: UsageSnapshot) => item.source).sort())
      .toEqual(['claude-code', 'opencode'])
  })

  test('skips OpenCode without failing when it is not installed', async () => {
    const stderr: string[] = []

    const result = await runCollectorCli(
      ['preview', '--source', 'all'],
      env,
      deps({
        stderr: (line) => stderr.push(line),
        collectClaudeCodeUsage: async () => [claudeSnapshot],
        collectOpenCodeUsage: async () => {
          throw new Error('OpenCode database not found: /home/user/.local/share/opencode/opencode.db')
        }
      })
    )

    expect(result).toBe(0)
    // The diagnostic must name OpenCode, not the Antigravity collection it reuses.
    expect(stderr.join('\n')).toContain('Skipping unavailable opencode source')
    expect(stderr.join('\n')).not.toContain('Antigravity collection')
  })

  test('reports a genuine OpenCode failure in an all-source run', async () => {
    const result = await runCollectorCli(
      ['preview', '--source', 'all'],
      env,
      deps({
        collectClaudeCodeUsage: async () => [claudeSnapshot],
        collectOpenCodeUsage: async () => { throw new Error('database disk image is malformed') }
      })
    )

    expect(result).toBe(1)
  })

  test('fails an explicit OpenCode run when the source is unavailable', async () => {
    const result = await runCollectorCli(
      ['preview', '--source', 'opencode'],
      env,
      deps({
        collectOpenCodeUsage: async () => { throw new Error('OpenCode database not found: /db') }
      })
    )

    expect(result).toBe(1)
  })

  test('omits OpenCode from hook-mode collection', async () => {
    let calledOpenCode = false

    const result = await runCollectorCli(
      ['preview', '--source', 'all'],
      { ...env, TOKENBOARD_HOOK_MODE: '1' },
      deps({
        collectClaudeCodeUsage: async () => [claudeSnapshot],
        collectOpenCodeUsage: async () => { calledOpenCode = true; return [openCodeSnapshot] }
      })
    )

    expect(result).toBe(0)
    expect(calledOpenCode).toBe(false)
  })

  test('never warms a hook cursor for OpenCode', async () => {
    const warmed: string[] = []

    const result = await runCollectorCli(
      ['warm-hooks', '--source', 'opencode'],
      { ...env, TOKENBOARD_SINCE: 'all' },
      deps({
        warmHookCursorHighWater: async (input: { source: string }) => {
          warmed.push(input.source)
        }
      })
    )

    expect(result).toBe(0)
    expect(warmed).toEqual([])
  })

  test('rejects an unknown source', async () => {
    const result = await runCollectorCli(['preview', '--source', 'open-code'], env, deps())

    expect(result).toBe(1)
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
