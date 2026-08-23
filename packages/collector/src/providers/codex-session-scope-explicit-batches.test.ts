import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { createCodexSessionScopeBatchesForFiles } from './codex-session-scope'

describe('Codex explicit session scope batches', () => {
  test('keeps each multi-profile selected-session group together while enforcing the batch byte limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-explicit-scope-batches-'))
    const firstHome = join(root, 'first')
    const secondHome = join(root, 'second')
    const firstShared = join(firstHome, 'sessions', '2026', '07', 'shared.jsonl')
    const secondShared = join(secondHome, 'sessions', '2026', '07', 'shared.jsonl')
    const later = join(firstHome, 'sessions', '2026', '07', 'later.jsonl')

    try {
      await Promise.all([
        writeSizedFile(firstShared, 130),
        writeSizedFile(secondShared, 130),
        writeSizedFile(later, 130)
      ])

      const batches: Array<{ firstShared: boolean; secondShared: boolean; later: boolean; homeCount: number }> = []
      for await (const scope of createCodexSessionScopeBatchesForFiles({
        codexHomes: [firstHome, secondHome],
        groups: [
          {
            files: [
              { codexHome: firstHome, filePath: firstShared },
              { codexHome: secondHome, filePath: secondShared }
            ]
          },
          { files: [{ codexHome: firstHome, filePath: later }] }
        ],
        maxFileBytes: 256,
        maxBatchBytes: 300,
        batchSize: 2
      })) {
        try {
          const copied = new Set(scope.sourceFiles.values())
          batches.push({
            firstShared: copied.has(firstShared),
            secondShared: copied.has(secondShared),
            later: copied.has(later),
            homeCount: scope.codexHomes.length
          })
        } finally {
          await scope.cleanup()
        }
      }

      expect(batches).toHaveLength(2)
      expect(batches.every((batch) => batch.homeCount === 2)).toBe(true)
      expect(batches).toContainEqual({ firstShared: true, secondShared: true, later: false, homeCount: 2 })
      expect(batches).toContainEqual({ firstShared: false, secondShared: false, later: true, homeCount: 2 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function writeSizedFile(filePath: string, size: number) {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, `${'x'.repeat(size - 1)}\n`)
}
