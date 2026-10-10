-- Function indexes for the device retention sweep in `features/device/retention.ts`.
--
-- Both deletes compare a `julianday(...)` expression, not a bare column, so the plain
-- indexes on `pairing_codes(code_hash)` / `pairing_codes(target_device)` and
-- `audit_logs(created_at)` cannot serve them: SQLite only uses an index when the indexed
-- expression matches the predicate. Without these, every 15-minute cron run scans both
-- tables in full, and both grow on every device action. `0033` created the same shape of
-- expression index for `api_rate_limits(reset_at)` for the same reason.
--
-- `pairing_codes` is keyed on `COALESCE(consumed_at, expires_at)` because the sweep prunes a
-- code once it is consumed or expired; `expires_at` is NOT NULL, so the expression is never
-- NULL. `audit_logs` prunes on `created_at`, which is NOT NULL as well.
CREATE INDEX IF NOT EXISTS pairing_codes_retention_julianday_idx
  ON pairing_codes(julianday(COALESCE(consumed_at, expires_at)));

CREATE INDEX IF NOT EXISTS audit_logs_created_julianday_idx
  ON audit_logs(julianday(created_at));
