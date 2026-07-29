import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { collectCodexUsage } from './codex'
import { readChildLastUsageByDate } from './codex-subagent-usage-child'
import { createEmptyCodexHome, writeJsonl } from './codex-test-helpers'
import { subagentSessionMeta, totalUsageEvent } from './codex-subagent-usage-test-helpers'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Codex subagent usage validation', () => {
  test('skips an invalid child event while retaining later valid usage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-subagent-validation-'))
    const filePath = join(root, 'child.jsonl')
    const diagnostics: string[] = []

    try {
      await writeJsonl(filePath, [
        totalUsageEvent('2026-05-25T01:10:00.000Z', {
          inputTokens: 10,
          cacheReadTokens: 11,
          outputTokens: 1
        }),
        totalUsageEvent('2026-05-25T01:20:00.000Z', {
          inputTokens: 20,
          cacheReadTokens: 10,
          outputTokens: 2
        })
      ])

      await expect(readChildLastUsageByDate(
        filePath,
        '2026-05-25T00:00:00.000Z',
        'Asia/Shanghai',
        (line) => diagnostics.push(line)
      )).resolves.toEqual([
        expect.objectContaining({
          usageDate: '2026-05-25',
          inputTokens: 20,
          cacheReadTokens: 10,
          outputTokens: 2,
          totalTokens: 22
        })
      ])
      expect(diagnostics).toEqual([
        'Skipping Codex subagent usage event with cache read tokens exceeding input tokens'
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps the raw Codex aggregate when an invalid child event cannot be corrected', async () => {
    const codexHome = await createEmptyCodexHome()
    const childFile = join(codexHome, 'sessions', '2026', '05', '25', 'rollout-child.jsonl')
    const diagnostics: string[] = []
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(childFile, [
        subagentSessionMeta('child', 'parent', '2026-05-25T01:00:00.000Z'),
        totalUsageEvent('2026-05-25T01:10:00.000Z', {
          inputTokens: 10,
          cacheReadTokens: 11,
          outputTokens: 1
        })
      ])

      await expect(collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-25T01:20:00.000Z',
        stderr: (line) => diagnostics.push(line),
        async runner(_command, args) {
          return args.includes('session') ? childSessionResult() : childDailyResult()
        }
      })).resolves.toEqual([
        expect.objectContaining({
          source: 'codex',
          usageDate: '2026-05-25',
          model: 'gpt-5',
          inputTokens: 50,
          outputTokens: 10,
          cacheReadTokens: 50,
          totalTokens: 110,
          sessionCount: 1
        })
      ])
      expect(diagnostics).toContain(
        'Skipping Codex subagent usage event with cache read tokens exceeding input tokens'
      )
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })
})

function childDailyResult() {
  return {
    daily: [{
      date: '2026-05-25',
      models: {
        'gpt-5': {
          inputTokens: 50,
          cachedInputTokens: 50,
          outputTokens: 10,
          totalTokens: 110
        }
      },
      totalTokens: 110,
      costUSD: 0.11
    }]
  }
}

function childSessionResult() {
  return {
    sessions: [{
      sessionId: '2026/05/25/rollout-child',
      lastActivity: '2026-05-25T01:10:00.000Z',
      totalTokens: 110,
      costUSD: 0.11,
      models: {
        'gpt-5': {
          inputTokens: 50,
          cachedInputTokens: 50,
          outputTokens: 10,
          totalTokens: 110,
          costUSD: 0.11
        }
      }
    }]
  }
}
