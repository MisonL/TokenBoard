import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { collectCodexUsage } from './codex'
import { clearPendingUploadCursors } from './session-cursor'
import { cursorFileName } from './session-cursor-store'

describe('Codex multi-profile hook collection', () => {
  test('reconciles a comma-containing Codex home through a frozen scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-comma-hook-'))
    const codexHome = join(root, 'profile,primary')
    const stateDir = join(root, 'state')
    const sessionFile = join(codexHome, 'sessions', '2026', '05', '22', 'session.jsonl')
    const homes: string[] = []

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(sessionFile, [tokenCountEvent('2026-05-22T01:00:00.000Z', 15)])

      const snapshots = await collectCodexUsage({
        codexHomes: [codexHome],
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:00:00.000Z',
        async runner(_command, args, options) {
          homes.push(String(options?.env?.CODEX_HOME))
          return args.includes('session') ? sessionResult(15) : dailyResult(15)
        }
      })

      expect(homes).toHaveLength(3)
      expect(new Set(homes).size).toBe(1)
      expect(homes[0]).not.toContain('profile,primary')
      expect(snapshots).toEqual([expect.objectContaining({ totalTokens: 15, sessionCount: 1 })])
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('reconciles a changed session from a later CODEX_HOME profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-multi-hook-'))
    const firstHome = join(root, 'first')
    const secondHome = join(root, 'second')
    const stateDir = join(root, 'state')
    const sessionFile = join(secondHome, 'sessions', '2026', '05', '22', 'session.jsonl')
    const homes: string[] = []

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(sessionFile, [tokenCountEvent('2026-05-22T01:00:00.000Z', 15)])

      const snapshots = await collectCodexUsage({
        codexHome: `${firstHome},${secondHome}`,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:00:00.000Z',
        async runner(_command, args, options) {
          homes.push(String(options?.env?.CODEX_HOME))
          return args.includes('session')
            ? sessionResult(15)
            : dailyResult(15)
        }
      })

      expect(snapshots).toEqual([
        expect.objectContaining({
          source: 'codex',
          usageDate: '2026-05-22',
          model: 'gpt-5',
          totalTokens: 15,
          sessionCount: 1
        })
      ])
      expect(homes).toEqual([
        `${resolve(firstHome)},${resolve(secondHome)}`,
        `${resolve(firstHome)},${resolve(secondHome)}`
      ])
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps same relative session paths in independent hashed profile cursors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-multi-hook-'))
    const firstHome = join(root, 'first')
    const secondHome = join(root, 'second')
    const stateDir = join(root, 'state')
    const relativeSessionPath = join('2026', '05', '22', 'session.jsonl')

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await Promise.all([
        writeJsonl(join(firstHome, 'sessions', relativeSessionPath), [tokenCountEvent('2026-05-22T01:00:00.000Z', 10)]),
        writeJsonl(join(secondHome, 'sessions', relativeSessionPath), [tokenCountEvent('2026-05-22T02:00:00.000Z', 20)])
      ])

      await collectCodexUsage({
        codexHome: `${firstHome},${secondHome}`,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:00:00.000Z',
        async runner(_command, args) {
          return args.includes('session') ? sessionResult(30) : dailyResult(30)
        }
      })

      const firstScope = resolve(firstHome)
      const secondScope = resolve(secondHome)
      const firstCursorPath = join(stateDir, cursorFileName('codex', firstScope))
      const secondCursorPath = join(stateDir, cursorFileName('codex', secondScope))
      const [firstCursor, secondCursor] = await Promise.all([
        readFile(firstCursorPath, 'utf8'),
        readFile(secondCursorPath, 'utf8')
      ])
      expect(JSON.parse(firstCursor).files['2026/05/22/session.jsonl'].pendingUpload).toBe(true)
      expect(JSON.parse(secondCursor).files['2026/05/22/session.jsonl'].pendingUpload).toBe(true)

      await Promise.all([
        clearPendingUploadCursors({ stateDir, source: 'codex', cursorScope: firstScope }),
        clearPendingUploadCursors({ stateDir, source: 'codex', cursorScope: secondScope })
      ])

      const [acknowledgedFirst, acknowledgedSecond] = await Promise.all([
        readFile(firstCursorPath, 'utf8'),
        readFile(secondCursorPath, 'utf8')
      ])
      expect(JSON.parse(acknowledgedFirst).files['2026/05/22/session.jsonl'].pendingUpload).toBeFalsy()
      expect(JSON.parse(acknowledgedSecond).files['2026/05/22/session.jsonl'].pendingUpload).toBeFalsy()
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps each profile cursor stable when CODEX_HOME order changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-multi-hook-'))
    const firstHome = join(root, 'first')
    const secondHome = join(root, 'second')
    const stateDir = join(root, 'state')
    const relativeSessionPath = join('2026', '05', '22', 'session.jsonl')
    const cursorSessionPath = '2026/05/22/session.jsonl'
    const secondScope = resolve(secondHome)
    const secondCursorPath = join(stateDir, cursorFileName('codex', secondScope))

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(join(secondHome, 'sessions', relativeSessionPath), [
        tokenCountEvent('2026-05-22T01:00:00.000Z', 15)
      ])

      await collectCodexUsage({
        codexHome: `${firstHome},${secondHome}`,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:00:00.000Z',
        async runner(_command, args) {
          return args.includes('session') ? sessionResult(15) : dailyResult(15)
        }
      })
      await clearPendingUploadCursors({ stateDir, source: 'codex', cursorScope: secondScope })

      await expect(collectCodexUsage({
        codexHome: `${secondHome},${firstHome}`,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:01:00.000Z',
        async runner() {
          throw new Error('unchanged sessions must keep their profile cursor after CODEX_HOME is reordered')
        }
      })).resolves.toEqual([])

      expect(JSON.parse(await readFile(secondCursorPath, 'utf8')).files[cursorSessionPath].pendingUpload).toBeFalsy()
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('deduplicates identical deleted pending sessions across independent profiles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-multi-hook-'))
    const firstHome = join(root, 'first')
    const secondHome = join(root, 'second')
    const stateDir = join(root, 'state')
    const relativeSessionPath = join('2026', '05', '22', 'session.jsonl')
    const firstSession = join(firstHome, 'sessions', relativeSessionPath)
    const secondSession = join(secondHome, 'sessions', relativeSessionPath)

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await Promise.all([
        writeJsonl(firstSession, [tokenCountEvent('2026-05-22T01:00:00.000Z', 15)]),
        writeJsonl(secondSession, [tokenCountEvent('2026-05-22T01:00:00.000Z', 15)])
      ])

      await expect(collectCodexUsage({
        codexHome: `${firstHome},${secondHome}`,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:00:00.000Z',
        async runner() {
          return { data: [] }
        }
      })).rejects.toThrow(/Codex hook reconciliation returned no snapshots/)

      await Promise.all([rm(firstSession), rm(secondSession)])
      const snapshots = await collectCodexUsage({
        codexHome: `${firstHome},${secondHome}`,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:01:00.000Z',
        async runner() {
          throw new Error('deleted pending snapshots must not run ccusage reconciliation')
        }
      })

      expect(snapshots).toEqual([
        expect.objectContaining({
          source: 'codex',
          usageDate: '2026-05-22',
          model: 'gpt-5',
          totalTokens: 15,
          sessionCount: 1
        })
      ])
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('reconciles identical pending content through a remaining profile session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-multi-hook-'))
    const firstHome = join(root, 'first')
    const secondHome = join(root, 'second')
    const stateDir = join(root, 'state')
    const relativeSessionPath = join('2026', '05', '22', 'session.jsonl')
    const firstSession = join(firstHome, 'sessions', relativeSessionPath)
    const secondSession = join(secondHome, 'sessions', relativeSessionPath)

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await Promise.all([
        writeJsonl(firstSession, [tokenCountEvent('2026-05-22T01:00:00.000Z', 15)]),
        writeJsonl(secondSession, [tokenCountEvent('2026-05-22T01:00:00.000Z', 15)])
      ])

      await expect(collectCodexUsage({
        codexHome: `${firstHome},${secondHome}`,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:00:00.000Z',
        async runner() {
          return { data: [] }
        }
      })).rejects.toThrow(/Codex hook reconciliation returned no snapshots/)

      await rm(firstSession)
      const snapshots = await collectCodexUsage({
        codexHome: `${firstHome},${secondHome}`,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:01:00.000Z',
        async runner(_command, args) {
          return args.includes('session') ? sessionResult(15) : dailyResult(15)
        }
      })

      expect(snapshots).toEqual([
        expect.objectContaining({
          source: 'codex',
          usageDate: '2026-05-22',
          model: 'gpt-5',
          totalTokens: 15,
          sessionCount: 1
        })
      ])
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('recovers an old single-profile pending cursor after switching to multiple profiles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-multi-hook-'))
    const firstHome = join(root, 'first')
    const secondHome = join(root, 'second')
    const stateDir = join(root, 'state')
    const relativeSessionPath = '2026/05/22/legacy.jsonl'
    const legacyCursorPath = join(stateDir, 'codex-cursor.json')

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeLegacyPendingCursor({
        cursorPath: legacyCursorPath,
        relativePath: relativeSessionPath,
        totalTokens: 15,
        size: 1,
        sha256: 'a'.repeat(64)
      })

      const recovered = await collectCodexUsage({
        codexHome: `${firstHome},${secondHome}`,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:01:00.000Z',
        async runner() {
          throw new Error('the deleted legacy pending snapshot must be recovered without ccusage')
        }
      })
      expect(recovered).toEqual([
        expect.objectContaining({ totalTokens: 15, sessionCount: 1 })
      ])
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('restores one legacy pending snapshot when matching content was copied into multiple profiles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-multi-hook-'))
    const firstHome = join(root, 'first')
    const secondHome = join(root, 'second')
    const stateDir = join(root, 'state')
    const relativeSessionPath = '2026/05/22/legacy-copy.jsonl'
    const firstSession = join(firstHome, 'sessions', relativeSessionPath)
    const secondSession = join(secondHome, 'sessions', relativeSessionPath)
    const legacyCursorPath = join(stateDir, 'codex-cursor.json')

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await Promise.all([
        writeJsonl(firstSession, [tokenCountEvent('2026-05-22T01:00:00.000Z', 15)]),
        writeJsonl(secondSession, [tokenCountEvent('2026-05-22T01:00:00.000Z', 15)])
      ])
      const fingerprint = await fileFingerprint(firstSession)
      await writeLegacyPendingCursor({
        cursorPath: legacyCursorPath,
        relativePath: relativeSessionPath,
        totalTokens: 15,
        ...fingerprint
      })

      await expect(collectCodexUsage({
        codexHome: `${firstHome},${secondHome}`,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:00:00.000Z',
        async runner() {
          return { data: [] }
        }
      })).rejects.toThrow(/Codex hook reconciliation returned no snapshots/)

      await Promise.all([rm(firstSession), rm(secondSession)])
      await expect(collectCodexUsage({
        codexHome: `${firstHome},${secondHome}`,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:01:00.000Z',
        async runner() {
          throw new Error('deleted legacy pending copies must be restored without ccusage reconciliation')
        }
      })).resolves.toEqual([
        expect.objectContaining({ totalTokens: 15, sessionCount: 1 })
      ])
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps an old single-profile pending cursor when a different single profile reuses its relative path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-multi-hook-'))
    const firstHome = join(root, 'first')
    const secondHome = join(root, 'second')
    const stateDir = join(root, 'state')
    const relativeSessionPath = '2026/05/22/session.jsonl'
    const legacyCursorPath = join(stateDir, 'codex-cursor.json')
    const secondCursorPath = join(stateDir, cursorFileName('codex', resolve(secondHome)))

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeLegacyPendingCursor({
        cursorPath: legacyCursorPath,
        relativePath: relativeSessionPath,
        totalTokens: 15,
        size: 1,
        sha256: 'a'.repeat(64)
      })
      await writeJsonl(join(secondHome, 'sessions', relativeSessionPath), [
        tokenCountEvent('2026-05-22T01:00:00.000Z', 25)
      ])

      await expect(collectCodexUsage({
        codexHome: secondHome,
        stateDir,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:01:00.000Z',
        async runner(_command, args) {
          return args.includes('session') ? sessionResult(25) : dailyResult(25)
        }
      })).resolves.toEqual([
        expect.objectContaining({ totalTokens: 40, sessionCount: 2 })
      ])

      const legacy = JSON.parse(await readFile(legacyCursorPath, 'utf8'))
      const second = JSON.parse(await readFile(secondCursorPath, 'utf8'))
      expect(legacy.files[relativeSessionPath]).toEqual(expect.objectContaining({
        pendingUpload: true,
        snapshots: [expect.objectContaining({ totalTokens: 15 })]
      }))
      expect(second.files[relativeSessionPath]).toEqual(expect.objectContaining({
        pendingUpload: true,
        snapshots: [expect.objectContaining({ totalTokens: 25 })]
      }))
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === 'win32')('rejects a legacy cursor session symbolic link during profile migration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-multi-hook-'))
    const firstHome = join(root, 'first')
    const secondHome = join(root, 'second')
    const stateDir = join(root, 'state')
    const relativeSessionPath = '2026/05/22/linked.jsonl'
    const outsideSession = join(root, 'outside.jsonl')
    const linkedSession = join(secondHome, 'sessions', relativeSessionPath)
    const legacyCursorPath = join(stateDir, 'codex-cursor.json')
    const profileCursorPath = join(stateDir, cursorFileName('codex', resolve(secondHome)))

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(outsideSession, [tokenCountEvent('2026-05-22T01:00:00.000Z', 15)])
      await mkdir(dirname(linkedSession), { recursive: true })
      await symlink(outsideSession, linkedSession)
      const fingerprint = await fileFingerprint(outsideSession)
      await writeLegacyPendingCursor({
        cursorPath: legacyCursorPath,
        relativePath: relativeSessionPath,
        totalTokens: 15,
        ...fingerprint
      })

      await expect(collectCodexUsage({
        codexHome: `${firstHome},${secondHome}`,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:01:00.000Z',
        async runner() {
          throw new Error('legacy migration must fail before Codex reconciliation')
        }
      })).rejects.toThrow(/legacy Codex session file: symbolic links are not supported/i)

      const legacyCursor = JSON.parse(await readFile(legacyCursorPath, 'utf8'))
      expect(legacyCursor.files[relativeSessionPath].pendingUpload).toBe(true)
      await expect(readFile(profileCursorPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('recovers a scoped pending cursor after switching back to one profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-multi-hook-'))
    const codexHome = join(root, 'codex')
    const stateDir = join(root, 'state')
    const profileCursorPath = join(stateDir, cursorFileName('codex', resolve(codexHome)))

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', join(root, 'wrong-state'))
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeProfileCursor({
        cursorPath: profileCursorPath,
        relativePath: '2026/05/22/missing.jsonl',
        totalTokens: 15,
        size: 1,
        mtimeMs: Date.parse('2026-05-22T01:00:00.000Z'),
        sha256: 'a'.repeat(64),
        pendingUpload: true
      })

      await expect(collectCodexUsage({
        codexHome,
        stateDir,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:01:00.000Z',
        async runner() {
          throw new Error('a scoped pending snapshot must be recovered without ccusage after returning to one profile')
        }
      })).resolves.toEqual([
        expect.objectContaining({ totalTokens: 15, sessionCount: 1 })
      ])
      await expect(readFile(join(stateDir, 'codex-cursor.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      expect(JSON.parse(await readFile(profileCursorPath, 'utf8')).files['2026/05/22/missing.jsonl'].pendingUpload).toBe(true)
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not revive a legacy pending snapshot already acknowledged by a profile cursor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-multi-hook-'))
    const firstHome = join(root, 'first')
    const secondHome = join(root, 'second')
    const stateDir = join(root, 'state')
    const relativeSessionPath = '2026/05/22/acknowledged.jsonl'
    const sessionFile = join(secondHome, 'sessions', relativeSessionPath)
    const legacyCursorPath = join(stateDir, 'codex-cursor.json')
    const profileCursorPath = join(stateDir, cursorFileName('codex', resolve(secondHome)))

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(sessionFile, [tokenCountEvent('2026-05-22T01:00:00.000Z', 15)])
      const fingerprint = await fileFingerprint(sessionFile)
      await writeLegacyPendingCursor({
        cursorPath: legacyCursorPath,
        relativePath: relativeSessionPath,
        totalTokens: 15,
        size: fingerprint.size,
        sha256: fingerprint.sha256
      })
      await writeProfileCursor({
        cursorPath: profileCursorPath,
        relativePath: relativeSessionPath,
        totalTokens: 15,
        ...fingerprint
      })

      await expect(collectCodexUsage({
        codexHome: `${firstHome},${secondHome}`,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:01:00.000Z',
        async runner() {
          throw new Error('an acknowledged profile cursor must not rerun Codex reconciliation')
        }
      })).resolves.toEqual([])

      expect(JSON.parse(await readFile(legacyCursorPath, 'utf8')).files).toEqual({})
      expect(JSON.parse(await readFile(profileCursorPath, 'utf8')).files[relativeSessionPath].pendingUpload).toBeFalsy()
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function writeJsonl(file: string, rows: unknown[]) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
}

function tokenCountEvent(timestamp: string, totalTokens: number) {
  return {
    type: 'event_msg',
    timestamp,
    payload: {
      type: 'token_count',
      info: {
        model: 'gpt-5',
        last_token_usage: {
          input_tokens: totalTokens,
          output_tokens: 0,
          total_tokens: totalTokens
        }
      }
    }
  }
}

function dailyResult(totalTokens: number) {
  return {
    data: [{
      date: '2026-05-22',
      model: 'gpt-5',
      inputTokens: totalTokens,
      outputTokens: 0,
      totalTokens,
      costUSD: 0.01
    }]
  }
}

function sessionResult(totalTokens: number) {
  return {
    data: [{
      sessionId: 'session',
      directory: '2026/05/22',
      sessionFile: 'session',
      lastActivity: '2026-05-22T01:00:00.000Z',
      models: {
        'gpt-5': {
          inputTokens: totalTokens,
          outputTokens: 0,
          totalTokens
        }
      }
    }]
  }
}

async function writeLegacyPendingCursor(input: {
  cursorPath: string
  relativePath: string
  totalTokens: number
  size: number
  sha256: string
}) {
  await mkdir(dirname(input.cursorPath), { recursive: true })
  await writeFile(input.cursorPath, `${JSON.stringify({
    version: 1,
    source: 'codex',
    files: {
      [input.relativePath]: {
        size: input.size,
        mtimeMs: Date.parse('2026-05-22T01:00:00.000Z'),
        sha256: input.sha256,
        snapshots: [{
          source: 'codex',
          usageDate: '2026-05-22',
          timezone: 'Asia/Shanghai',
          model: 'gpt-5',
          inputTokens: input.totalTokens,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          totalTokens: input.totalTokens,
          costUsd: 0.01,
          sessionCount: 1
        }],
        missingCost: false,
        pendingUpload: true,
        updatedAt: '2026-05-22T10:00:00.000Z'
      }
    }
  }, null, 2)}\n`)
}

async function writeProfileCursor(input: {
  cursorPath: string
  relativePath: string
  totalTokens: number
  size: number
  mtimeMs: number
  sha256: string
  pendingUpload?: boolean
}) {
  await mkdir(dirname(input.cursorPath), { recursive: true })
  await writeFile(input.cursorPath, `${JSON.stringify({
    version: 1,
    source: 'codex',
    files: {
      [input.relativePath]: {
        size: input.size,
        mtimeMs: input.mtimeMs,
        sha256: input.sha256,
        endsWithNewline: true,
        snapshots: [snapshot(input.totalTokens)],
        missingCost: false,
        ...(input.pendingUpload ? { pendingUpload: true } : {}),
        updatedAt: '2026-05-22T10:00:00.000Z'
      }
    }
  }, null, 2)}\n`)
}

function snapshot(totalTokens: number) {
  return {
    source: 'codex',
    usageDate: '2026-05-22',
    timezone: 'Asia/Shanghai',
    model: 'gpt-5',
    inputTokens: totalTokens,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens,
    costUsd: 0.01,
    sessionCount: 1
  }
}

async function fileFingerprint(file: string) {
  const [contents, details] = await Promise.all([readFile(file), stat(file)])
  return {
    size: details.size,
    mtimeMs: details.mtimeMs,
    sha256: createHash('sha256').update(contents).digest('hex')
  }
}
