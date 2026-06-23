import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { clearPendingUploadCursors } from './session-cursor'
import { collectAntigravityCliUsage } from './antigravity-cli'

const conversationA = 'a'.repeat(64)
const conversationB = 'b'.repeat(64)
const defaultConversationHash = '0'.repeat(64)

describe('collectAntigravityCliUsage', () => {
  test('dedupes repeated statusline events and counts a conversation session once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-'))
    try {
      const eventPath = join(root, 'events.jsonl')
      await writeEvents(eventPath, [
        event({ usage: { inputTokens: 100, outputTokens: 10 } }),
        event({ usage: { inputTokens: 100, outputTokens: 10 } }),
        event({ usage: { inputTokens: 20, outputTokens: 5 } })
      ])

      const snapshots = await collectAntigravityCliUsage({
        stateDir: root,
        eventPath,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-06-23T10:00:00.000Z'
      })

      expect(snapshots).toEqual([
        {
          source: 'antigravity-cli',
          usageDate: '2026-06-23',
          timezone: 'Asia/Shanghai',
          model: 'Gemini 3.5 Flash (Medium)',
          inputTokens: 120,
          outputTokens: 15,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          totalTokens: 135,
          costUsd: 0,
          sessionCount: 1,
          collectedAt: '2026-06-23T10:00:00.000Z'
        }
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('retries pending snapshots until the cursor is acknowledged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-'))
    try {
      const eventPath = join(root, 'events.jsonl')
      await writeEvents(eventPath, [event({ usage: { inputTokens: 10, outputTokens: 2 } })])

      const first = await collectAntigravityCliUsage({ stateDir: root, eventPath, timezone: 'UTC', collectedAt: '2026-06-23T10:00:00.000Z' })
      const second = await collectAntigravityCliUsage({ stateDir: root, eventPath, timezone: 'UTC', collectedAt: '2026-06-23T10:05:00.000Z' })
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity-cli' })
      const third = await collectAntigravityCliUsage({ stateDir: root, eventPath, timezone: 'UTC', collectedAt: '2026-06-23T10:10:00.000Z' })

      expect(first).toHaveLength(1)
      expect(second).toEqual([{ ...first[0], collectedAt: '2026-06-23T10:05:00.000Z' }])
      expect(third).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('uses the configured timezone for usage dates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-'))
    try {
      const eventPath = join(root, 'events.jsonl')
      await writeEvents(eventPath, [event({ capturedAt: '2026-06-23T16:30:00.000Z', usage: { inputTokens: 1, outputTokens: 1 } })])

      const snapshots = await collectAntigravityCliUsage({ stateDir: root, eventPath, timezone: 'Asia/Shanghai' })

      expect(snapshots[0]?.usageDate).toBe('2026-06-24')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('scans only appended statusline events after acknowledged uploads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-'))
    try {
      const eventPath = join(root, 'events.jsonl')
      await writeEvents(eventPath, [event({ conversationHash: conversationA, usage: { inputTokens: 10, outputTokens: 2 } })])

      const first = await collectAntigravityCliUsage({ stateDir: root, eventPath, timezone: 'UTC', collectedAt: '2026-06-23T10:00:00.000Z' })
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity-cli' })
      await appendFile(eventPath, `${JSON.stringify(event({ conversationHash: conversationB, usage: { inputTokens: 20, outputTokens: 4 } }))}\n`)
      const second = await collectAntigravityCliUsage({ stateDir: root, eventPath, timezone: 'UTC', collectedAt: '2026-06-23T10:05:00.000Z' })

      expect(first[0]?.inputTokens).toBe(10)
      expect(second).toEqual([
        {
          source: 'antigravity-cli',
          usageDate: '2026-06-23',
          timezone: 'UTC',
          model: 'Gemini 3.5 Flash (Medium)',
          inputTokens: 20,
          outputTokens: 4,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          totalTokens: 24,
          costUsd: 0,
          sessionCount: 1,
          collectedAt: '2026-06-23T10:05:00.000Z'
        }
      ])
      const cursor = JSON.parse(await readFile(join(root, 'antigravity-cli-cursor.json'), 'utf8'))
      expect(cursor.lastScanOffsetBytes).toBeGreaterThan(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('prunes acknowledged old cursor entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-'))
    try {
      const eventPath = join(root, 'events.jsonl')
      await writeEvents(eventPath, [event({
        capturedAt: '2026-01-01T10:00:00.000Z',
        conversationHash: conversationA,
        usage: { inputTokens: 10, outputTokens: 2 }
      })])

      await collectAntigravityCliUsage({ stateDir: root, eventPath, timezone: 'UTC', collectedAt: '2026-01-01T10:00:00.000Z' })
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity-cli' })
      await appendFile(eventPath, `${JSON.stringify(event({
        capturedAt: '2026-06-23T10:00:00.000Z',
        conversationHash: conversationB,
        usage: { inputTokens: 20, outputTokens: 4 }
      }))}\n`)
      await collectAntigravityCliUsage({ stateDir: root, eventPath, timezone: 'UTC', collectedAt: '2026-06-23T10:05:00.000Z' })

      const cursor = JSON.parse(await readFile(join(root, 'antigravity-cli-cursor.json'), 'utf8'))
      expect(Object.keys(cursor.files).some((key) => key.includes(conversationA))).toBe(false)
      expect(Object.keys(cursor.files).some((key) => key.includes(conversationB))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects malformed and unsanitized statusline events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-'))
    try {
      const malformedPath = join(root, 'malformed.jsonl')
      await mkdir(root, { recursive: true })
      await writeFile(malformedPath, '{bad json}\n')
      await expect(collectAntigravityCliUsage({ stateDir: root, eventPath: malformedPath }))
        .rejects.toThrow('Malformed Antigravity statusline JSON')

      const unsafePath = join(root, 'unsafe.jsonl')
      await writeFile(unsafePath, `${JSON.stringify({ ...event({}), cwd: '/Users/example/project' })}\n`)
      await expect(collectAntigravityCliUsage({ stateDir: root, eventPath: unsafePath }))
        .rejects.toThrow('sensitive field cwd')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects unbounded token values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-'))
    try {
      const eventPath = join(root, 'events.jsonl')
      await writeEvents(eventPath, [event({ usage: { inputTokens: 1_000_000_001 } })])

      await expect(collectAntigravityCliUsage({ stateDir: root, eventPath }))
        .rejects.toThrow('inputTokens must be a bounded nonnegative integer')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function writeEvents(path: string, events: unknown[]) {
  await writeFile(path, `${events.map((item) => JSON.stringify(item)).join('\n')}\n`)
}

function event(overrides: Partial<Omit<ReturnType<typeof baseEvent>, 'usage'>> & { usage?: Partial<ReturnType<typeof baseEvent>['usage']> } = {}) {
  return {
    ...baseEvent(),
    ...overrides,
    usage: {
      ...baseEvent().usage,
      ...(overrides as { usage?: object }).usage
    }
  }
}

function baseEvent() {
  return {
    schemaVersion: 'antigravity-statusline/v1',
    capturedAt: '2026-06-23T10:00:00.000Z',
    conversationHash: defaultConversationHash,
    model: 'Gemini 3.5 Flash (Medium)',
    usage: {
      inputTokens: 10,
      outputTokens: 2,
      cacheCreationTokens: 0,
      cacheReadTokens: 0
    }
  }
}
