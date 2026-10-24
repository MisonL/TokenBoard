import { mkdtemp, readFile, readdir, rm, writeFile as writeRawFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { readCursor, withCursorLock, writeCursor } from './session-cursor-store'

describe('session cursor store concurrency', () => {
  test('waits for an in-flight heartbeat before releasing the cursor lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-heartbeat-release-'))
    const cursorPath = join(root, 'codex-cursor.json')
    const callbackStarted = deferred<void>()
    const heartbeatStarted = deferred<void>()
    const releaseHeartbeat = deferred<void>()
    let refreshCount = 0
    let settled = false
    try {
      const operation = withCursorLock(
        cursorPath,
        async () => {
          callbackStarted.resolve()
          await delay(30)
        },
        {
          heartbeatIntervalMs: 1,
          refreshCursorLock: async () => {
            refreshCount += 1
            heartbeatStarted.resolve()
            await releaseHeartbeat.promise
          }
        }
      ).finally(() => {
        settled = true
      })

      await callbackStarted.promise
      await delay(40)
      try {
        expect(heartbeatStarted.settled()).toBe(true)
        expect(settled).toBe(false)
      } finally {
        releaseHeartbeat.resolve()
        await operation
      }
      expect(refreshCount).toBe(1)
      await expect(readFile(`${cursorPath}.lock`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      releaseHeartbeat.resolve()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('releases the cursor lock when an in-flight heartbeat refresh fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-heartbeat-error-'))
    const cursorPath = join(root, 'codex-cursor.json')
    const heartbeatStarted = deferred<void>()
    const failHeartbeat = deferred<void>()
    const heartbeatError = new Error('heartbeat failed')
    try {
      const operation = withCursorLock(
        cursorPath,
        async () => {
          await heartbeatStarted.promise
        },
        {
          heartbeatIntervalMs: 1,
          refreshCursorLock: async () => {
            heartbeatStarted.resolve()
            await failHeartbeat.promise
            throw heartbeatError
          }
        }
      )

      await heartbeatStarted.promise
      failHeartbeat.resolve()
      await expect(operation).rejects.toBe(heartbeatError)
      await expect(readFile(`${cursorPath}.lock`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      failHeartbeat.resolve()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('preserves the callback error when heartbeat refresh and callback both fail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-callback-heartbeat-error-'))
    const cursorPath = join(root, 'codex-cursor.json')
    const heartbeatStarted = deferred<void>()
    const failHeartbeat = deferred<void>()
    const callbackError = new Error('callback failed')
    try {
      const operation = withCursorLock(
        cursorPath,
        async () => {
          await heartbeatStarted.promise
          throw callbackError
        },
        {
          heartbeatIntervalMs: 1,
          refreshCursorLock: async () => {
            heartbeatStarted.resolve()
            await failHeartbeat.promise
            throw new Error('heartbeat failed')
          }
        }
      )

      await heartbeatStarted.promise
      failHeartbeat.resolve()
      await expect(operation).rejects.toBe(callbackError)
      await expect(readFile(`${cursorPath}.lock`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      failHeartbeat.resolve()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('reports a heartbeat refresh failure that settles before the callback completes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-early-heartbeat-error-'))
    const cursorPath = join(root, 'codex-cursor.json')
    const heartbeatFailed = deferred<void>()
    const finishCallback = deferred<void>()
    const heartbeatError = new Error('heartbeat failed early')
    try {
      const operation = withCursorLock(
        cursorPath,
        async () => {
          await finishCallback.promise
        },
        {
          heartbeatIntervalMs: 1,
          refreshCursorLock: async () => {
            heartbeatFailed.resolve()
            throw heartbeatError
          }
        }
      )

      await heartbeatFailed.promise
      finishCallback.resolve()
      await expect(operation).rejects.toBe(heartbeatError)
      await expect(readFile(`${cursorPath}.lock`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      finishCallback.resolve()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('serializes the complete cursor read-modify-write interval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-lock-'))
    const cursorPath = join(root, 'codex-cursor.json')
    try {
      await Promise.all(
        Array.from({ length: 12 }, async (_, index) => {
          await withCursorLock(cursorPath, async () => {
            const cursor = await readCursor(cursorPath, 'codex')
            await new Promise((resolve) => setTimeout(resolve, 5))
            cursor.files[`session-${index}`] = {
              size: index,
              mtimeMs: index,
              sha256: String(index),
              snapshots: [],
              missingCost: false,
              updatedAt: '2026-07-12T00:00:00.000Z'
            }
            await writeCursor(cursorPath, cursor)
          })
        })
      )

      const cursor = await readCursor(cursorPath, 'codex')
      expect(Object.keys(cursor.files)).toHaveLength(12)
      expect((await readdir(root)).filter((name) => name.includes('.tmp-'))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('preserves callback errors when lock ownership changes during cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-lock-error-'))
    const cursorPath = join(root, 'codex-cursor.json')
    try {
      await expect(
        withCursorLock(cursorPath, async () => {
          await writeCursor(`${cursorPath}.lock`, {
            version: 1,
            source: 'codex',
            files: {}
          })
          throw new Error('callback failed')
        })
      ).rejects.toThrow('callback failed')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects a cursor write after lock ownership is lost', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-lock-fence-'))
    const cursorPath = join(root, 'codex-cursor.json')
    try {
      await expect(
        withCursorLock(cursorPath, async () => {
          await writeRawFile(`${cursorPath}.lock`, JSON.stringify({ pid: process.pid, token: 'replacement' }))
          await writeCursor(cursorPath, { version: 1, source: 'codex', files: {} })
        })
      ).rejects.toThrow('Cursor lock ownership changed before write')
      await expect(readFile(cursorPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('session cursor key validation', () => {
  // The cursor file is plain JSON on disk. Every value is validated on read; keys used to be
  // trusted verbatim, so a corrupted or hand-edited cursor could park a path-like key in
  // state that later scans preserve forever and that is echoed into uploaded reconciliation
  // metadata. A path-keyed source only ever produces keys through the bounded session walk,
  // so an absolute key or a `..` segment cannot have come from the collector; Antigravity
  // sources key entries by synthetic identifiers, which always carry a NUL separator that no
  // filesystem path can contain.
  const snapshot = {
    source: 'codex' as const,
    usageDate: '2026-10-01',
    timezone: 'UTC',
    model: 'gpt-5',
    inputTokens: 1,
    outputTokens: 1,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 2,
    costUsd: 0,
    sessionCount: 1
  }
  const entry = {
    size: 1,
    mtimeMs: 1,
    sha256: 'a'.repeat(64),
    snapshots: [snapshot],
    missingCost: false,
    updatedAt: '2026-10-01T00:00:00.000Z',
    pendingUpload: true
  }

  test.each([['../../etc/passwd'], ['/etc/passwd'], ['sessions/../../etc/passwd'], ['..'], ['']])(
    'rejects the path-escaping codex cursor key %j',
    async (key) => {
      const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-key-'))
      const cursorPath = join(root, 'codex-cursor.json')
      try {
        await writeRawFile(cursorPath, JSON.stringify({ version: 1, source: 'codex', files: { [key]: entry } }))
        await expect(readCursor(cursorPath, 'codex')).rejects.toThrow(/Invalid codex cursor file/)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  test('keeps accepting path keys the session walk can produce', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-key-paths-'))
    const cursorPath = join(root, 'codex-cursor.json')
    // `literal\name.jsonl` is a legal POSIX filename with a literal backslash, and
    // `C:notes.jsonl` a legal POSIX filename with a colon; the walk yields both verbatim,
    // so neither may be rejected as path-like.
    const keys = ['2026/10/01/rollout.jsonl', 'literal\\name.jsonl', 'C:notes.jsonl', '.hidden.jsonl']
    try {
      await writeRawFile(
        cursorPath,
        JSON.stringify({ version: 1, source: 'codex', files: Object.fromEntries(keys.map((key) => [key, entry])) })
      )
      const cursor = await readCursor(cursorPath, 'codex')
      expect(Object.keys(cursor.files).sort()).toEqual([...keys].sort())
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps accepting every Antigravity synthetic key kind', async () => {
    const h = 'b'.repeat(64)
    const cursorKeys: Record<string, string[]> = {
      'antigravity-cli': [
        `history-event\u0000${h}\u0000${h}`,
        `session\u0000antigravity-cli\u00002026-10-01\u0000gemini-3-pro\u0000${h}`,
        `aggregate\u0000${h}`,
        `db-row\u0000antigravity-cli\u0000${h}`,
        `db-row\u0000antigravity-cli\0since:2026-10-01\u0000${h}`,
        `history-authority-correction\u0000${h}`,
        // A model name is free-form local data and may carry a slash (`org/model`); it is not
        // a path marker, so the tightened part check must keep accepting it.
        `session\u0000antigravity-cli\u00002026-10-01\u0000acme/gemini-3-pro\u0000${h}`
      ],
      antigravity: [
        `event\u0000${h}\u0000${h}`,
        `session\u0000antigravity\u00002026-10-01\u0000gemini-3-pro\u0000${h}`,
        `aggregate\u0000${h}`,
        `cascade\u0000antigravity\u0000${h}`,
        `cascade\u0000antigravity\0since:2026-10-01\u0000${h}`,
        'cascade-empty-frontier\u0000antigravity',
        `db\u0000antigravity\u0000${h}`,
        `db-covered\u0000antigravity\0since:2026-10-01\u0000${h}`,
        `gui-db-reset-correction\u0000${h}`
      ]
    }
    for (const [source, keys] of Object.entries(cursorKeys)) {
      const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-key-antigravity-'))
      const cursorPath = join(root, `${source}-cursor.json`)
      try {
        await writeRawFile(
          cursorPath,
          JSON.stringify({
            version: 1,
            source,
            files: Object.fromEntries(keys.map((key) => [key, entry]))
          })
        )
        const cursor = await readCursor(cursorPath, source as 'antigravity-cli' | 'antigravity')
        expect(Object.keys(cursor.files).sort()).toEqual([...keys].sort())
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  })

  test.each([
    ['../../etc/passwd'],
    ['/etc/passwd\0db-row'],
    ['..\0x'],
    ['c:\\x\0y'],
    ['\0leading'],
    // A valid kebab-case kind must not smuggle path markers in the trailing parts: only the
    // kind is shape-checked today, so `db-row\0..` would otherwise pass as a synthetic key.
    ['db-row\0..'],
    ['db-row\0x\0.'],
    // The same escape nested inside a part: the whole-part check alone used to let an
    // absolute or escaping path through as long as the whole part was not exactly `.`/`..`.
    // Splitting stays on `/` only — a literal backslash is a legal POSIX filename character,
    // so `..\..\etc\passwd` remains a (weird) legal model name rather than an escape.
    ['db-row\0/etc/passwd'],
    ['db-row\0x/../etc'],
    ['db-row\0../etc/passwd']
  ])('rejects the path-like Antigravity cursor key %j', async (key) => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-key-antigravity-bad-'))
    const cursorPath = join(root, 'antigravity-cli-cursor.json')
    try {
      await writeRawFile(cursorPath, JSON.stringify({ version: 1, source: 'antigravity-cli', files: { [key]: entry } }))
      await expect(readCursor(cursorPath, 'antigravity-cli')).rejects.toThrow(/Invalid antigravity-cli cursor file/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function deferred<T>() {
  let isSettled = false
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = (value) => {
      isSettled = true
      resolvePromise(value)
    }
  })
  return { promise, resolve, settled: () => isSettled }
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
