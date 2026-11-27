// Local write-volume probe for the TokenBoard ingest path.
// Applies the real migrations to a throwaway SQLite file, installs per-table counting
// triggers, then drives the real repository functions and reports how many row writes
// each phase costs. Trigger counts are logical row changes; D1 additionally bills one row
// write per index on INSERT, which is modelled separately below.
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSqliteD1, runSql } from '/Users/mison/.tokenboard/TokenBoard/apps/web/app/test/sqlite-d1.ts'
import { upsertUsageSnapshots } from '/Users/mison/.tokenboard/TokenBoard/apps/web/app/features/ingest/repository/upsert.ts'
import { findExistingSnapshotHashes } from '/Users/mison/.tokenboard/TokenBoard/apps/web/app/features/ingest/repository/snapshot-hashes.ts'
import { markIngestSynced } from '/Users/mison/.tokenboard/TokenBoard/apps/web/app/features/ingest/repository/sync.ts'

const migrationsDir = '/Users/mison/.tokenboard/TokenBoard/apps/web/db/migrations'
const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
const dir = mkdtempSync(join(tmpdir(), 'write-probe-'))
const dbPath = join(dir, 'probe.db')
runSql(dbPath, files.map((f) => `.read ${join(migrationsDir, f)}`).join('\n'))

const TABLES = [
  'daily_usage',
  'daily_usage_summary',
  'user_usage_totals',
  'devices',
  'upload_tokens',
  'device_installations',
  'api_rate_limits',
  'usage_summary_backfill_state'
]
runSql(dbPath, 'CREATE TABLE audit(tbl TEXT, op TEXT, n INTEGER);')
for (const t of TABLES) {
  for (const op of ['INSERT', 'UPDATE', 'DELETE']) {
    runSql(
      dbPath,
      `CREATE TRIGGER audit_${t}_${op} AFTER ${op} ON ${t} FOR EACH ROW
       BEGIN INSERT INTO audit VALUES ('${t}', '${op}', 1); END;`
    )
  }
}
const reset = () => runSql(dbPath, 'DELETE FROM audit;')
const counts = () => {
  const text = String(runSql(dbPath, 'SELECT tbl, op, COUNT(*) AS n FROM audit GROUP BY tbl, op ORDER BY tbl, op;'))
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const [tbl, op, n] = line.split('|')
      return { tbl, op, n }
    })
}

const now = '2026-11-25T02:00:00.000Z'
runSql(
  dbPath,
  `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ('u1','u1@example.com','u1','${now}','${now}');
   INSERT INTO profiles (user_id, slug, display_name, timezone, timezone_source, is_public, participates_in_leaderboards, created_at, updated_at)
     VALUES ('u1','u1-slug','u1','UTC','default',0,0,'${now}','${now}');
   INSERT INTO upload_tokens (id, user_id, device_id, installation_id, token_hash, name, created_at, last_used_at)
     VALUES ('ut1','u1','dev-a','install-1','hash1','t','${now}',NULL);
   INSERT INTO devices (id, user_id, name, platform, created_at, updated_at, last_synced_at)
     VALUES ('dev-a','u1','d','darwin','${now}','${now}',NULL);
   INSERT INTO device_installations (id, user_id, device_id, platform, first_seen_at, created_at, updated_at, last_seen_at)
     VALUES ('install-1','u1','dev-a','darwin','${now}','${now}','${now}',NULL);
   INSERT INTO usage_summary_backfill_state (id, phase, cursor_user_id, cursor_usage_date, cursor_source, cursor_model, completed_at, updated_at)
     VALUES ('initial','totals',NULL,NULL,NULL,NULL,'${now}','${now}');`
)

const db = createSqliteD1(dbPath)
const rec = (i, tokens = 100) => ({
  userId: 'u1',
  deviceId: 'dev-a',
  source: 'codex',
  usageDate: '2026-11-25',
  timezone: 'Asia/Shanghai',
  model: `m${i}`,
  inputTokens: tokens,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  totalTokens: tokens,
  costUsd: 0.01,
  sessionCount: 1,
  collectedAt: now
})
const show = (label) => {
  const rows = counts()
  const total = rows.reduce((s, r) => s + Number(r.n), 0)
  console.log(`\n## ${label}: ${total} logical row writes`)
  for (const r of rows) console.log(`   ${r.tbl} ${r.op}: ${r.n}`)
  reset()
}

reset()
const first = Array.from({ length: 30 }, (_, i) => rec(i))
await upsertUsageSnapshots(db, first)
await markIngestSynced(db, { uploadTokenHash: 'hash1', deviceId: 'dev-a', installationId: 'install-1', syncedAt: now })
show('first upload: 30 new keys')

const second = Array.from({ length: 30 }, (_, i) => rec(i)) // identical content, new collectedAt
await upsertUsageSnapshots(db, second)
await markIngestSynced(db, {
  uploadTokenHash: 'hash1',
  deviceId: 'dev-a',
  installationId: 'install-1',
  syncedAt: '2026-11-25T02:15:00.000Z'
})
show('re-upload: 30 unchanged keys (collector re-scan)')

const third = Array.from({ length: 30 }, (_, i) => rec(i, i === 0 ? 150 : 100)) // one day grew
await upsertUsageSnapshots(db, third)
await markIngestSynced(db, {
  uploadTokenHash: 'hash1',
  deviceId: 'dev-a',
  installationId: 'install-1',
  syncedAt: '2026-11-25T02:30:00.000Z'
})
show('incremental: 1 of 30 keys changed')

await findExistingSnapshotHashes(db, {
  userId: 'u1',
  deviceId: 'dev-a',
  keys: Array.from({ length: 30 }, (_, i) => ({ source: 'codex', usageDate: '2026-11-25', model: `m${i}` }))
})
show('check endpoint: 30 keys')

console.log('\nIndex inventory on daily_usage:')
for (const name of String(runSql(dbPath, "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='daily_usage' ORDER BY name;")).split('\n').filter(Boolean)) {
  console.log('  ', name)
}
console.log('Index inventory on daily_usage_summary:')
for (const name of String(runSql(dbPath, "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='daily_usage_summary' ORDER BY name;")).split('\n').filter(Boolean)) {
  console.log('  ', name)
}
