import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { collectCodexUsage } from './codex'

describe('collectCodexUsage', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('runs codex ccusage daily json and normalizes cache input aliases', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')
    const snapshots = await collectCodexUsage({
      timezone: 'Asia/Shanghai',
      collectedAt: '2026-04-28T10:00:00.000Z',
      async runner(command, args) {
        calls.push({ command, args })
        if (args.includes('session')) {
          return {
            data: [
              {
                sessionId: 's1',
                lastActivity: 'Apr 28, 2026',
                models: {
                  'gpt-5': {
                    inputTokens: 1,
                    outputTokens: 2,
                    cachedInputTokens: 4
                  }
                }
              }
            ]
          }
        }
        return {
          data: [
            {
              date: '2026-04-28',
              models: ['gpt-5'],
              inputTokens: 1,
              outputTokens: 2,
              cacheCreationInputTokens: 3,
              cacheReadInputTokens: 4,
              costUSD: 0.01
            }
          ]
        }
      }
    })

    expect(calls).toEqual([
      {
        command: platformCommand('npx'),
        args: ['ccusage@20.0.18', 'codex', 'daily', '--json', '--offline']
      },
      {
        command: platformCommand('npx'),
        args: ['ccusage@20.0.18', 'codex', 'session', '--json', '--offline']
      }
    ])
    expect(snapshots[0]).toMatchObject({
      source: 'codex',
      model: 'gpt-5',
      cacheCreationTokens: 3,
      cacheReadTokens: 4,
      totalTokens: 10,
      sessionCount: 1
    })
  })

  test('passes the configured default since window to frozen bounded reports when env is unset', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const codexHome = await createEmptyCodexHome()
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')
    vi.stubEnv('TOKENBOARD_SINCE', '')
    vi.stubEnv('TOKENBOARD_DEFAULT_SINCE', '20260501')

    try {
      await writeJsonl(join(codexHome, 'sessions', '2026', '05', '01', 'active.jsonl'), [
        tokenCountEvent('2026-05-01T04:24:07.234Z', 10)
      ])
      await collectCodexUsage({
        codexHome,
        async runner(command, args) {
          calls.push({ command, args })
          return { data: [] }
        }
      })
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }

    expect(calls).toEqual([
      {
        command: platformCommand('npx'),
        args: ['ccusage@20.0.18', 'codex', 'daily', '--json', '--offline', '--single-thread', '--since', '20260501']
      },
      {
        command: platformCommand('npx'),
        args: ['ccusage@20.0.18', 'codex', 'session', '--json', '--offline', '--single-thread', '--since', '20260501']
      },
      {
        command: platformCommand('npx'),
        args: ['ccusage@20.0.18', 'codex', 'session', '--json', '--offline', '--single-thread']
      }
    ])
  })

  test('prefers an explicit since window for frozen bounded reports over process environment', async () => {
    const calls: string[][] = []
    const codexHome = await createEmptyCodexHome()
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')
    vi.stubEnv('TOKENBOARD_SINCE', '20260501')

    try {
      await writeJsonl(join(codexHome, 'sessions', '2026', '07', '07', 'active.jsonl'), [
        tokenCountEvent('2026-07-07T16:30:00.000Z', 10)
      ])
      await collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        since: '20260708',
        async runner(_command, args) {
          calls.push(args)
          return { data: [] }
        }
      })
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }

    expect(calls).toEqual([
      ['ccusage@20.0.18', 'codex', 'daily', '--json', '--offline', '--single-thread', '--since', '20260708'],
      ['ccusage@20.0.18', 'codex', 'session', '--json', '--offline', '--single-thread', '--since', '20260708'],
      ['ccusage@20.0.18', 'codex', 'session', '--json', '--offline', '--single-thread']
    ])
  })

  test('rejects shell metacharacters in date filters before running ccusage', async () => {
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')
    await expect(collectCodexUsage({ since: '20260708&echo injected' })).rejects.toThrow(
      'Invalid Codex since date'
    )
    vi.stubEnv('TOKENBOARD_UNTIL', '20260708&echo injected')
    await expect(collectCodexUsage({ since: '20260708' })).rejects.toThrow(
      'Invalid Codex until date'
    )
  })

  test('passes configured codex home to unscoped ccusage commands', async () => {
    const codexHome = await createEmptyCodexHome()
    const homes = new Set<string>()
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await collectCodexUsage({
        codexHome,
        async runner(_command, args, options) {
          homes.add(String(options?.env?.CODEX_HOME))
          if (args.includes('session')) return { data: [] }
          return { data: [] }
        }
      })
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }

    expect(homes).toEqual(new Set([codexHome]))
  })

  test('uses a frozen home for every bounded report', async () => {
    const codexHome = await createEmptyCodexHome()
    const homes = new Set<string>()
    const dailyHomes = new Set<string>()
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(join(codexHome, 'sessions', '2026', '05', '12', 'active.jsonl'), [
        tokenCountEvent('2026-05-12T04:24:07.234Z', 10)
      ])
      await collectCodexUsage({
        codexHome,
        since: '20260512',
        async runner(_command, args, options) {
          const home = String(options?.env?.CODEX_HOME)
          homes.add(home)
          if (args.includes('daily')) dailyHomes.add(home)
          return args.includes('session') ? { data: [] } : { data: [] }
        }
      })
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }

    expect(homes.size).toBe(1)
    expect(homes.has(codexHome)).toBe(false)
    expect(dailyHomes.size).toBe(1)
    expect(dailyHomes).toEqual(homes)
  })

  test('does not create a session-only snapshot for an unbounded Codex report', async () => {
    const codexHome = await createEmptyCodexHome()
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')
    vi.stubEnv('TOKENBOARD_SINCE', '')
    vi.stubEnv('TOKENBOARD_DEFAULT_SINCE', '')
    vi.stubEnv('TOKENBOARD_UNTIL', '')

    try {
      const snapshots = await collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-21T10:00:00.000Z',
        async runner(_command, args) {
          if (args.includes('session')) {
            return {
              sessions: [
                {
                  sessionId: 'session-only',
                  lastActivity: '2026-05-21T04:24:07.234Z',
                  models: { 'gpt-5.6': { totalTokens: 1 } }
                }
              ]
            }
          }
          return {
            data: [
              {
                date: '2026-05-21',
                models: { 'gpt-5.4': { inputTokens: 10, totalTokens: 10 } }
              }
            ]
          }
        }
      })

      expect(snapshots).toEqual([
        expect.objectContaining({
          usageDate: '2026-05-21',
          model: 'gpt-5.4',
          totalTokens: 10,
          sessionCount: 0
        })
      ])
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('uses canonical session attribution for an until-only Codex window', async () => {
    const codexHome = await createEmptyCodexHome()
    const calls: string[][] = []
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')
    vi.stubEnv('TOKENBOARD_SINCE', '')
    vi.stubEnv('TOKENBOARD_DEFAULT_SINCE', '')
    vi.stubEnv('TOKENBOARD_UNTIL', '20260521')

    try {
      await writeJsonl(join(codexHome, 'sessions', '2026', '05', '20', 'stable-session.jsonl'), [
        tokenCountEvent('2026-05-20T04:24:07.234Z', 10)
      ])
      const snapshots = await collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        runner: createWindowSensitiveSessionRunner(calls)
      })

      expect(sessionCountsByDateAndModel(snapshots)).toMatchObject({
        '2026-05-21\u0000gpt-5.5': 1
      })
      expect(calls).toContainEqual(expect.arrayContaining(['codex', 'daily', '--until', '20260521']))
      expect(calls).toContainEqual(expect.arrayContaining(['codex', 'session', '--until', '20260521']))
      expect(calls.filter((args) => args.includes('session') && !args.includes('--until'))).toHaveLength(1)
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('keeps a bounded session date when canonical attribution is newer than the until window', async () => {
    const codexHome = await createEmptyCodexHome()
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')
    vi.stubEnv('TOKENBOARD_SINCE', '')
    vi.stubEnv('TOKENBOARD_DEFAULT_SINCE', '')
    vi.stubEnv('TOKENBOARD_UNTIL', '20260521')

    try {
      await writeJsonl(join(codexHome, 'sessions', '2026', '05', '20', 'stable-session.jsonl'), [
        tokenCountEvent('2026-05-20T04:24:07.234Z', 10)
      ])
      const snapshots = await collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        async runner(_command, args) {
          if (args.includes('daily')) {
            return {
              data: [{
                date: '2026-05-21',
                models: { 'gpt-5.4': { inputTokens: 10, totalTokens: 10 } }
              }]
            }
          }
          if (args.includes('--until')) return boundedSessionResult()
          return {
            sessions: [{
              directory: '2026/05/20',
              sessionFile: 'stable-session',
              lastActivity: '2026-05-24T04:24:07.234Z',
              models: { 'gpt-5.5': { inputTokens: 20, totalTokens: 20 } }
            }]
          }
        }
      })

      expect(snapshots).toContainEqual(expect.objectContaining({
        usageDate: '2026-05-20',
        model: 'gpt-5.5',
        totalTokens: 0,
        sessionCount: 1
      }))
      expect(snapshots.some((snapshot) => snapshot.usageDate > '2026-05-21')).toBe(false)
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('uses canonical session attribution when all history is bounded by until', async () => {
    const codexHome = await createEmptyCodexHome()
    const calls: string[][] = []
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')
    vi.stubEnv('TOKENBOARD_UNTIL', '20260521')

    try {
      await writeJsonl(join(codexHome, 'sessions', '2026', '05', '20', 'stable-session.jsonl'), [
        tokenCountEvent('2026-05-20T04:24:07.234Z', 10)
      ])
      const snapshots = await collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        since: 'all',
        runner: createWindowSensitiveSessionRunner(calls)
      })

      expect(sessionCountsByDateAndModel(snapshots)).toMatchObject({
        '2026-05-21\u0000gpt-5.5': 1
      })
      expect(calls.filter((args) => args.includes('session') && !args.includes('--until'))).toHaveLength(1)
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('uses an archive-only local session for canonical bounded attribution', async () => {
    const codexHome = await createEmptyCodexHome()
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(join(codexHome, 'archived_sessions', '2026', '05', '20', 'stable-session.jsonl'), [
        tokenCountEvent('2026-05-20T04:24:07.234Z', 10)
      ])
      const snapshots = await collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        since: '20260515',
        runner: createWindowSensitiveSessionRunner()
      })

      expect(sessionCountsByDateAndModel(snapshots)).toMatchObject({
        '2026-05-21\u0000gpt-5.5': 1
      })
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('prefers an active session over an archive with the same bounded report path', async () => {
    const codexHome = await createEmptyCodexHome()
    const activeSession = join(codexHome, 'sessions', '2026', '05', '20', 'stable-session.jsonl')
    const archivedSession = join(codexHome, 'archived_sessions', '2026', '05', '20', 'stable-session.jsonl')
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(activeSession, [{ source: 'active' }])
      await writeJsonl(archivedSession, [{ source: 'archive' }])
      const snapshots = await collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        since: '20260515',
        async runner(_command, args, options) {
          if (args.includes('daily')) return windowSensitiveDailyResult()
          if (args.includes('--since')) return boundedSessionResult()
          const scopedHome = String(options?.env?.CODEX_HOME)
          await expect(readFile(join(scopedHome, 'sessions', '2026', '05', '20', 'stable-session.jsonl'), 'utf8'))
            .resolves.toContain('active')
          await expect(readFile(join(scopedHome, 'archived_sessions', '2026', '05', '20', 'stable-session.jsonl'), 'utf8'))
            .rejects.toThrow()
          return canonicalSessionResult('gpt-5.5')
        }
      })

      expect(sessionCountsByDateAndModel(snapshots)).toMatchObject({
        '2026-05-21\u0000gpt-5.5': 1
      })
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('preserves every configured Codex home while resolving bounded canonical attribution', async () => {
    const firstHome = await createEmptyCodexHome()
    const secondHome = await createEmptyCodexHome()
    const calls: Array<{ args: string[]; codexHome: string }> = []
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')
    vi.stubEnv('CODEX_HOME', `${firstHome},${secondHome}`)

    try {
      await writeJsonl(join(firstHome, 'sessions', '2026', '05', '20', 'first.jsonl'), [
        tokenCountEvent('2026-05-20T04:24:07.234Z', 10)
      ])
      await writeJsonl(join(secondHome, 'sessions', '2026', '05', '20', 'second.jsonl'), [
        tokenCountEvent('2026-05-20T04:24:07.234Z', 10)
      ])
      const snapshots = await collectCodexUsage({
        timezone: 'Asia/Shanghai',
        since: '20260515',
        async runner(_command, args, options) {
          const codexHome = String(options?.env?.CODEX_HOME)
          calls.push({ args, codexHome })
          if (args.includes('daily')) return windowSensitiveDailyResult()
          if (args.includes('--since')) return multiBoundedSessionResult()
          expect(codexHome.split(',')).toHaveLength(2)
          expect(codexHome).not.toBe(`${firstHome},${secondHome}`)
          return multiCanonicalSessionResult()
        }
      })

      expect(sessionCountsByDateAndModel(snapshots)).toMatchObject({
        '2026-05-21\u0000gpt-5.5': 2
      })
      expect(calls.filter((call) => call.args.includes('--since'))).toHaveLength(2)
      expect(calls.filter((call) => call.args.includes('session') && !call.args.includes('--since'))).toHaveLength(1)
      expect(calls).toHaveLength(3)
      expect(calls.every((call) => call.codexHome !== `${firstHome},${secondHome}`)).toBe(true)
      expect(calls.every((call) => call.codexHome.split(',').length === 2)).toBe(true)
    } finally {
      await rm(firstHome, { recursive: true, force: true })
      await rm(secondHome, { recursive: true, force: true })
    }
  })

  test('keeps a merged bounded session from duplicate paths across configured Codex homes canonical', async () => {
    const firstHome = await createEmptyCodexHome()
    const secondHome = await createEmptyCodexHome()
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')
    vi.stubEnv('CODEX_HOME', `${firstHome},${secondHome}`)

    try {
      await writeJsonl(join(firstHome, 'sessions', '2026', '05', '20', 'shared.jsonl'), [{ source: 'first' }])
      await writeJsonl(join(secondHome, 'sessions', '2026', '05', '20', 'shared.jsonl'), [{ source: 'second' }])
      const snapshots = await collectCodexUsage({
        timezone: 'Asia/Shanghai',
        since: '20260515',
        async runner(_command, args, options) {
          if (args.includes('daily')) return windowSensitiveDailyResult()
          if (args.includes('--since')) return mergedBoundedSessionResult()
          const scopedHomes = String(options?.env?.CODEX_HOME).split(',')
          expect(scopedHomes).toHaveLength(2)
          await expect(readFile(join(scopedHomes[0], 'sessions', '2026', '05', '20', 'shared.jsonl'), 'utf8'))
            .resolves.toContain('first')
          await expect(readFile(join(scopedHomes[1], 'sessions', '2026', '05', '20', 'shared.jsonl'), 'utf8'))
            .resolves.toContain('second')
          return mergedCanonicalSessionResult()
        }
      })

      expect(sessionCountsByDateAndModel(snapshots)).toMatchObject({
        '2026-05-21\u0000gpt-5.5': 1
      })
    } finally {
      await rm(firstHome, { recursive: true, force: true })
      await rm(secondHome, { recursive: true, force: true })
    }
  })

  test('keeps an unchanged session count attributed to its canonical model across bounded windows', async () => {
    const codexHome = await createEmptyCodexHome()
    const stateDir = await mkdtemp(join(tmpdir(), 'tokenboard-codex-attribution-state-'))
    const calls: string[][] = []
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(join(codexHome, 'sessions', '2026', '05', '20', 'stable-session.jsonl'), [
        tokenCountEvent('2026-05-20T04:24:07.234Z', 10)
      ])

      const first = await collectCodexUsage({
        codexHome,
        stateDir,
        timezone: 'Asia/Shanghai',
        since: '20260501',
        runner: createWindowSensitiveSessionRunner(calls)
      })
      const second = await collectCodexUsage({
        codexHome,
        stateDir,
        timezone: 'Asia/Shanghai',
        since: '20260515',
        runner: createWindowSensitiveSessionRunner(calls)
      })

      expect(sessionCountsByDateAndModel(first)).toEqual({
        '2026-05-20\u0000gpt-5.4': 0,
        '2026-05-20\u0000gpt-5.5': 0,
        '2026-05-20\u0000gpt-5.6': 0,
        '2026-05-21\u0000gpt-5.4': 0,
        '2026-05-21\u0000gpt-5.5': 1,
        '2026-05-21\u0000gpt-5.6': 0
      })
      expect(sessionCountsByDateAndModel(second)).toEqual({
        '2026-05-20\u0000gpt-5.4': 0,
        '2026-05-20\u0000gpt-5.5': 0,
        '2026-05-20\u0000gpt-5.6': 0,
        '2026-05-21\u0000gpt-5.4': 0,
        '2026-05-21\u0000gpt-5.5': 1,
        '2026-05-21\u0000gpt-5.6': 0
      })
      expect(calls.filter((args) => args.includes('session') && !args.includes('--since'))).toHaveLength(1)
      await expect(readFile(join(stateDir, 'codex-session-attribution-cache.json'), 'utf8'))
        .resolves.not.toContain('stable-session')
    } finally {
      await rm(codexHome, { recursive: true, force: true })
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('warms canonical session attribution from a scoped full-history collection', async () => {
    const codexHome = await createEmptyCodexHome()
    const stateDir = await mkdtemp(join(tmpdir(), 'tokenboard-codex-attribution-state-'))
    const calls: string[][] = []
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(join(codexHome, 'sessions', '2026', '05', '20', 'stable-session.jsonl'), [
        tokenCountEvent('2026-05-20T04:24:07.234Z', 10)
      ])
      const runner = createWindowSensitiveSessionRunner(calls)

      await collectCodexUsage({
        codexHome,
        stateDir,
        timezone: 'Asia/Shanghai',
        since: 'all',
        runner
      })
      const bounded = await collectCodexUsage({
        codexHome,
        stateDir,
        timezone: 'Asia/Shanghai',
        since: '20260515',
        runner
      })

      expect(sessionCountsByDateAndModel(bounded)).toEqual({
        '2026-05-20\u0000gpt-5.4': 0,
        '2026-05-20\u0000gpt-5.5': 0,
        '2026-05-20\u0000gpt-5.6': 0,
        '2026-05-21\u0000gpt-5.4': 0,
        '2026-05-21\u0000gpt-5.5': 1,
        '2026-05-21\u0000gpt-5.6': 0
      })
      expect(calls.filter((args) => args.includes('session') && !args.includes('--since'))).toHaveLength(1)
    } finally {
      await rm(codexHome, { recursive: true, force: true })
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('refreshes canonical session attribution when its source file changes', async () => {
    const codexHome = await createEmptyCodexHome()
    const stateDir = await mkdtemp(join(tmpdir(), 'tokenboard-codex-attribution-state-'))
    const sessionPath = join(codexHome, 'sessions', '2026', '05', '20', 'stable-session.jsonl')
    const calls: string[][] = []
    let canonicalModel = 'gpt-5.5'
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(sessionPath, [tokenCountEvent('2026-05-20T04:24:07.234Z', 10)])
      const runner = createWindowSensitiveSessionRunner(calls, () => canonicalModel)

      await collectCodexUsage({
        codexHome,
        stateDir,
        timezone: 'Asia/Shanghai',
        since: '20260515',
        runner
      })
      canonicalModel = 'gpt-5.6'
      await writeFile(sessionPath, `${JSON.stringify(tokenCountEvent('2026-05-21T04:24:07.234Z', 10))}\n`, {
        flag: 'a'
      })
      const refreshed = await collectCodexUsage({
        codexHome,
        stateDir,
        timezone: 'Asia/Shanghai',
        since: '20260515',
        runner
      })

      expect(sessionCountsByDateAndModel(refreshed)).toEqual({
        '2026-05-20\u0000gpt-5.4': 0,
        '2026-05-20\u0000gpt-5.5': 0,
        '2026-05-20\u0000gpt-5.6': 0,
        '2026-05-21\u0000gpt-5.4': 0,
        '2026-05-21\u0000gpt-5.5': 0,
        '2026-05-21\u0000gpt-5.6': 1
      })
      expect(calls.filter((args) => args.includes('session') && !args.includes('--since'))).toHaveLength(2)
    } finally {
      await rm(codexHome, { recursive: true, force: true })
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('keeps a frozen snapshot when its source session changes after canonical attribution begins', async () => {
    const codexHome = await createEmptyCodexHome()
    const sessionPath = join(codexHome, 'sessions', '2026', '05', '20', 'stable-session.jsonl')
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(sessionPath, [tokenCountEvent('2026-05-20T04:24:07.234Z', 10)])
      const snapshots = await collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        since: '20260515',
        async runner(_command, args, options) {
          if (args.includes('daily')) return windowSensitiveDailyResult()
          if (args.includes('--since')) return boundedSessionResult()
          await writeFile(sessionPath, `${JSON.stringify(tokenCountEvent('2026-05-21T04:24:07.234Z', 20))}\n`)
          expect(String(options?.env?.CODEX_HOME)).not.toBe(codexHome)
          return canonicalSessionResult('gpt-5.5')
        }
      })

      expect(sessionCountsByDateAndModel(snapshots)).toMatchObject({
        '2026-05-21\u0000gpt-5.5': 1
      })
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('preserves a canonical session count when its model has no daily token row', async () => {
    const codexHome = await createEmptyCodexHome()
    const stateDir = await mkdtemp(join(tmpdir(), 'tokenboard-codex-attribution-state-'))
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(join(codexHome, 'sessions', '2026', '05', '20', 'stable-session.jsonl'), [
        tokenCountEvent('2026-05-20T04:24:07.234Z', 10)
      ])
      const snapshots = await collectCodexUsage({
        codexHome,
        stateDir,
        timezone: 'Asia/Shanghai',
        since: '20260515',
        runner: createWindowSensitiveSessionRunner([], () => 'gpt-5.6', missingCanonicalModelDailyResult)
      })

      expect(snapshots).toContainEqual(expect.objectContaining({
        usageDate: '2026-05-21',
        model: 'gpt-5.6',
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        sessionCount: 1
      }))
    } finally {
      await rm(codexHome, { recursive: true, force: true })
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('reports partial codex collection when session counts fail', async () => {
    const errors: string[] = []
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')

    const snapshots = await collectCodexUsage({
      stderr: (line) => errors.push(line),
      async runner(_command, args) {
        if (args.includes('session')) {
          throw new Error('session timed out')
        }
        return {
          data: [
            {
              date: '2026-05-12',
              model: 'gpt-5',
              inputTokens: 1,
              outputTokens: 2,
              totalTokens: 3
            }
          ]
        }
      }
    })

    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toMatchObject({
      source: 'codex',
      usageDate: '2026-05-12',
      model: 'gpt-5',
      totalTokens: 3,
      sessionCount: 0
    })
    expect(errors).toEqual([
      'Codex daily tokens collected, but session counts are unavailable; continuing with sessionCount=0: session timed out'
    ])
  })

})

async function writeJsonl(file: string, rows: unknown[]) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, {
    flag: 'w'
  })
}

async function createEmptyCodexHome() {
  const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-codex-home-'))
  await mkdir(join(codexHome, 'sessions'), { recursive: true })
  return codexHome
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

function platformCommand(command: string) {
  return process.platform === 'win32' ? `${command}.cmd` : command
}

function createWindowSensitiveSessionRunner(
  calls: string[][] = [],
  getCanonicalModel: () => string = () => 'gpt-5.5',
  dailyResult: () => unknown = windowSensitiveDailyResult
) {
  return async (_command: string, args: string[]) => {
    calls.push(args)
    if (args.includes('daily')) return dailyResult()
    if (!args.includes('session')) throw new Error('Unexpected ccusage command')
    return args.includes('--since') || args.includes('--until')
      ? boundedSessionResult()
      : canonicalSessionResult(getCanonicalModel())
  }
}

function windowSensitiveDailyResult() {
  return {
    data: [
      {
        date: '2026-05-20',
        models: {
          'gpt-5.4': { inputTokens: 10, totalTokens: 10 },
          'gpt-5.5': { inputTokens: 10, totalTokens: 10 },
          'gpt-5.6': { inputTokens: 10, totalTokens: 10 }
        }
      },
      {
        date: '2026-05-21',
        models: {
          'gpt-5.4': { inputTokens: 10, totalTokens: 10 },
          'gpt-5.5': { inputTokens: 10, totalTokens: 10 },
          'gpt-5.6': { inputTokens: 10, totalTokens: 10 }
        }
      }
    ]
  }
}

function missingCanonicalModelDailyResult() {
  return {
    data: [
      {
        date: '2026-05-21',
        models: {
          'gpt-5.4': { inputTokens: 10, totalTokens: 10 }
        }
      }
    ]
  }
}

function boundedSessionResult() {
  return {
    sessions: [
      {
        directory: '2026/05/20',
        sessionFile: 'stable-session',
        lastActivity: '2026-05-20T04:24:07.234Z',
        models: {
          'gpt-5.4': { inputTokens: 20, totalTokens: 20 },
          'gpt-5.5': { inputTokens: 10, totalTokens: 10 }
        }
      }
    ]
  }
}

function canonicalSessionResult(model: string) {
  return {
    sessions: [
      {
        directory: '2026/05/20',
        sessionFile: 'stable-session',
        lastActivity: '2026-05-21T04:24:07.234Z',
        models: {
          'gpt-5.4': { inputTokens: 10, totalTokens: 10 },
          [model]: { inputTokens: 20, totalTokens: 20 }
        }
      }
    ]
  }
}

function multiBoundedSessionResult() {
  return {
    sessions: [
      {
        directory: '2026/05/20',
        sessionFile: 'first',
        lastActivity: '2026-05-20T04:24:07.234Z',
        models: { 'gpt-5.4': { totalTokens: 10 } }
      },
      {
        directory: '2026/05/20',
        sessionFile: 'second',
        lastActivity: '2026-05-20T04:24:07.234Z',
        models: { 'gpt-5.4': { totalTokens: 10 } }
      }
    ]
  }
}

function multiCanonicalSessionResult() {
  return {
    sessions: [
      {
        directory: '2026/05/20',
        sessionFile: 'first',
        lastActivity: '2026-05-21T04:24:07.234Z',
        models: { 'gpt-5.5': { totalTokens: 20 } }
      },
      {
        directory: '2026/05/20',
        sessionFile: 'second',
        lastActivity: '2026-05-21T04:24:07.234Z',
        models: { 'gpt-5.5': { totalTokens: 20 } }
      }
    ]
  }
}

function mergedBoundedSessionResult() {
  return {
    sessions: [
      {
        directory: '2026/05/20',
        sessionFile: 'shared',
        lastActivity: '2026-05-20T04:24:07.234Z',
        models: { 'gpt-5.4': { totalTokens: 20 } }
      }
    ]
  }
}

function mergedCanonicalSessionResult() {
  return {
    sessions: [
      {
        directory: '2026/05/20',
        sessionFile: 'shared',
        lastActivity: '2026-05-21T04:24:07.234Z',
        models: { 'gpt-5.5': { totalTokens: 40 } }
      }
    ]
  }
}

function sessionCountsByDateAndModel(snapshots: Awaited<ReturnType<typeof collectCodexUsage>>) {
  return Object.fromEntries(snapshots.map((snapshot) => [
    `${snapshot.usageDate}\u0000${snapshot.model}`,
    snapshot.sessionCount
  ]))
}
