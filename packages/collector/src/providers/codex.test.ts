import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { collectCodexUsage } from './codex'

describe('collectCodexUsage', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('runs codex ccusage daily json and normalizes cache input aliases', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const snapshots = await collectCodexUsage({
      timezone: 'Asia/Shanghai',
      collectedAt: '2026-04-28T10:00:00.000Z',
      async runner(command, args) {
        calls.push({ command, args })
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
        args: ['@ccusage/codex@latest', 'daily', '--json']
      },
      {
        command: 'npx',
        args: ['@ccusage/codex@latest', 'session', '--json']
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

  test('scopes since scans by active Codex session files instead of session directory dates', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-codex-home-'))
    const activeOldSession = join(
      codexHome,
      'sessions',
      '2026',
      '03',
      '25',
      'active-old-session.jsonl'
    )
    const inactiveOldSession = join(
      codexHome,
      'sessions',
      '2026',
      '03',
      '20',
      'inactive-old-session.jsonl'
    )
    const activeCurrentSession = join(
      codexHome,
      'sessions',
      '2026',
      '05',
      '09',
      'active-current-session.jsonl'
    )

    try {
      await writeJsonl(activeOldSession, [
        tokenCountEvent('2026-05-09T04:24:07.234Z', 10)
      ])
      await writeJsonl(inactiveOldSession, [
        tokenCountEvent('2026-03-20T04:24:07.234Z', 10)
      ])
      await utimes(inactiveOldSession, new Date('2026-03-20T04:24:07.234Z'), new Date('2026-03-20T04:24:07.234Z'))
      await writeJsonl(activeCurrentSession, [
        tokenCountEvent('2026-05-09T04:25:07.234Z', 10)
      ])

      const scopedHomes: string[] = []
      const scopedFiles = {
        activeOld: false,
        activeCurrent: false,
        inactiveOld: false
      }
      vi.stubEnv('TOKENBOARD_SINCE', '20260508')

      await collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        async runner(_command, args, options) {
          if (args[1] === 'daily') {
            const scopedHome = String(options?.env?.CODEX_HOME)
            scopedHomes.push(scopedHome)
            scopedFiles.activeOld = await fileContainsTokenCount(
              join(scopedHome, 'sessions', '2026', '03', '25', 'active-old-session.jsonl')
            )
            scopedFiles.activeCurrent = await fileContainsTokenCount(
              join(scopedHome, 'sessions', '2026', '05', '09', 'active-current-session.jsonl')
            )
            scopedFiles.inactiveOld = await fileExists(
              join(scopedHome, 'sessions', '2026', '03', '20', 'inactive-old-session.jsonl')
            )
          }
          return { data: [] }
        }
      })

      expect(scopedHomes).toHaveLength(1)
      expect(scopedFiles).toEqual({
        activeOld: true,
        activeCurrent: true,
        inactiveOld: false
      })
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })
})

async function writeJsonl(file: string, rows: unknown[]) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, {
    flag: 'w'
  })
}

async function fileContainsTokenCount(file: string) {
  return readFile(file, 'utf8')
    .then((content) => content.includes('token_count'))
    .catch(() => false)
}

async function fileExists(file: string) {
  return stat(file)
    .then(() => true)
    .catch(() => false)
}

function tokenCountEvent(timestamp: string, totalTokens: number) {
  return {
    type: 'event_msg',
    timestamp,
    payload: {
      type: 'token_count',
      info: {
        model: 'gpt-5',
        last_token_usage: {
          input_tokens: totalTokens,
          output_tokens: 0,
          total_tokens: totalTokens
        }
      }
    }
  }
}
