import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { collectAntigravityCliUsage } from './antigravity-cli'
import { cursorFileName } from './session-cursor-store'

describe('Antigravity CLI database cursor lifecycle', () => {
  test('removes deleted cascades from every history scope after a complete directory enumeration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-db-cursor-lifecycle-'))
    try {
      await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: 'all',
        readDbUsageEvents: async () => emptyDbUsage(['cascade-a', 'cascade-b'])
      })
      await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: '20260701',
        readDbUsageEvents: async () => emptyDbUsage(['cascade-a', 'cascade-b'])
      })
      await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: '20260701',
        readDbUsageEvents: async () => emptyDbUsage(['cascade-a'])
      })

      const cursor = await readFile(join(root, cursorFileName('antigravity-cli')), 'utf8')

      expect(cursor).toContain(hash('cascade-a'))
      expect(cursor).not.toContain(hash('cascade-b'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function emptyDbUsage(cascadeIds: string[]) {
  return {
    cascadeIds: new Set<string>(),
    events: [],
    knownCascadeIds: new Set(cascadeIds),
    lastReadRowIndexByCascade: new Map(cascadeIds.map((cascadeId) => [cascadeId, -1]))
  }
}

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex')
}
