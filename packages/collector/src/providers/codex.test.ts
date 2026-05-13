import { afterEach, describe, expect, test, vi } from 'vitest'
import type { CommandRunnerOptions } from '../command'
import { collectCodexUsage } from './codex'

describe('collectCodexUsage', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('runs codex ccusage daily json and normalizes cache input aliases', async () => {
    const calls: Array<{ command: string; args: string[]; options?: CommandRunnerOptions }> = []
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')
    const snapshots = await collectCodexUsage({
      timezone: 'Asia/Shanghai',
      collectedAt: '2026-04-28T10:00:00.000Z',
      async runner(command, args, options) {
        calls.push({ command, args, options })
        if (args[1] === 'session') {
          return {
            data: [
              {
                sessionId: 's1',
                lastActivity: 'Apr 28, 2026',
                models: {
                  'gpt-5': {
                    inputTokens: 1,
                    outputTokens: 2,
                    cachedInputTokens: 4
                  }
                }
              }
            ]
          }
        }
        return {
          data: [
            {
              date: '2026-04-28',
              models: ['gpt-5'],
              inputTokens: 1,
              outputTokens: 2,
              cacheCreationInputTokens: 3,
              cacheReadInputTokens: 4,
              costUSD: 0.01
            }
          ]
        }
      }
    })

    expect(calls).toEqual([
      {
        command: 'npx',
        args: ['@ccusage/codex@latest', 'daily', '--json'],
        options: expectedCommandOptions(900000)
      },
      {
        command: 'npx',
        args: ['@ccusage/codex@latest', 'session', '--json'],
        options: expectedCommandOptions(900000)
      }
    ])
    expect(snapshots[0]).toMatchObject({
      source: 'codex',
      model: 'gpt-5',
      cacheCreationTokens: 3,
      cacheReadTokens: 4,
      totalTokens: 10,
      sessionCount: 1
    })
  })

  test('uses configured default since window when env is unset', async () => {
    const calls: Array<{ command: string; args: string[]; options?: CommandRunnerOptions }> = []
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')
    vi.stubEnv('TOKENBOARD_SINCE', '')
    vi.stubEnv('TOKENBOARD_DEFAULT_SINCE', '20260501')

    await collectCodexUsage({
      async runner(command, args, options) {
        calls.push({ command, args, options })
        return { data: [] }
      }
    })

    expect(calls).toEqual([
      {
        command: 'npx',
        args: ['@ccusage/codex@latest', 'daily', '--json', '--since', '20260501'],
        options: expectedCommandOptions(900000)
      },
      {
        command: 'npx',
        args: ['@ccusage/codex@latest', 'session', '--json', '--since', '20260501'],
        options: expectedCommandOptions(900000)
      }
    ])
  })

  test('keeps daily codex snapshots when session count collection fails', async () => {
    const errors: string[] = []
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')

    const snapshots = await collectCodexUsage({
      stderr: (line) => errors.push(line),
      async runner(_command, args) {
        if (args[1] === 'session') {
          throw new Error('session timed out')
        }
        return {
          data: [
            {
              date: '2026-05-12',
              model: 'gpt-5',
              inputTokens: 1,
              outputTokens: 2,
              totalTokens: 3
            }
          ]
        }
      }
    })

    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toMatchObject({
      source: 'codex',
      usageDate: '2026-05-12',
      model: 'gpt-5',
      totalTokens: 3,
      sessionCount: 0
    })
    expect(errors).toEqual(['Skipping codex session counts: session timed out'])
  })

  test('allows explicit full codex scan', async () => {
    const calls: Array<{ command: string; args: string[]; options?: CommandRunnerOptions }> = []
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')
    vi.stubEnv('TOKENBOARD_SINCE', 'all')
    vi.stubEnv('TOKENBOARD_DEFAULT_SINCE', '20260501')

    await collectCodexUsage({
      async runner(command, args, options) {
        calls.push({ command, args, options })
        return { data: [] }
      }
    })

    expect(calls).toEqual([
      {
        command: 'npx',
        args: ['@ccusage/codex@latest', 'daily', '--json'],
        options: expectedCommandOptions(900000)
      },
      {
        command: 'npx',
        args: ['@ccusage/codex@latest', 'session', '--json'],
        options: expectedCommandOptions(900000)
      }
    ])
  })

  test('uses since and selected package manager when configured', async () => {
    const calls: Array<{ command: string; args: string[]; options?: CommandRunnerOptions }> = []
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', 'bun')
    vi.stubEnv('TOKENBOARD_BUNX_BIN', '/opt/bin/bunx')
    vi.stubEnv('TOKENBOARD_SINCE', '20260509')

    await collectCodexUsage({
      async runner(command, args, options) {
        calls.push({ command, args, options })
        return { data: [] }
      }
    })

    expect(calls).toEqual([
      {
        command: '/opt/bin/bunx',
        args: ['@ccusage/codex@latest', 'daily', '--json', '--since', '20260509'],
        options: expectedCommandOptions(900000)
      },
      {
        command: '/opt/bin/bunx',
        args: ['@ccusage/codex@latest', 'session', '--json', '--since', '20260509'],
        options: expectedCommandOptions(900000)
      }
    ])
  })

  test('uses configured daily timeout for the required codex total collection', async () => {
    const calls: Array<{ args: string[]; options?: CommandRunnerOptions }> = []
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')
    vi.stubEnv('TOKENBOARD_CODEX_DAILY_TIMEOUT_MS', '300000')

    await collectCodexUsage({
      async runner(_command, args, options) {
        calls.push({ args, options })
        return { data: [] }
      }
    })

    expect(calls[0]).toEqual({
      args: ['@ccusage/codex@latest', 'daily', '--json'],
      options: expectedCommandOptions(300000)
    })
  })
})

function expectedCommandOptions(timeoutMs: number) {
  return {
    timeoutMs,
    retries: 2,
    onRetry: expect.any(Function)
  }
}
