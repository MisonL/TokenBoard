import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'

// The Antigravity sources read whole pages of `hex(data)`, which doubles each blob, so the
// shared 64 MiB reader default would reject pages their own 128 MiB ceiling accepted before
// the read path was unified. `sqlite-reader.test.ts` pins that the constant is larger than
// the default and that the reader honours a raised ceiling; what neither covers is the call
// site — deleting `maxOutputBytes` from `readSqliteOutput` would leave every test green while
// silently halving what this source can read. So capture the options the call site passes.
const { recordedOptions } = vi.hoisted(() => ({ recordedOptions: [] as Array<Record<string, unknown>> }))

vi.mock('./sqlite-reader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sqlite-reader')>()
  return {
    ...actual,
    querySqliteText: vi.fn(async (_dbFile: string, _sql: string, options: Record<string, unknown>) => {
      recordedOptions.push(options)
      // An empty result: no rows means the page loop terminates after this one query.
      return ''
    })
  }
})

import { antigravityMaxSqliteOutputBytes } from './sqlite-reader'
import { readAntigravityDbUsageEvents } from './antigravity-history-db'

describe('Antigravity SQLite read ceiling', () => {
  test('passes the raised ceiling on every query it issues', async () => {
    recordedOptions.length = 0
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-ceiling-'))
    try {
      const dir = join(root, 'conversations')
      await mkdir(dir, { recursive: true })
      // The mocked reader never opens the file; the listing only needs a name matching the
      // cascade-id pattern and a successful stat.
      await writeFile(join(dir, '00000000-0000-0000-0000-000000000009.db'), '')

      await readAntigravityDbUsageEvents({ conversationDir: dir })

      expect(recordedOptions.length).toBeGreaterThan(0)
      for (const options of recordedOptions) {
        expect(options.maxOutputBytes).toBe(antigravityMaxSqliteOutputBytes)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
