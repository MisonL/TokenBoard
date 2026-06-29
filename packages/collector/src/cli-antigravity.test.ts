import { describe, expect, test } from 'vitest'
import type { UsageSnapshot } from '@tokenboard/usage-core'
import { runCollectorCli } from './cli'

const antigravitySnapshot: UsageSnapshot = {
  source: 'antigravity-cli',
  usageDate: '2026-06-23',
  timezone: 'Asia/Shanghai',
  model: 'Gemini 3.5 Flash (Medium)',
  inputTokens: 10,
  outputTokens: 2,
  cacheCreationTokens: 0,
  cacheReadTokens: 5,
  totalTokens: 17,
  costUsd: 0,
  sessionCount: 1,
  collectedAt: '2026-06-23T10:00:00.000Z'
}

describe('runCollectorCli Antigravity source', () => {
  test('previews the selected Antigravity CLI source', async () => {
    const stdout: string[] = []

    const result = await runCollectorCli(
      ['preview', '--source', 'antigravity-cli'],
      { TOKENBOARD_TIMEZONE: 'Asia/Shanghai', TOKENBOARD_STATE_DIR: '/state' },
      deps({
        stdout: (line) => stdout.push(line),
        collectAntigravityCliUsage: async (options) => {
          expect(options?.stateDir).toBe('/state')
          return [antigravitySnapshot]
        }
      })
    )

    expect(result).toBe(0)
    expect(JSON.parse(stdout[0])).toEqual([antigravitySnapshot])
  })

  test('previews the standalone Antigravity source', async () => {
    const stdout: string[] = []

    const result = await runCollectorCli(
      ['preview', '--source', 'antigravity'],
      { TOKENBOARD_TIMEZONE: 'Asia/Shanghai', TOKENBOARD_STATE_DIR: '/state' },
      deps({
        stdout: (line) => stdout.push(line),
        collectAntigravityUsage: async (options) => {
          expect(options?.stateDir).toBe('/state')
          return [{ ...antigravitySnapshot, source: 'antigravity' }]
        }
      })
    )

    expect(result).toBe(0)
    expect(JSON.parse(stdout[0])).toEqual([{ ...antigravitySnapshot, source: 'antigravity' }])
  })

  test('previews the standalone Antigravity IDE source', async () => {
    const stdout: string[] = []

    const result = await runCollectorCli(
      ['preview', '--source', 'antigravity-ide'],
      { TOKENBOARD_TIMEZONE: 'Asia/Shanghai', TOKENBOARD_STATE_DIR: '/state' },
      deps({
        stdout: (line) => stdout.push(line),
        collectAntigravityIdeUsage: async (options) => {
          expect(options?.stateDir).toBe('/state')
          return [{ ...antigravitySnapshot, source: 'antigravity-ide' }]
        }
      })
    )

    expect(result).toBe(0)
    expect(JSON.parse(stdout[0])).toEqual([{ ...antigravitySnapshot, source: 'antigravity-ide' }])
  })

  test('treats missing Antigravity statusline capture as optional in all mode', async () => {
    const stderr: string[] = []

    const result = await runCollectorCli(
      ['preview', '--source', 'all'],
      { TOKENBOARD_TIMEZONE: 'Asia/Shanghai' },
      deps({
        stderr: (line) => stderr.push(line),
        collectAntigravityCliUsage: async () => {
          throw new Error('Antigravity CLI statusline log not found: /state/antigravity-cli-statusline.jsonl')
        }
      })
    )

    expect(result).toBe(0)
    expect(stderr).toEqual([
      'Skipping antigravity-cli source: Antigravity CLI statusline log not found: /state/antigravity-cli-statusline.jsonl'
    ])
  })

  test('does not fail strict all mode when Antigravity products are not installed', async () => {
    const stderr: string[] = []
    const uploaded: UsageSnapshot[][] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'all'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_FAIL_ON_SOURCE_ERROR: '1'
      },
      deps({
        stderr: (line) => stderr.push(line),
        uploadSnapshots: async (_config, snapshots) => {
          uploaded.push(snapshots)
          return { upserted: snapshots.length, skipped: 0 }
        },
        collectAntigravityCliUsage: async () => {
          throw new Error('Antigravity CLI statusline log not found: /state/antigravity-cli-statusline.jsonl')
        },
        collectAntigravityUsage: async () => {
          throw new Error('Antigravity conversations directory not found: /Users/test/.gemini/antigravity/conversations')
        },
        collectAntigravityIdeUsage: async () => {
          throw new Error('No Antigravity conversations found in /Users/test/.gemini/antigravity-ide/conversations')
        }
      })
    )

    expect(result).toBe(0)
    expect(uploaded).toEqual([[]])
    expect(stderr).toEqual([
      'Skipping antigravity-cli source: Antigravity CLI statusline log not found: /state/antigravity-cli-statusline.jsonl',
      'Skipping antigravity source: Antigravity conversations directory not found: /Users/test/.gemini/antigravity/conversations',
      'Skipping antigravity-ide source: No Antigravity conversations found in /Users/test/.gemini/antigravity-ide/conversations'
    ])
  })

  test('does not fail strict all mode when the optional Antigravity SQLite reader is unavailable', async () => {
    const stderr: string[] = []
    const uploaded: UsageSnapshot[][] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'all'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_FAIL_ON_SOURCE_ERROR: '1'
      },
      deps({
        stderr: (line) => stderr.push(line),
        uploadSnapshots: async (_config, snapshots) => {
          uploaded.push(snapshots)
          return { upserted: snapshots.length, skipped: 0 }
        },
        collectAntigravityUsage: async () => {
          throw new Error('Antigravity SQLite reader unavailable: sqlite3 not found')
        }
      })
    )

    expect(result).toBe(0)
    expect(uploaded).toEqual([[]])
    expect(stderr).toEqual([
      'Skipping antigravity source: Antigravity SQLite reader unavailable: sqlite3 not found'
    ])
  })

  test('does not fail strict all mode when an optional Antigravity language server is unavailable', async () => {
    const stderr: string[] = []
    const uploaded: UsageSnapshot[][] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'all'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_FAIL_ON_SOURCE_ERROR: '1'
      },
      deps({
        stderr: (line) => stderr.push(line),
        uploadSnapshots: async (_config, snapshots) => {
          uploaded.push(snapshots)
          return { upserted: snapshots.length, skipped: 0 }
        },
        collectAntigravityUsage: async () => {
          throw new Error('spawn /missing/tokenboard-antigravity-language-server ENOENT')
        }
      })
    )

    expect(result).toBe(0)
    expect(uploaded).toEqual([[]])
    expect(stderr).toEqual([
      'Skipping antigravity source: spawn /missing/tokenboard-antigravity-language-server ENOENT'
    ])
  })

  test('still fails strict all mode when an installed Antigravity source has a real parse error', async () => {
    const stderr: string[] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'all'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_FAIL_ON_SOURCE_ERROR: '1'
      },
      deps({
        stderr: (line) => stderr.push(line),
        collectAntigravityUsage: async () => {
          throw new Error('Invalid Antigravity generator metadata item 3: inputTokens must be a bounded nonnegative integer')
        }
      })
    )

    expect(result).toBe(1)
    expect(stderr).toEqual([
      'Skipping antigravity source: Invalid Antigravity generator metadata item 3: inputTokens must be a bounded nonnegative integer',
      'One or more sources failed: antigravity: Invalid Antigravity generator metadata item 3: inputTokens must be a bounded nonnegative integer'
    ])
  })

  test('still fails strict all mode for real Antigravity ENOENT failures', async () => {
    const stderr: string[] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'all'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_FAIL_ON_SOURCE_ERROR: '1'
      },
      deps({
        stderr: (line) => stderr.push(line),
        collectAntigravityUsage: async () => {
          throw new Error('Failed to read Antigravity metadata from /Users/test/.gemini/antigravity/conversations/cascade.pb: ENOENT')
        }
      })
    )

    expect(result).toBe(1)
    expect(stderr).toEqual([
      'Skipping antigravity source: Failed to read Antigravity metadata from /Users/test/.gemini/antigravity/conversations/cascade.pb: ENOENT',
      'One or more sources failed: antigravity: Failed to read Antigravity metadata from /Users/test/.gemini/antigravity/conversations/cascade.pb: ENOENT'
    ])
  })

  test('acks Antigravity cursors after a successful non-hook upload', async () => {
    const acks: string[] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'antigravity-ide'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_STATE_DIR: '/state'
      },
      deps({
        collectAntigravityIdeUsage: async () => [{ ...antigravitySnapshot, source: 'antigravity-ide' }],
        uploadSnapshots: async () => ({ upserted: 1, skipped: 0 }),
        clearPendingUploadCursors: async (input) => {
          acks.push(`${input.stateDir}:${input.source}`)
        }
      })
    )

    expect(result).toBe(0)
    expect(acks).toEqual(['/state:antigravity-ide'])
  })

  test('does not ack Antigravity cursors when upload fails', async () => {
    const stderr: string[] = []
    const acks: string[] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'antigravity-cli'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_STATE_DIR: '/state'
      },
      deps({
        stderr: (line) => stderr.push(line),
        collectAntigravityCliUsage: async () => [antigravitySnapshot],
        uploadSnapshots: async () => {
          throw new Error('upload failed')
        },
        clearPendingUploadCursors: async (input) => {
          acks.push(`${input.stateDir}:${input.source}`)
        }
      })
    )

    expect(result).toBe(1)
    expect(stderr).toEqual(['upload failed'])
    expect(acks).toEqual([])
  })

  test('skips Antigravity sources in hook all mode', async () => {
    const stderr: string[] = []
    const calls: string[] = []
    const uploaded: UsageSnapshot[][] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'all'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_HOOK_MODE: '1'
      },
      deps({
        stderr: (line) => stderr.push(line),
        collectClaudeCodeUsage: async () => [],
        collectCodexUsage: async () => [],
        collectAntigravityUsage: async () => {
          calls.push('antigravity')
          throw new Error('Invalid Antigravity generator metadata item 3: inputTokens must be a bounded nonnegative integer')
        },
        collectAntigravityIdeUsage: async () => {
          calls.push('antigravity-ide')
          return [{ ...antigravitySnapshot, source: 'antigravity-ide' }]
        },
        collectAntigravityCliUsage: async () => {
          calls.push('antigravity-cli')
          return [antigravitySnapshot]
        },
        uploadSnapshots: async (_config, snapshots) => {
          uploaded.push(snapshots)
          return { upserted: snapshots.length, skipped: 0 }
        }
      })
    )

    expect(result).toBe(0)
    expect(calls).toEqual([])
    expect(uploaded).toEqual([[]])
    expect(stderr).toEqual([])
  })

  test('collects all three Antigravity products in all mode', async () => {
    const calls: string[] = []

    const result = await runCollectorCli(
      ['preview', '--source', 'all'],
      { TOKENBOARD_TIMEZONE: 'Asia/Shanghai' },
      deps({
        stderr: (line) => calls.push(`stderr:${line}`),
        collectAntigravityCliUsage: async () => {
          calls.push('cli')
          return []
        },
        collectAntigravityUsage: async () => {
          calls.push('gui')
          return []
        },
        collectAntigravityIdeUsage: async () => {
          calls.push('ide')
          return []
        }
      })
    )

    expect(result).toBe(0)
    expect(calls).toEqual(['cli', 'gui', 'ide'])
  })
})

function deps(overrides: Partial<Parameters<typeof runCollectorCli>[2]> = {}) {
  return {
    stdout: () => undefined,
    stderr: () => undefined,
    collectClaudeCodeUsage: async () => [],
    collectCodexUsage: async () => [],
    uploadSnapshots: async () => ({ upserted: 0, skipped: 0 }),
    ...overrides
  }
}
