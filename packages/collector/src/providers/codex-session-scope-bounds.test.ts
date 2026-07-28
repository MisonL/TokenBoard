import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { createCodexSessionScope, createCodexSessionScopeBatches } from './codex-session-scope'

describe('Codex session scope bounds', () => {
  test('allows a session file exactly at the configured scope limit', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-bounds-'))
    try {
      await writeSizedFile(join(codexHome, 'sessions', '2026', '07', 'limit.jsonl'), 128)

      const scope = await createCodexSessionScope({
        codexHome,
        since: 'all',
        maxFileBytes: 128,
        maxBatchBytes: 128,
        maxGroupBytes: 128
      })
      expect(scope).not.toBeNull()
      await scope?.cleanup()
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === 'win32')('rejects symbolic link session files before creating a scoped home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-scope-bounds-'))
    const codexHome = join(root, 'codex')
    const outside = join(root, 'outside.jsonl')
    const linkedSession = join(codexHome, 'archived_sessions', '2026', '07', 'linked.jsonl')
    try {
      await writeSizedFile(outside, 128)
      await mkdir(dirname(linkedSession), { recursive: true })
      await symlink(outside, linkedSession)

      await expect(createCodexSessionScope({ codexHome, since: 'all' }))
        .rejects.toThrow(/symbolic link/i)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === 'win32')('rejects symbolic link session roots before scanning them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-scope-bounds-'))
    const codexHome = join(root, 'codex')
    const linkedRoot = join(codexHome, 'sessions')
    const outsideRoot = join(root, 'outside-sessions')
    try {
      await writeSizedFile(join(outsideRoot, '2026', '07', 'outside.jsonl'), 128)
      await mkdir(codexHome, { recursive: true })
      await symlink(outsideRoot, linkedRoot)

      await expect(createCodexSessionScope({ codexHome, since: 'all' }))
        .rejects.toThrow(/session directory.*symbolic link/i)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('splits full-history scope batches before their copied bytes exceed the configured limit', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-bounds-'))
    try {
      for (const name of ['first', 'second', 'third']) {
        await writeSizedFile(join(codexHome, 'sessions', '2026', '07', `${name}.jsonl`), 180)
      }

      const copiedFileCounts: number[] = []
      for await (const scope of createCodexSessionScopeBatches({
        codexHome,
        since: 'all',
        batchSize: 3,
        maxBatchBytes: 300,
        maxFileBytes: 256
      })) {
        try {
          copiedFileCounts.push(scope.sourceFiles.size)
        } finally {
          await scope.cleanup()
        }
      }

      expect(copiedFileCounts).toEqual([1, 1, 1])
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('fails explicitly when one scoped session file exceeds the configured byte limit', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-bounds-'))
    try {
      await writeSizedFile(join(codexHome, 'sessions', '2026', '07', 'oversized.jsonl'), 256)

      await expect(createCodexSessionScope({
        codexHome,
        since: 'all',
        maxFileBytes: 128
      })).rejects.toThrow(/exceeds.*byte limit/i)
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('keeps a multi-profile group together when it exceeds the normal batch byte limit', async () => {
    const firstHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-bounds-'))
    const secondHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-bounds-'))
    try {
      await Promise.all([
        writeSizedFile(join(firstHome, 'sessions', '2026', '07', 'shared.jsonl'), 180),
        writeSizedFile(join(secondHome, 'sessions', '2026', '07', 'shared.jsonl'), 180)
      ])

      const batches = createCodexSessionScopeBatches({
        codexHomes: [firstHome, secondHome],
        since: 'all',
        maxFileBytes: 256,
        maxBatchBytes: 300,
        maxGroupBytes: 400
      })
      const batch = await batches.next()
      expect(batch.done).toBe(false)
      if (!batch.done) {
        try {
          expect(new Set(batch.value.sourceFiles.values())).toEqual(new Set([
            join(firstHome, 'sessions', '2026', '07', 'shared.jsonl'),
            join(secondHome, 'sessions', '2026', '07', 'shared.jsonl')
          ]))
        } finally {
          await batch.value.cleanup()
        }
      }
      expect((await batches.next()).done).toBe(true)
    } finally {
      await Promise.all([
        rm(firstHome, { recursive: true, force: true }),
        rm(secondHome, { recursive: true, force: true })
      ])
    }
  })

  test('fails explicitly when a multi-profile group exceeds the configured group byte limit', async () => {
    const firstHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-bounds-'))
    const secondHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-bounds-'))
    try {
      await Promise.all([
        writeSizedFile(join(firstHome, 'sessions', '2026', '07', 'shared.jsonl'), 180),
        writeSizedFile(join(secondHome, 'sessions', '2026', '07', 'shared.jsonl'), 180)
      ])

      const batches = createCodexSessionScopeBatches({
        codexHomes: [firstHome, secondHome],
        since: 'all',
        maxFileBytes: 256,
        maxBatchBytes: 300,
        maxGroupBytes: 300
      })
      await expect(batches.next()).rejects.toThrow(/group exceeds.*group byte limit/i)
    } finally {
      await Promise.all([
        rm(firstHome, { recursive: true, force: true }),
        rm(secondHome, { recursive: true, force: true })
      ])
    }
  })

  test('skips a dated session whose path and mtime are both outside the bounded window', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-bounds-'))
    const session = join(codexHome, 'sessions', '2026', '01', '01', 'large.jsonl')
    try {
      await writeSizedFile(session, 256)
      await utimes(session, new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-01T00:00:00.000Z'))

      await expect(createCodexSessionScope({
        codexHome,
        since: '20260701',
        maxPrefilterBytes: 128
      })).resolves.toBeNull()
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('skips an archived rollout filename whose start date and mtime are outside the bounded window', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-bounds-'))
    const session = join(codexHome, 'archived_sessions', 'rollout-2026-01-01T00-00-00-session.jsonl')
    try {
      await writeSizedFile(session, 256)
      await utimes(session, new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-01T00:00:00.000Z'))

      await expect(createCodexSessionScope({
        codexHome,
        since: '20260701',
        maxPrefilterBytes: 128
      })).resolves.toBeNull()
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('keeps a dated long-running session whose activity interval overlaps the bounded window', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-bounds-'))
    const session = join(codexHome, 'sessions', '2026', '01', '01', 'long-running.jsonl')
    try {
      await writeSizedFile(session, 256)
      await utimes(session, new Date('2026-08-03T00:00:00.000Z'), new Date('2026-08-03T00:00:00.000Z'))

      const scope = await createCodexSessionScope({
        codexHome,
        since: '20260701',
        until: '20260731',
        maxPrefilterBytes: 128
      })
      expect(scope).not.toBeNull()
      await scope?.cleanup()
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('fails explicitly when an undated bounded prefilter exceeds its read limit', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-bounds-'))
    const session = join(codexHome, 'sessions', 'large.jsonl')
    try {
      await writeSizedFile(session, 256)
      await utimes(session, new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-01T00:00:00.000Z'))

      await expect(createCodexSessionScope({
        codexHome,
        since: '20260701',
        maxPrefilterBytes: 128
      })).rejects.toThrow(/prefilter.*read limit/i)
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('accepts an in-range token count before the bounded date prefilter read limit', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-bounds-'))
    const session = join(codexHome, 'sessions', 'early-token.jsonl')
    const tokenCount = JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-07-01T00:00:00.000Z',
      payload: { type: 'token_count' }
    })
    try {
      await mkdir(dirname(session), { recursive: true })
      await writeFile(session, `${tokenCount}\n${'x'.repeat(512)}`)
      await utimes(session, new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-01T00:00:00.000Z'))

      const scope = await createCodexSessionScope({
        codexHome,
        since: '20260701',
        maxPrefilterBytes: Buffer.byteLength(`${tokenCount}\n`)
      })
      expect(scope).not.toBeNull()
      await scope?.cleanup()
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('fails explicitly when a bounded date prefilter encounters an oversized JSONL line', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-bounds-'))
    const session = join(codexHome, 'sessions', 'long-line.jsonl')
    try {
      await writeSizedFile(session, 256)
      await utimes(session, new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-01T00:00:00.000Z'))

      await expect(createCodexSessionScope({
        codexHome,
        since: '20260701',
        maxPrefilterBytes: 512,
        maxPrefilterLineBytes: 64
      })).rejects.toThrow(/prefilter.*line limit/i)
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })
})

async function writeSizedFile(file: string, size: number) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${'x'.repeat(size - 1)}\n`)
}
