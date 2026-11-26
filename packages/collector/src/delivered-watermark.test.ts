import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  deliveredWatermarkFileName,
  deliveredWatermarkSchemaVersion,
  effectiveSince,
  loadDeliveredWatermark,
  recordDeliveredWatermark,
  tokenFingerprint
} from './delivered-watermark'

// An arbitrary instant inside Asia/Shanghai's 2026-11-26.
const now = new Date('2026-11-26T02:00:00.000Z')
const timeZone = 'Asia/Shanghai'
const endpoint = 'https://tb.example'
const tokenHash = 'abc123abc123abcd'

async function withStateDir(body: (stateDir: string) => Promise<void>) {
  const stateDir = await mkdtemp(join(tmpdir(), 'delivered-watermark-'))
  try {
    await body(stateDir)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
}

async function writeWatermarkFile(stateDir: string, content: string) {
  await writeFile(join(stateDir, deliveredWatermarkFileName), content, { mode: 0o600 })
}

async function effective(stateDir: string, sources: string[] = ['claude-code'], hash = tokenHash) {
  return effectiveSince({ stateDir, sources, endpoint, tokenHash: hash, now, timeZone })
}

function fixture(sources: Record<string, unknown>) {
  return JSON.stringify({ schemaVersion: deliveredWatermarkSchemaVersion, sources })
}

describe('delivered watermark', () => {
  test('fingerprint is the truncated sha256 the Go client writes', () => {
    // sha256(token)'s first eight bytes as hex — the same derivation as
    // clients/go/internal/watermark's TokenFingerprint, pinned to the same
    // value by TestTokenFingerprintMatchesTheTypeScriptCollector on the Go side.
    expect(tokenFingerprint('tb_test_token')).toBe('b5645c485ebefb03')
    expect(tokenFingerprint('')).toBe('')
    expect(tokenFingerprint('tb_test_token')).toBe(tokenFingerprint('tb_test_token'))
    expect(tokenFingerprint('tb_test_token')).not.toBe(tokenFingerprint('tb_other_token'))
  })

  test('a missing file means no watermark', async () => {
    await withStateDir(async (stateDir) => {
      await expect(effective(stateDir)).resolves.toBeUndefined()
    })
  })

  test('a nine-day-old watermark looks back ten days', async () => {
    await withStateDir(async (stateDir) => {
      await writeWatermarkFile(
        stateDir,
        fixture({
          'claude-code': {
            usageDate: '2026-11-17',
            endpoint,
            tokenHash,
            updatedAt: '2026-11-17T03:00:00Z'
          }
        })
      )
      // watermark-1 = 2026-11-16, which is inside [today-30, today-7].
      await expect(effective(stateDir)).resolves.toBe('2026-11-16')
    })
  })

  test('a forty-day-old watermark is clamped to thirty days', async () => {
    await withStateDir(async (stateDir) => {
      await writeWatermarkFile(stateDir, fixture({ 'claude-code': { usageDate: '2026-10-17', endpoint, tokenHash } }))
      await expect(effective(stateDir)).resolves.toBe('2026-10-27')
    })
  })

  test('a recent watermark falls back to the seven-day floor', async () => {
    await withStateDir(async (stateDir) => {
      await writeWatermarkFile(stateDir, fixture({ 'claude-code': { usageDate: '2026-11-24', endpoint, tokenHash } }))
      await expect(effective(stateDir)).resolves.toBe('2026-11-19')
    })
  })

  test('corrupt, wrong-version and future watermarks count as absent', async () => {
    const inputs: Record<string, string> = {
      corrupt: '{"schemaVersion": ',
      'wrong version': fixture({ 'claude-code': { usageDate: '2026-11-17', endpoint, tokenHash } }).replace(
        deliveredWatermarkSchemaVersion,
        'other/v9'
      ),
      'invalid date': fixture({ 'claude-code': { usageDate: '2026-02-30', endpoint, tokenHash } }),
      'future date': fixture({ 'claude-code': { usageDate: '2026-12-01', endpoint, tokenHash } })
    }
    for (const [name, content] of Object.entries(inputs)) {
      await withStateDir(async (stateDir) => {
        await writeWatermarkFile(stateDir, content)
        await expect(effective(stateDir), name).resolves.toBeUndefined()
      })
    }
  })

  test('watermarks from another endpoint or token are not inherited', async () => {
    await withStateDir(async (stateDir) => {
      await writeWatermarkFile(
        stateDir,
        fixture({
          'claude-code': { usageDate: '2026-11-17', endpoint: 'https://other.example', tokenHash },
          codex: { usageDate: '2026-11-17', endpoint, tokenHash: 'old-token' }
        })
      )
      await expect(effective(stateDir, ['claude-code', 'codex'])).resolves.toBeUndefined()
    })
  })

  test('the earliest source drives the process since', async () => {
    await withStateDir(async (stateDir) => {
      await writeWatermarkFile(
        stateDir,
        fixture({
          'claude-code': { usageDate: '2026-11-18', endpoint, tokenHash },
          codex: { usageDate: '2026-11-12', endpoint, tokenHash }
        })
      )
      // codex-1 = 2026-11-11 is earlier than claude-code-1 = 2026-11-17.
      await expect(effective(stateDir, ['claude-code', 'codex'])).resolves.toBe('2026-11-11')
    })
  })

  test('record advances only forward', async () => {
    await withStateDir(async (stateDir) => {
      await recordDeliveredWatermark({
        stateDir,
        endpoint,
        tokenHash,
        advances: { 'claude-code': '2026-11-20' },
        now,
        timeZone
      })
      // An older candidate (a late-dated row from a previous run) must not move it back.
      await recordDeliveredWatermark({
        stateDir,
        endpoint,
        tokenHash,
        advances: { 'claude-code': '2026-11-18' },
        now,
        timeZone
      })
      await expect(effective(stateDir)).resolves.toBe('2026-11-19')
    })
  })

  test('record clamps to today and rejects invalid dates', async () => {
    await withStateDir(async (stateDir) => {
      await recordDeliveredWatermark({
        stateDir,
        endpoint,
        tokenHash,
        advances: {
          'claude-code': '2027-01-01', // a clock that jumped ahead
          codex: 'not-a-date'
        },
        now,
        timeZone
      })
      const entries = await loadDeliveredWatermark(stateDir)
      expect(entries['claude-code'].usageDate).toBe('2026-11-26')
      expect(entries.codex).toBeUndefined()
    })
  })

  test('record preserves other sources, repairs corruption and writes 0600', async () => {
    await withStateDir(async (stateDir) => {
      await writeWatermarkFile(stateDir, '{"schemaVersion": ')
      await recordDeliveredWatermark({
        stateDir,
        endpoint,
        tokenHash,
        advances: { 'claude-code': '2026-11-20' },
        now,
        timeZone
      })
      await recordDeliveredWatermark({
        stateDir,
        endpoint,
        tokenHash,
        advances: { codex: '2026-11-21' },
        now,
        timeZone
      })
      const entries = await loadDeliveredWatermark(stateDir)
      expect(entries['claude-code'].usageDate).toBe('2026-11-20')
      expect(entries.codex.usageDate).toBe('2026-11-21')
      const file = join(stateDir, deliveredWatermarkFileName)
      expect((await stat(file)).mode & 0o777).toBe(0o600)
      const raw = JSON.parse(await readFile(file, 'utf8'))
      expect(raw.schemaVersion).toBe(deliveredWatermarkSchemaVersion)
    })
  })

  test('does not write when nothing advances', async () => {
    await withStateDir(async (stateDir) => {
      await recordDeliveredWatermark({
        stateDir,
        endpoint,
        tokenHash,
        advances: { 'claude-code': '2026-11-20' },
        now,
        timeZone
      })
      const file = join(stateDir, deliveredWatermarkFileName)
      const before = await stat(file)
      await recordDeliveredWatermark({
        stateDir,
        endpoint,
        tokenHash,
        advances: { 'claude-code': '2026-11-19' },
        now,
        timeZone
      })
      expect((await stat(file)).mtimeMs).toBe(before.mtimeMs)
    })
  })

  test('an empty token or empty advances writes nothing', async () => {
    await withStateDir(async (stateDir) => {
      await recordDeliveredWatermark({
        stateDir,
        endpoint,
        tokenHash: '',
        advances: { 'claude-code': '2026-11-20' },
        now,
        timeZone
      })
      await recordDeliveredWatermark({ stateDir, endpoint, tokenHash, advances: {}, now, timeZone })
      await expect(stat(join(stateDir, deliveredWatermarkFileName))).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  // The Go client writes the same file; both sides must agree on the shape.
  test('reads the Go client shape', async () => {
    await withStateDir(async (stateDir) => {
      const file = join(stateDir, deliveredWatermarkFileName)
      await writeFile(
        file,
        JSON.stringify(
          {
            schemaVersion: 'tokenboard-delivered-watermark/v1',
            sources: {
              'claude-code': {
                usageDate: '2026-11-17',
                endpoint,
                tokenHash,
                updatedAt: '2026-11-17T11:00:00.123456789+08:00'
              }
            }
          },
          null,
          2
        )
      )
      await chmod(file, 0o600)
      await expect(effective(stateDir)).resolves.toBe('2026-11-16')
    })
  })
})
