-- Asserts the 0036 device-retention expression indexes really exist, by name *and* expression.
--
-- 0036 creates `pairing_codes_retention_julianday_idx` over
-- `julianday(COALESCE(consumed_at, expires_at))` and `audit_logs_created_julianday_idx` over
-- `julianday(created_at)`. They exist for the retention sweep in `features/device/retention.ts`,
-- whose two DELETEs compare those exact expressions — SQLite uses an index only when the indexed
-- expression matches the predicate, so a mismatch (or a missing index) silently leaves both
-- tables fully scanned on every 15-minute cron run. The migration is `CREATE INDEX IF NOT
-- EXISTS`, so a wrong apply order or a dropped index reports success and changes nothing; this
-- check turns that silent degradation into a hard failure.
--
-- Kept separate from verify-critical-schema.sql because that file is also run against a
-- deliberately partial schema (the migration-ordering gate), where these indexes do not exist
-- yet — the same reason verify-rate-limit-index.sql is separate.
--
-- `abs(-9223372036854775808)` raises "integer overflow" only when the WHERE clause lets a row
-- through, which a plain `SELECT ... LIMIT 0` could not do.
SELECT abs(-9223372036854775808)
WHERE NOT EXISTS (
  SELECT 1
  FROM sqlite_master
  WHERE type = 'index'
    AND name = 'pairing_codes_retention_julianday_idx'
    AND lower(replace(sql, ' ', '')) LIKE '%julianday(coalesce(consumed_at,expires_at))%'
);

SELECT abs(-9223372036854775808)
WHERE NOT EXISTS (
  SELECT 1
  FROM sqlite_master
  WHERE type = 'index'
    AND name = 'audit_logs_created_julianday_idx'
    AND lower(replace(sql, ' ', '')) LIKE '%julianday(created_at)%'
);
