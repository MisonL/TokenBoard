import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { createSqliteD1, runSql } from '../../test/sqlite-d1'
import { D1DevicePairingRepository } from './repository'
import { pairDevice } from './service'

const crashFixturePath = fileURLToPath(
  new URL('../../test/fixtures/device-pairing-crash.ts', import.meta.url)
)

describe('device pairing sqlite contract', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('rolls back pairing consumption when credential creation fails', async () => {
    const { dbPath } = createDeviceDb(tempDirs)
    seedPairing(dbPath)

    const result = spawnSync(process.execPath, ['--import', 'tsx', crashFixturePath, dbPath], {
      encoding: 'utf8'
    })

    expect(result.status, result.stderr).toBe(42)
    expect(readScalar(dbPath, "SELECT consumed_at FROM pairing_codes WHERE id = 'pair_1'")).toBeNull()
    expect(readCount(dbPath, "SELECT COUNT(*) FROM device_installations WHERE id = 'inst_attempt'"))
      .toBe(0)
    expect(readCount(dbPath, "SELECT COUNT(*) FROM upload_tokens WHERE id = 'ut_attempt'"))
      .toBe(0)
    expect(readCount(dbPath, "SELECT COUNT(*) FROM audit_logs WHERE id = 'audit_attempt'"))
      .toBe(0)
  })

  test('creates credentials and consumes the pairing code in one batch', async () => {
    const { db, dbPath } = createDeviceDb(tempDirs)
    seedPairing(dbPath)

    const result = await pairDevice(
      new D1DevicePairingRepository(db),
      pairingRequest(),
      pairingDeps()
    )

    expect(result.deviceId).toBe('dev_attempt')
    expect(readScalar(dbPath, "SELECT consumed_at FROM pairing_codes WHERE id = 'pair_1'"))
      .toBe('2026-07-11T01:00:00.000Z')
    expect(readCount(dbPath, "SELECT COUNT(*) FROM device_installations WHERE id = 'inst_attempt'"))
      .toBe(1)
    expect(readCount(dbPath, "SELECT COUNT(*) FROM upload_tokens WHERE id = 'ut_attempt'"))
      .toBe(1)
    expect(readCount(dbPath, "SELECT COUNT(*) FROM audit_logs WHERE id = 'audit_attempt'"))
      .toBe(1)
  })

  test('rolls back every pairing write when the audit insert fails', async () => {
    const { db, dbPath } = createDeviceDb(tempDirs)
    seedPairing(dbPath)
    runSql(dbPath, `
      INSERT INTO audit_logs (
        id, user_id, actor_type, action, target_type, target_id, created_at
      ) VALUES (
        'audit_attempt', 'user_1', 'user', 'existing', 'device', null,
        '2026-07-11T00:00:00.000Z'
      );
    `)

    await expect(pairDevice(
      new D1DevicePairingRepository(db),
      pairingRequest(),
      pairingDeps()
    )).rejects.toThrow()

    expect(readScalar(dbPath, "SELECT consumed_at FROM pairing_codes WHERE id = 'pair_1'")).toBeNull()
    expect(readCount(dbPath, "SELECT COUNT(*) FROM devices WHERE id = 'dev_attempt'"))
      .toBe(0)
    expect(readCount(dbPath, "SELECT COUNT(*) FROM device_installations WHERE id = 'inst_attempt'"))
      .toBe(0)
    expect(readCount(dbPath, "SELECT COUNT(*) FROM upload_tokens WHERE id = 'ut_attempt'"))
      .toBe(0)
  })
})

function createDeviceDb(tempDirs: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'tokenboard-device-contract-'))
  tempDirs.push(root)
  const dbPath = join(root, 'device.db')
  runSql(dbPath, `
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE pairing_codes (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      code_hash TEXT NOT NULL UNIQUE,
      pairing_type TEXT NOT NULL,
      target_device_id TEXT,
      metadata TEXT,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE devices (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      platform TEXT NOT NULL,
      last_synced_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE device_installations (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      device_id TEXT NOT NULL REFERENCES devices(id),
      platform TEXT NOT NULL,
      hostname TEXT,
      client_version TEXT,
      install_claim_hash TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE upload_tokens (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      device_id TEXT,
      installation_id TEXT,
      supersedes_token_id TEXT,
      last_used_at TEXT,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL
    );
  `)
  return { db: createSqliteD1(dbPath), dbPath }
}

function seedPairing(dbPath: string) {
  runSql(dbPath, `
    INSERT INTO users (id) VALUES ('user_1');
    INSERT INTO pairing_codes (
      id, user_id, code_hash, pairing_type, expires_at, created_at
    ) VALUES (
      'pair_1', 'user_1', 'hash:pairing-code', 'new_device',
      '2026-07-11T02:00:00.000Z', '2026-07-11T00:00:00.000Z'
    );
  `)
}

function pairingRequest() {
  return {
    pairingCode: 'pairing-code',
    deviceName: 'Workstation',
    platform: 'linux',
    timezone: 'UTC'
  }
}

function pairingDeps() {
  return {
    now: () => '2026-07-11T01:00:00.000Z',
    endpoint: 'https://tokenboard.example/api/v1/ingest',
    randomId: () => 'attempt',
    randomToken: () => 'upload-token',
    randomInstallClaim: () => 'install-claim',
    hash: async (value: string) => `hash:${value}`
  }
}

function readScalar(dbPath: string, sql: string) {
  const output = runSql(dbPath, `.mode json\n${sql};`)
  return (JSON.parse(output || '[]') as Array<Record<string, unknown>>)[0]?.consumed_at ?? null
}

function readCount(dbPath: string, sql: string) {
  const output = runSql(dbPath, `.mode json\n${sql};`)
  const row = (JSON.parse(output || '[]') as Array<Record<string, unknown>>)[0]
  return Number(row?.['COUNT(*)'] ?? 0)
}
