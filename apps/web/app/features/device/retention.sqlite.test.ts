import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { createSqliteD1, runSql } from '../../test/sqlite-d1'
import { auditLogRetentionDays, pairingCodeRetentionDays, pruneDeviceRetention } from './retention'

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations')

// `pairing_codes` and `audit_logs` grow on every device action and had no runtime delete,
// unlike the rate-limit, webhook-log, and report-history tables. These tests pin the window
// boundaries: a row just inside the window survives, one just outside is removed, and a
// still-valid (unconsumed, unexpired) pairing code is never touched regardless of age.
describe('device retention pruning', () => {
  const tempDirs: string[] = []
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  test('removes old consumed codes and audit rows while keeping recent ones', async () => {
    const { db, path } = createDb(tempDirs)
    const now = new Date('2026-10-07T00:00:00.000Z')

    runSql(
      path,
      `
      INSERT INTO users (id, email, name, email_verified, created_at, updated_at)
      VALUES ('u1','u1@example.com','U1',0,'2026-01-01','2026-01-01');

      INSERT INTO pairing_codes (id, user_id, code_hash, expires_at, consumed_at, created_at)
      VALUES
        ('old','u1','h_old','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z'),
        ('recent','u1','h_recent','2026-10-06T23:00:00.000Z','2026-10-06T23:00:00.000Z','2026-10-06T23:00:00.000Z'),
        ('live','u1','h_live','2026-12-01T00:00:00.000Z',NULL,'2026-01-01T00:00:00.000Z');

      INSERT INTO audit_logs (id, user_id, actor_type, action, target_type, created_at)
      VALUES
        ('a_old','u1','user','rename','device','2024-01-01T00:00:00.000Z'),
        ('a_recent','u1','user','rename','device','2026-10-01T00:00:00.000Z');
    `
    )

    await pruneDeviceRetention(db, now)

    expect(scalarText(path, 'SELECT group_concat(id) FROM pairing_codes ORDER BY id')).toBe('live,recent')
    expect(scalarText(path, 'SELECT group_concat(id) FROM audit_logs ORDER BY id')).toBe('a_recent')
  })

  test('keeps a code just inside each window and drops one just outside', async () => {
    const { db, path } = createDb(tempDirs)
    const now = new Date('2026-10-07T00:00:00.000Z')

    const insidePairing = new Date(now.getTime() - (pairingCodeRetentionDays - 1) * 86_400_000).toISOString()
    const outsidePairing = new Date(now.getTime() - (pairingCodeRetentionDays + 1) * 86_400_000).toISOString()
    const insideAudit = new Date(now.getTime() - (auditLogRetentionDays - 1) * 86_400_000).toISOString()
    const outsideAudit = new Date(now.getTime() - (auditLogRetentionDays + 1) * 86_400_000).toISOString()

    runSql(
      path,
      `
      INSERT INTO users (id, email, name, email_verified, created_at, updated_at)
      VALUES ('u1','u1@example.com','U1',0,'2026-01-01','2026-01-01');

      INSERT INTO pairing_codes (id, user_id, code_hash, expires_at, consumed_at, created_at)
      VALUES
        ('in','u1','h_in','${insidePairing}','${insidePairing}','${insidePairing}'),
        ('out','u1','h_out','${outsidePairing}','${outsidePairing}','${outsidePairing}');

      INSERT INTO audit_logs (id, user_id, actor_type, action, target_type, created_at)
      VALUES
        ('in','u1','user','rename','device','${insideAudit}'),
        ('out','u1','user','rename','device','${outsideAudit}');
    `
    )

    await pruneDeviceRetention(db, now)

    expect(scalarText(path, 'SELECT group_concat(id) FROM pairing_codes ORDER BY id')).toBe('in')
    expect(scalarText(path, 'SELECT group_concat(id) FROM audit_logs ORDER BY id')).toBe('in')
  })
})

function createDb(tempDirs: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'tokenboard-device-retention-'))
  tempDirs.push(dir)
  const path = join(dir, 'test.sqlite')
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
  runSql(path, files.map((file) => `.read ${join(migrationsDir, file)}`).join('\n'))
  return { path, db: createSqliteD1(path) }
}

function scalarText(dbPath: string, sql: string) {
  return runSql(dbPath, sql).trim()
}
