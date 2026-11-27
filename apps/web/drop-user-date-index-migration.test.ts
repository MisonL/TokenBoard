import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { runSqliteScript } from './app/test/sqlite-script'

const migrationsDir = resolve(import.meta.dirname, 'db/migrations')
const dropMigration = '0041_drop_daily_usage_user_date_index.sql'

// daily_usage_user_date_idx is a strict prefix of daily_usage_logical_key_device_idx, so
// dropping it must not cost any read. These assertions pin that the index is gone after the
// chain and that the queries which used to land on it now seek the logical-key index — so a
// future predicate that genuinely needs the narrow index fails here, not in production D1.
describe('drop daily_usage_user_date_idx migration', () => {
  test('removes the redundant prefix index without losing the covering seek', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-drop-user-date-index-'))
    const dbPath = join(tempDir, 'tokenboard.db')

    try {
      for (const migration of migrationsBeforeTarget()) {
        runSqlite(dbPath, readFileSync(join(migrationsDir, migration), 'utf8'))
      }
      expect(indexExists(dbPath, 'daily_usage_user_date_idx')).toBe('1')

      expect(runSqlite(dbPath, readFileSync(join(migrationsDir, dropMigration), 'utf8')).status).toBe(0)
      expect(indexExists(dbPath, 'daily_usage_user_date_idx')).toBe('0')

      // The per-user MAX that used the dropped index now seeks the logical-key index.
      const maxPlan = runSqlite(
        dbPath,
        `EXPLAIN QUERY PLAN SELECT MAX(usage_date) AS d FROM daily_usage WHERE user_id = 'u1';`
      ).stdout
      expect(maxPlan).toContain('daily_usage_logical_key_device_idx')
      expect(maxPlan).not.toContain('daily_usage_user_date_idx')

      // Rerunning the migration is a no-op (DROP IF EXISTS).
      expect(runSqlite(dbPath, readFileSync(join(migrationsDir, dropMigration), 'utf8')).status).toBe(0)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }, 30_000)
})

function migrationsBeforeTarget() {
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql') && name < dropMigration)
    .sort()
}

function indexExists(dbPath: string, name: string) {
  return runSqlite(dbPath, `SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = '${name}';`)
    .stdout.trim()
    .split('\n')
    .at(-1)
}

function runSqlite(dbPath: string, sql: string) {
  const result = runSqliteScript(dbPath, sql, { foreignKeys: true })
  if (result.status !== 0) {
    throw new Error(result.stderr || `sqlite exited with status ${result.status}`)
  }
  return result
}
