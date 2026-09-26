-- Asserts the rate-limit expression index really exists, by name *and* expression.
--
-- 0033 creates `api_rate_limits_reset_julianday_idx` over `julianday(reset_at)` and 0034
-- drops the plain column index it replaced. Both statements are `IF EXISTS` /
-- `IF NOT EXISTS`, so a wrong apply order, or an index created over the wrong column,
-- leaves the prune query scanning the whole table and reports nothing. This check turns
-- that silent degradation into a hard failure.
--
-- Kept separate from verify-critical-schema.sql because that file is also run against a
-- deliberately partial schema (the migration-ordering gate), where this index does not
-- exist yet.
--
-- `abs(-9223372036854775808)` raises "integer overflow" only when the WHERE clause lets a
-- row through, which a plain `SELECT ... LIMIT 0` could not do.
SELECT abs(-9223372036854775808)
WHERE NOT EXISTS (
  SELECT 1
  FROM sqlite_master
  WHERE type = 'index'
    AND name = 'api_rate_limits_reset_julianday_idx'
    AND lower(replace(sql, ' ', '')) LIKE '%julianday(reset_at)%'
);
