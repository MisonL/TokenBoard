import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync('/tmp/d1plan-probe.sqlite')
const plan = (label, sql, ...p) => {
  console.log(`\n== ${label} ==`)
  for (const r of db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...p)) console.log('  ', r.detail)
}
const qMaxDate = `SELECT MAX(usage_date) AS d FROM daily_usage WHERE user_id = ?`
const qDedup = `SELECT SUM(total_tokens) FROM daily_usage WHERE user_id = ? AND usage_date >= ? AND usage_date <= ?
  AND (device_id <> 'legacy' OR NOT EXISTS (SELECT 1 FROM daily_usage c WHERE c.user_id=daily_usage.user_id
      AND c.usage_date=daily_usage.usage_date AND c.source=daily_usage.source AND c.model=daily_usage.model AND c.device_id <> 'legacy'))`
const qDevice = `SELECT SUM(total_tokens) FROM daily_usage WHERE user_id = ? AND usage_date >= ? AND usage_date <= ? AND device_id = ?`
const qBackfill = `SELECT user_id, usage_date, source, model FROM daily_usage GROUP BY user_id, usage_date, source, model ORDER BY user_id ASC, usage_date ASC, source ASC, model ASC LIMIT ?`
const qHashOr = `SELECT source FROM daily_usage WHERE user_id=? AND device_id=? AND snapshot_hash IS NOT NULL AND (source=? AND usage_date=? AND model=?)`

plan('BEFORE: MAX(usage_date)', qMaxDate, 'u1')
plan('BEFORE: per-user dedup range', qDedup, 'u1','2026-10-01','2026-10-31')
plan('BEFORE: device-filtered range', qDevice, 'u1','2026-10-01','2026-10-31','dev-a')
plan('BEFORE: backfill walk', qBackfill, 10)
plan('BEFORE: hash OR-form', qHashOr, 'u1','dev-a','codex','2026-10-28','model-1')

db.exec('DROP INDEX IF EXISTS daily_usage_user_date_idx')
console.log('\n--- dropped daily_usage_user_date_idx ---')
plan('AFTER: MAX(usage_date)', qMaxDate, 'u1')
plan('AFTER: per-user dedup range', qDedup, 'u1','2026-10-01','2026-10-31')
plan('AFTER: device-filtered range', qDevice, 'u1','2026-10-01','2026-10-31','dev-a')
plan('AFTER: backfill walk', qBackfill, 10)
plan('AFTER: hash OR-form', qHashOr, 'u1','dev-a','codex','2026-10-28','model-1')
