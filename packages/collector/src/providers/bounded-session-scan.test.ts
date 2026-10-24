import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { maxScanDirectoryEntries, scanSessionFiles } from './bounded-session-scan'

// The scanner reads roots outside TokenBoard's control, so an over-large directory listing must
// be *reported* through `onSkipped` rather than loaded whole — a single abnormal directory must
// not be able to exhaust memory just by existing.
describe('bounded session scan', () => {
  const created: string[] = []

  afterEach(async () => {
    await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function withRoot() {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-scan-'))
    created.push(root)
    return root
  }

  test('reports a directory whose listing exceeds the entry cap instead of loading it whole', async () => {
    const home = await withRoot()
    const overfull = join(home, 'sessions')
    await mkdir(overfull)
    // Create just past the cap: the scan must stop at the boundary rather than read the whole
    // listing into memory before sorting it.
    for (let i = 0; i < maxScanDirectoryEntries + 1; i++) {
      await writeFile(join(overfull, `${String(i).padStart(5, '0')}.jsonl`), '{}\n')
    }

    const files: string[] = []
    const skipReasons: Array<[string, string]> = []
    for await (const file of scanSessionFiles(home, {
      matches: () => true,
      onSkipped: (path, reason) => skipReasons.push([path, reason])
    })) {
      files.push(file.path)
    }

    expect(files).toEqual([])
    expect(skipReasons).toEqual([[overfull, 'max-entries']])
  }, 30_000)
})
