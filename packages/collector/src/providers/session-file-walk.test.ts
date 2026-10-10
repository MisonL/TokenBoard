import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { walkJsonlFiles } from './session-file-walk'

describe('walkJsonlFiles', () => {
  test('returns no files when the root directory disappears', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-walk-'))
    await rm(root, { recursive: true, force: true })

    const files = []
    for await (const file of walkJsonlFiles(root)) {
      files.push(file)
    }

    expect(files).toEqual([])
  })

  test('walks nested JSONL paths in stable relative order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-walk-'))
    try {
      await writeFile(join(root, 'b.jsonl'), '')
      await writeFile(join(root, 'a.jsonl'), '')

      const files = []
      for await (const file of walkJsonlFiles(root)) {
        files.push(file)
      }

      expect(files).toEqual(['a.jsonl', 'b.jsonl'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === 'win32')('preserves literal backslashes in POSIX session file names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-walk-'))
    try {
      await writeFile(join(root, 'literal\\name.jsonl'), '')

      await expect(collectFiles(root)).resolves.toEqual(['literal\\name.jsonl'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('orders nested and sibling JSONL paths by their complete relative paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-walk-'))
    try {
      await mkdir(join(root, 'a'))
      await writeFile(join(root, 'a', 'nested.jsonl'), '')
      await writeFile(join(root, 'a.jsonl'), '')

      await expect(collectFiles(root)).resolves.toEqual(['a.jsonl', 'a/nested.jsonl'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('recurses into directories whose names end with jsonl', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-walk-'))
    try {
      await mkdir(join(root, 'sessions.jsonl'))
      await writeFile(join(root, 'sessions.jsonl', 'nested.jsonl'), '')

      const files = []
      for await (const file of walkJsonlFiles(root)) {
        files.push(file)
      }

      expect(files).toEqual(['sessions.jsonl/nested.jsonl'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === 'win32')('allows a caller-supplied symbolic link session root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-walk-'))
    const outside = join(root, 'outside')
    const linkedRoot = join(root, 'linked-root')
    try {
      await mkdir(outside)
      await writeFile(join(outside, 'outside.jsonl'), '')
      await symlink(outside, linkedRoot)

      await expect(collectFiles(linkedRoot)).resolves.toEqual(['outside.jsonl'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === 'win32')('rejects symbolic link entries below a session root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-walk-'))
    const outside = join(root, 'outside')
    const linkedFile = join(root, 'linked.jsonl')
    try {
      await mkdir(outside)
      await writeFile(join(outside, 'outside.jsonl'), '')

      await symlink(join(outside, 'outside.jsonl'), linkedFile)
      await expect(collectFiles(root)).rejects.toThrow(/session entry.*symbolic links/i)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // The codex/claude session tree lives outside TokenBoard's control, and every sibling
  // scanner caps what it will walk (bounded-session-scan: depth 8; antigravity: 10k
  // entries). This walker had neither — a symlink cycle it already rejects, but a
  // deliberately deep tree or an unbounded directory listing had no ceiling at all.
  test('stops descending past the depth cap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-walk-'))
    try {
      // Depth 9: the cap is 8 levels below the root, so the ninth directory must throw
      // rather than keep recursing.
      let current = root
      for (let level = 1; level <= 9; level += 1) {
        current = join(current, `d${level}`)
        await mkdir(current)
      }
      await writeFile(join(current, 'deep.jsonl'), '')

      await expect(collectFiles(root, { maxDepth: 8 })).rejects.toThrow(/depth/i)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('yields files exactly at the depth cap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-walk-'))
    try {
      let current = root
      for (let level = 1; level <= 8; level += 1) {
        current = join(current, `d${level}`)
        await mkdir(current)
      }
      await writeFile(join(current, 'at-cap.jsonl'), '')

      await expect(collectFiles(root, { maxDepth: 8 })).resolves.toEqual(['d1/d2/d3/d4/d5/d6/d7/d8/at-cap.jsonl'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('stops listing once a single directory exceeds the entry cap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-walk-'))
    try {
      await writeFile(join(root, 'a.jsonl'), '')
      await writeFile(join(root, 'b.jsonl'), '')
      await writeFile(join(root, 'c.jsonl'), '')
      await mkdir(join(root, 'extra'))
      await writeFile(join(root, 'extra', 'd.jsonl'), '')

      // The root listing holds four entries; a cap of three must fail the walk rather than
      // silently truncate its result. The cap is per directory, so a cap of four admits
      // both the root listing and the smaller nested one.
      await expect(collectFiles(root, { maxEntries: 3 })).rejects.toThrow(/entr/i)

      await expect(collectFiles(root, { maxEntries: 4 })).resolves.toEqual([
        'a.jsonl',
        'b.jsonl',
        'c.jsonl',
        'extra/d.jsonl'
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function collectFiles(root: string, options?: { maxDepth?: number; maxEntries?: number }) {
  const files: string[] = []
  for await (const file of walkJsonlFiles(root, options)) {
    files.push(file)
  }
  return files
}
