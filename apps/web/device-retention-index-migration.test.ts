import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { runSqliteScript } from './app/test/sqlite-script'

const migrationsDir = resolve(import.meta.dirname, 'db/migrations')
const indexMigrationFile = '0036_device_retention_julianday_indexes.sql'

// The retention sweep deletes on a `julianday(...)` expression, which no plain-column index can
// serve. These assertions pin that the expression indexes exist after the full chain and that
// SQLite actually picks them for the sweep's predicates, so a future predicate change that drops
// back to a full scan fails here rather than in production cron.
describe('device retention julianday index migration', () => {
  test('creates expression indexes the retention deletes can use', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-retention-index-'))
    const dbPath = join(tempDir, 'tokenboard.db')

    try {
      for (const migration of migrationsThroughTarget()) {
        runSqlite(dbPath, readFileSync(join(migrationsDir, migration), 'utf8'))
      }

      const indexNames = () =>
        runSqlite(
          dbPath,
          `SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%julianday_idx' ORDER BY name;`
        )
          .stdout.trim()
          .split('\n')

      expect(indexNames()).toEqual([
        'api_rate_limits_reset_julianday_idx',
        'audit_logs_created_julianday_idx',
        'pairing_codes_retention_julianday_idx'
      ])

      const pairingPlan = runSqlite(
        dbPath,
        `EXPLAIN QUERY PLAN
         DELETE FROM pairing_codes
         WHERE julianday(COALESCE(consumed_at, expires_at)) IS NULL
            OR julianday(COALESCE(consumed_at, expires_at)) <= julianday('2026-10-01T00:00:00.000Z');`
      ).stdout
      expect(pairingPlan).toContain('pairing_codes_retention_julianday_idx')

      const auditPlan = runSqlite(
        dbPath,
        `EXPLAIN QUERY PLAN
         DELETE FROM audit_logs WHERE julianday(created_at) <= julianday('2026-10-01T00:00:00.000Z');`
      ).stdout
      expect(auditPlan).toContain('audit_logs_created_julianday_idx')

      // Rerunning the migration is a no-op (the indexes already exist).
      const rerun = runSqlite(dbPath, readFileSync(join(migrationsDir, indexMigrationFile), 'utf8'))
      expect(rerun.status).toBe(0)
      expect(indexNames()).toEqual([
        'api_rate_limits_reset_julianday_idx',
        'audit_logs_created_julianday_idx',
        'pairing_codes_retention_julianday_idx'
      ])
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }, 30_000)
})

function migrationsThroughTarget() {
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql') && name <= indexMigrationFile)
    .sort()
}

function runSqlite(dbPath: string, sql: string) {
  const result = runSqliteScript(dbPath, sql, { foreignKeys: true })
  if (result.status !== 0) {
    throw new Error(result.stderr || `sqlite exited with status ${result.status}`)
  }
  return result
}
