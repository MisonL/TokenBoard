CREATE INDEX IF NOT EXISTS api_rate_limits_reset_julianday_idx
  ON api_rate_limits(julianday(reset_at));
