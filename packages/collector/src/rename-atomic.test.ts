import { mkdtemp, readFile, rename as renameReal, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { renameAtomic } from './rename-atomic'

const eperm = () => Object.assign(new Error('EPERM'), { code: 'EPERM' })

describe('renameAtomic', () => {
  test('renames when the destination is free', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-rename-'))
    try {
      const tempPath = join(root, 'state.json.tmp')
      const destinationPath = join(root, 'state.json')
      await writeFile(tempPath, 'payload')

      await renameAtomic(tempPath, destinationPath)

      expect(await readFile(destinationPath, 'utf8')).toBe('payload')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('retries an EPERM collision and succeeds once the destination frees up', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-rename-'))
    try {
      const tempPath = join(root, 'state.json.tmp')
      const destinationPath = join(root, 'state.json')
      await writeFile(tempPath, 'payload')
      let collisions = 0
      const renameFn = async (from: unknown, to: unknown) => {
        if (collisions < 2) {
          collisions += 1
          throw eperm()
        }
        return renameReal(from as string, to as string)
      }

      await renameAtomic(tempPath, destinationPath, renameFn)

      expect(collisions).toBe(2)
      expect(await readFile(destinationPath, 'utf8')).toBe('payload')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rethrows non-busy errors immediately without retrying', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-rename-'))
    try {
      const tempPath = join(root, 'missing.tmp')
      const destinationPath = join(root, 'state.json')
      const startedAt = Date.now()

      await expect(
        renameAtomic(tempPath, destinationPath, async () => {
          throw Object.assign(new Error('gone'), { code: 'ENOENT' })
        })
      ).rejects.toMatchObject({ code: 'ENOENT' })
      expect(Date.now() - startedAt).toBeLessThan(50)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('gives up after the retry budget with the last busy error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-rename-'))
    try {
      let attempts = 0
      const startedAt = Date.now()

      await expect(
        renameAtomic('t', 'd', async () => {
          attempts += 1
          throw eperm()
        })
      ).rejects.toMatchObject({ code: 'EPERM' })

      expect(attempts).toBe(4) // initial try + 3 retries
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(550)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
