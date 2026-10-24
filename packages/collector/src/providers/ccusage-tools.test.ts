import { describe, expect, test } from 'vitest'
import { ccusageToolCommandNames, ccusageToolSources } from '@tokenboard/usage-core'
import type { CommandRunner } from '../command'
import { collectCcusageToolUsage, type CollectCcusageToolOptions } from './ccusage-tools'
import type { PackageRunner } from '../package-runner'

const timezone = 'Asia/Shanghai'
const collectedAt = '2026-10-14T10:00:00.000Z'

function dailyJson(date: string, overrides: Record<string, unknown> = {}) {
  return {
    daily: [
      {
        date,
        inputTokens: 100,
        outputTokens: 20,
        cacheCreationTokens: 5,
        cacheReadTokens: 10,
        totalTokens: 135,
        totalCost: 0.25,
        modelsUsed: ['test-model'],
        modelBreakdowns: [
          {
            modelName: 'test-model',
            inputTokens: 100,
            outputTokens: 20,
            cacheCreationTokens: 5,
            cacheReadTokens: 10,
            totalTokens: 135,
            cost: 0.25
          }
        ],
        ...overrides
      }
    ]
  }
}

function sessionJson(sessionId: string, date?: string) {
  const row: Record<string, unknown> = {
    sessionId,
    inputTokens: 50,
    outputTokens: 10,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 60,
    totalCost: 0.05,
    modelsUsed: ['test-model'],
    modelBreakdowns: []
  }
  if (date) row.lastActivity = date
  return { sessions: [row] }
}

const recordingRunner = (responses: Map<string, unknown>, calls: string[][]): CommandRunner => {
  const runner = async (_command: string, args: string[]): Promise<unknown> => {
    calls.push(args)
    const key = args.join(' ')
    const response = responses.get(key)
    if (response === undefined) throw new Error(`unexpected command: ${key}`)
    return response
  }
  return runner
}

const recordingPackageRunner = (calls: string[]) => {
  const packageRunner: PackageRunner = {
    command: 'ccusage-bin',
    runPackageArgs: (_specifier, _binary, packageArgs) => {
      calls.push(packageArgs.join(' '))
      return packageArgs
    }
  }
  return packageRunner
}

const baseOptions: CollectCcusageToolOptions = {
  timezone,
  collectedAt,
  env: {}
}

describe('ccusage tool providers', () => {
  test('covers every ccusage tool source', () => {
    expect(Object.keys(ccusageToolCommandNames).sort()).toEqual([...ccusageToolSources].sort())
  })

  test('collects daily snapshots with session counts per tool subcommand', async () => {
    const runnerCalls: string[][] = []
    const packageCalls: string[] = []
    const runner = recordingRunner(
      new Map<string, unknown>([
        ['amp daily --json --timezone Asia/Shanghai', dailyJson('2026-10-13')],
        ['amp session --json --timezone Asia/Shanghai', sessionJson('s1', '2026-10-13T01:00:00Z')]
      ]),
      runnerCalls
    )
    const packageRunner = recordingPackageRunner(packageCalls)

    const snapshots = await collectCcusageToolUsage('amp', { ...baseOptions, runner, packageRunner })

    expect(packageCalls).toEqual([
      'amp daily --json --timezone Asia/Shanghai',
      'amp session --json --timezone Asia/Shanghai'
    ])
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toMatchObject({
      source: 'amp',
      usageDate: '2026-10-13',
      timezone,
      model: 'test-model',
      inputTokens: 100,
      outputTokens: 20,
      cacheCreationTokens: 5,
      cacheReadTokens: 10,
      totalTokens: 135,
      costUsd: 0.25,
      sessionCount: 1,
      collectedAt
    })
  })

  test('keeps sessionCount at zero when the session report carries no dates', async () => {
    const runner = recordingRunner(
      new Map<string, unknown>([
        ['amp daily --json --timezone Asia/Shanghai', dailyJson('2026-10-13')],
        ['amp session --json --timezone Asia/Shanghai', sessionJson('s-no-date')]
      ]),
      []
    )
    const snapshots = await collectCcusageToolUsage('amp', {
      ...baseOptions,
      runner,
      packageRunner: recordingPackageRunner([])
    })
    expect(snapshots[0].sessionCount).toBe(0)
  })

  test('uses the gemini subcommand for the gemini-cli source', async () => {
    const packageCalls: string[] = []
    const runner = recordingRunner(
      new Map<string, unknown>([
        ['gemini daily --json --timezone Asia/Shanghai', dailyJson('2026-10-13')],
        ['gemini session --json --timezone Asia/Shanghai', { sessions: [] }]
      ]),
      []
    )
    await collectCcusageToolUsage('gemini-cli', {
      ...baseOptions,
      runner,
      packageRunner: recordingPackageRunner(packageCalls)
    })
    expect(packageCalls[0]).toBe('gemini daily --json --timezone Asia/Shanghai')
    expect(packageCalls[1]).toBe('gemini session --json --timezone Asia/Shanghai')
  })

  test('passes since and until through to both subcommands', async () => {
    const packageCalls: string[] = []
    const runner = recordingRunner(
      new Map<string, unknown>([
        ['kimi daily --json --since 2026-10-09 --until 2026-10-10 --timezone Asia/Shanghai', dailyJson('2026-10-09')],
        ['kimi session --json --since 2026-10-09 --until 2026-10-10 --timezone Asia/Shanghai', { sessions: [] }]
      ]),
      []
    )
    const snapshots = await collectCcusageToolUsage('kimi', {
      ...baseOptions,
      runner,
      packageRunner: recordingPackageRunner(packageCalls),
      since: '2026-10-09',
      until: '2026-10-10'
    })
    expect(snapshots).toHaveLength(1)
    expect(packageCalls[0]).toContain('--since 2026-10-09')
    expect(packageCalls[1]).toContain('--until 2026-10-10')
  })

  test('returns empty snapshots for an empty daily report', async () => {
    const runner = recordingRunner(
      new Map<string, unknown>([
        ['droid daily --json --timezone Asia/Shanghai', { daily: [] }],
        ['droid session --json --timezone Asia/Shanghai', { sessions: [] }]
      ]),
      []
    )
    const snapshots = await collectCcusageToolUsage('droid', {
      ...baseOptions,
      runner,
      packageRunner: recordingPackageRunner([])
    })
    expect(snapshots).toEqual([])
  })

  // ccusage exits 0 with an empty daily report for a tool that is not installed, so
  // most machines would pay the second spawn for nothing on every run.
  test('skips the session report when the daily report is empty', async () => {
    const packageCalls: string[] = []
    const runner = recordingRunner(
      new Map<string, unknown>([['zcode daily --json --timezone Asia/Shanghai', { daily: [], totals: null }]]),
      []
    )
    const snapshots = await collectCcusageToolUsage('zcode', {
      ...baseOptions,
      runner,
      packageRunner: recordingPackageRunner(packageCalls)
    })
    expect(snapshots).toEqual([])
    expect(packageCalls).toEqual(['zcode daily --json --timezone Asia/Shanghai'])
  })

  test('rejects a source outside the ccusage tool family', async () => {
    await expect(
      collectCcusageToolUsage('deepseek-harness' as never, {
        ...baseOptions,
        runner: recordingRunner(new Map(), []),
        packageRunner: recordingPackageRunner([])
      })
    ).rejects.toThrow(/not a ccusage tool source/)
  })
})
