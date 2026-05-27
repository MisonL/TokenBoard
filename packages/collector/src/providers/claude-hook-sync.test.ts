import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { collectClaudeCodeUsage } from './claude-code'
import { clearPendingUploadCursors } from './session-cursor'

describe('Claude hook sync collection', () => {
  test('uses changed Claude project files to run narrow ccusage reconciliation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-claude-hook-'))
    const claudeHome = join(root, 'claude')
    const stateDir = join(root, 'state')
    const sessionFile = join(claudeHome, 'projects', 'project-a', 'session.jsonl')
    const calls: string[][] = []

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('CLAUDE_CONFIG_DIR', claudeHome)
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(sessionFile, [
        {
          type: 'assistant',
          timestamp: '2026-05-22T02:00:00.000Z',
          message: {
            model: 'claude-sonnet-4-5',
            usage: {
              input_tokens: 8,
              output_tokens: 13
            }
          },
          costUSD: 0.12
        }
      ])

      const snapshots = await collectClaudeCodeUsage({
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:00:00.000Z',
        async runner(_command, args) {
          calls.push(args)
          if (args.includes('session')) {
            return {
              data: [
                {
                  sessionId: 's1',
                  lastActivity: '2026-05-22T02:00:00.000Z',
                  modelBreakdowns: {
                    'claude-sonnet-4-5': {
                      inputTokens: 16,
                      outputTokens: 26
                    }
                  }
                }
              ]
            }
          }
          return {
            data: [
              {
                date: '2026-05-22',
                breakdown: {
                  'claude-sonnet-4-5': {
                    inputTokens: 16,
                    outputTokens: 26,
                    totalTokens: 42,
                    costUSD: 0.24
                  }
                }
              }
            ]
          }
        }
      })

      expect(calls).toEqual([
        ['ccusage@latest', 'claude', 'daily', '--json', '--breakdown', '--since', '20260522', '--until', '20260522', '--timezone', 'Asia/Shanghai'],
        ['ccusage@latest', 'claude', 'session', '--json', '--since', '20260522', '--until', '20260522', '--timezone', 'Asia/Shanghai']
      ])
      expect(snapshots).toEqual([
        expect.objectContaining({
          source: 'claude-code',
          usageDate: '2026-05-22',
          model: 'claude-sonnet-4-5',
          inputTokens: 16,
          outputTokens: 26,
          totalTokens: 42,
          costUsd: 0.24,
          sessionCount: 1
        })
      ])
      await clearPendingUploadCursors({ stateDir, source: 'claude-code' })
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('uses CLAUDE_HOME for hook sync when CLAUDE_CONFIG_DIR is unset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-claude-hook-'))
    const claudeHome = join(root, 'claude-home')
    const defaultHome = join(root, 'home')
    const stateDir = join(root, 'state')
    const sessionFile = join(claudeHome, 'projects', 'project-a', 'session.jsonl')
    const calls: string[][] = []

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('CLAUDE_HOME', claudeHome)
    vi.stubEnv('CLAUDE_CONFIG_DIR', '')
    vi.stubEnv('HOME', defaultHome)
    vi.stubEnv('USERPROFILE', defaultHome)
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(sessionFile, [
        {
          type: 'assistant',
          timestamp: '2026-05-22T02:00:00.000Z',
          message: {
            model: 'claude-sonnet-4-5',
            usage: {
              input_tokens: 8,
              output_tokens: 13
            }
          },
          costUSD: 0.12
        }
      ])

      const snapshots = await collectClaudeCodeUsage({
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:00:00.000Z',
        async runner(_command, args) {
          calls.push(args)
          if (args.includes('session')) {
            return {
              data: [
                {
                  sessionId: 's1',
                  lastActivity: '2026-05-22T02:00:00.000Z',
                  modelBreakdowns: {
                    'claude-sonnet-4-5': {
                      inputTokens: 8,
                      outputTokens: 13
                    }
                  }
                }
              ]
            }
          }
          return {
            data: [
              {
                date: '2026-05-22',
                breakdown: {
                  'claude-sonnet-4-5': {
                    inputTokens: 8,
                    outputTokens: 13,
                    totalTokens: 21,
                    costUSD: 0.12
                  }
                }
              }
            ]
          }
        }
      })

      expect(calls).toEqual([
        ['ccusage@latest', 'claude', 'daily', '--json', '--breakdown', '--since', '20260522', '--until', '20260522', '--timezone', 'Asia/Shanghai'],
        ['ccusage@latest', 'claude', 'session', '--json', '--since', '20260522', '--until', '20260522', '--timezone', 'Asia/Shanghai']
      ])
      expect(snapshots).toEqual([
        expect.objectContaining({
          source: 'claude-code',
          usageDate: '2026-05-22',
          model: 'claude-sonnet-4-5',
          totalTokens: 21,
          costUsd: 0.12,
          sessionCount: 1
        })
      ])
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('runs narrow ccusage reconciliation when Claude parsed cost is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-claude-hook-'))
    const claudeHome = join(root, 'claude')
    const stateDir = join(root, 'state')
    const sessionFile = join(claudeHome, 'projects', 'project-a', 'session.jsonl')
    const calls: string[][] = []

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('CLAUDE_CONFIG_DIR', claudeHome)
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(sessionFile, [
        {
          type: 'assistant',
          timestamp: '2026-05-22T02:00:00.000Z',
          message: {
            model: 'claude-sonnet-4-5',
            usage: {
              input_tokens: 8,
              output_tokens: 13
            }
          }
        }
      ])

      const snapshots = await collectClaudeCodeUsage({
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:00:00.000Z',
        async runner(_command, args) {
          calls.push(args)
          if (args.includes('session')) {
            return {
              data: [
                {
                  sessionId: 's1',
                  lastActivity: '2026-05-22T02:00:00.000Z',
                  modelBreakdowns: {
                    'claude-sonnet-4-5': {
                      inputTokens: 8,
                      outputTokens: 13
                    }
                  }
                }
              ]
            }
          }
          return {
            data: [
              {
                date: '2026-05-22',
                breakdown: {
                  'claude-sonnet-4-5': {
                    inputTokens: 8,
                    outputTokens: 13,
                    totalTokens: 21,
                    costUSD: 0.12
                  }
                }
              }
            ]
          }
        }
      })

      expect(calls).toEqual([
        ['ccusage@latest', 'claude', 'daily', '--json', '--breakdown', '--since', '20260522', '--until', '20260522', '--timezone', 'Asia/Shanghai'],
        ['ccusage@latest', 'claude', 'session', '--json', '--since', '20260522', '--until', '20260522', '--timezone', 'Asia/Shanghai']
      ])
      expect(snapshots).toEqual([
        expect.objectContaining({
          source: 'claude-code',
          usageDate: '2026-05-22',
          model: 'claude-sonnet-4-5',
          totalTokens: 21,
          costUsd: 0.12,
          sessionCount: 1
        })
      ])
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails Claude hook reconciliation when ccusage returns no snapshots for parsed usage dates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-claude-hook-'))
    const claudeHome = join(root, 'claude')
    const stateDir = join(root, 'state')
    const sessionFile = join(claudeHome, 'projects', 'project-a', 'session.jsonl')

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('CLAUDE_CONFIG_DIR', claudeHome)
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')

    try {
      await writeJsonl(sessionFile, [
        {
          type: 'assistant',
          timestamp: '2026-05-22T02:00:00.000Z',
          message: {
            model: 'claude-sonnet-4-5',
            usage: {
              input_tokens: 8,
              output_tokens: 13
            }
          },
          costUSD: 0.12
        }
      ])

      await expect(collectClaudeCodeUsage({
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:00:00.000Z',
        async runner() {
          return { data: [] }
        }
      })).rejects.toThrow(/Claude hook reconciliation returned no snapshots/)

      const cursor = JSON.parse(await readFile(join(stateDir, 'claude-code-cursor.json'), 'utf8'))
      expect(cursor.files['project-a/session.jsonl'].pendingUpload).toBe(true)
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function writeJsonl(file: string, rows: unknown[]) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
}
