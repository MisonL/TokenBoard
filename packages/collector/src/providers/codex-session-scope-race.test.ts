import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'

describe('createCodexSessionScope copy races', () => {
  test('skips a session file that disappears before copy', async () => {
    vi.resetModules()
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.doMock('node:fs/promises', () => ({
      ...fs,
      cp: async (
        source: Parameters<typeof fs.cp>[0],
        destination: Parameters<typeof fs.cp>[1],
        options?: Parameters<typeof fs.cp>[2]
      ) => {
        if (String(source).endsWith('disappearing.jsonl')) {
          const error = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException
          error.code = 'ENOENT'
          throw error
        }
        return fs.cp(source, destination, options)
      }
    }))
    const { createCodexSessionScope } = await import('./codex-session-scope')
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-test-'))
    const activeFile = join(codexHome, 'sessions', '2026', '05', 'active.jsonl')
    const disappearingFile = join(codexHome, 'sessions', '2026', '05', 'disappearing.jsonl')
    const skippedFiles: string[] = []

    try {
      await writeJsonl(activeFile, [tokenCountEvent('2026-05-09T04:24:07.234Z')])
      await writeJsonl(disappearingFile, [tokenCountEvent('2026-05-09T04:25:07.234Z')])

      const scope = await createCodexSessionScope({
        codexHome,
        since: 'all',
        onMissingSessionFile: (file) => skippedFiles.push(file)
      })
      expect(scope).not.toBeNull()
      expect(skippedFiles).toEqual([join('2026', '05', 'disappearing.jsonl')])
      try {
        await expect(
          readFile(join(scope!.codexHome, 'sessions', '2026', '05', 'active.jsonl'), 'utf8')
        ).resolves.toContain('token_count')
        await expect(
          stat(join(scope!.codexHome, 'sessions', '2026', '05', 'disappearing.jsonl'))
        ).rejects.toThrow()
      } finally {
        await scope?.cleanup()
      }
    } finally {
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
      await rm(codexHome, { recursive: true, force: true })
    }
  })
})

async function writeJsonl(file: string, rows: unknown[]) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
}

function tokenCountEvent(timestamp: string) {
  return {
    type: 'event_msg',
    timestamp,
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: 10,
          output_tokens: 0,
          total_tokens: 10
        }
      }
    }
  }
}
