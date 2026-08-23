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
})

async function collectFiles(root: string) {
  const files: string[] = []
  for await (const file of walkJsonlFiles(root)) {
    files.push(file)
  }
  return files
}
