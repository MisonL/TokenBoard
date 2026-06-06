CREATE INDEX IF NOT EXISTS daily_usage_logical_key_device_idx
ON daily_usage(user_id, usage_date, source, model, device_id);

CREATE TABLE IF NOT EXISTS daily_usage_summary (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  usage_date TEXT NOT NULL,
  source TEXT NOT NULL,
  model TEXT NOT NULL,
  timezone TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens_without_cache_read INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  session_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, usage_date, source, model)
);

CREATE INDEX IF NOT EXISTS daily_usage_summary_date_user_idx
ON daily_usage_summary(usage_date, user_id);

CREATE TABLE IF NOT EXISTS user_usage_totals (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens_without_cache_read INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  session_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
