import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import type { UsageSnapshot } from '@tokenboard/usage-core'
import { runCollectorCli } from './cli'
import { cursorFileName } from './providers/session-cursor-store'

const codexSnapshot: UsageSnapshot = {
  source: 'codex',
  usageDate: '2026-05-22',
  timezone: 'Asia/Shanghai',
  model: 'gpt-5',
  inputTokens: 15,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  totalTokens: 15,
  costUsd: 0.01,
  sessionCount: 1,
  collectedAt: '2026-05-22T10:00:00.000Z'
}

describe('Codex profile cursor CLI lifecycle', () => {
  test('acks an existing scoped cursor after the configured profiles shrink to one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cli-codex-profile-'))
    const codexHome = join(root, 'codex')
    const stateDir = join(root, 'state')
    const cursorScope = resolve(codexHome)
    const acknowledgements: string[] = []

    try {
      await writeProfileCursor(stateDir, cursorScope)
      const result = await runCollectorCli(
        ['sync', '--source', 'codex'],
        {
          CODEX_HOME: codexHome,
          TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
          TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
          TOKENBOARD_TIMEZONE: 'Asia/Shanghai',
          TOKENBOARD_HOOK_MODE: '1',
          TOKENBOARD_STATE_DIR: stateDir
        },
        {
          stdout: () => undefined,
          stderr: () => undefined,
          collectClaudeCodeUsage: async () => [],
          collectCodexUsage: async () => [codexSnapshot],
          uploadSnapshots: async () => ({ upserted: 1 }),
          clearPendingUploadCursors: async (input) => {
            acknowledgements.push(input.cursorScope ?? 'legacy')
          }
        }
      )

      expect(result).toBe(0)
      expect(acknowledgements).toEqual(['legacy', cursorScope])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('warms an existing scoped cursor after the configured profiles shrink to one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cli-codex-profile-'))
    const codexHome = join(root, 'codex')
    const stateDir = join(root, 'state')
    const cursorScope = resolve(codexHome)
    const warmed: Array<string | undefined> = []
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(1234).mockReturnValue(9999)

    try {
      await writeProfileCursor(stateDir, cursorScope)
      const result = await runCollectorCli(
        ['warm-hooks', '--source', 'codex'],
        { CODEX_HOME: codexHome, TOKENBOARD_STATE_DIR: stateDir },
        {
          stdout: () => undefined,
          stderr: () => undefined,
          collectClaudeCodeUsage: async () => {
            throw new Error('warm-hooks must not collect Claude Code')
          },
          collectCodexUsage: async () => {
            throw new Error('warm-hooks must not collect Codex')
          },
          uploadSnapshots: async () => {
            throw new Error('warm-hooks must not upload')
          },
          warmHookCursorHighWater: async (input) => {
            warmed.push(input.cursorScope)
          }
        }
      )

      expect(result).toBe(0)
      expect(warmed).toEqual([cursorScope])
    } finally {
      now.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function writeProfileCursor(stateDir: string, cursorScope: string) {
  const cursorPath = join(stateDir, cursorFileName('codex', cursorScope))
  await mkdir(dirname(cursorPath), { recursive: true })
  await writeFile(cursorPath, `${JSON.stringify({ version: 1, source: 'codex', files: {} })}\n`)
}
