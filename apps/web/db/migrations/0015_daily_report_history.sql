CREATE TABLE IF NOT EXISTS daily_report_history (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  report_date TEXT NOT NULL,
  schedule_slot TEXT NOT NULL,
  display_name TEXT NOT NULL,
  timezone TEXT NOT NULL,
  dashboard_url TEXT NOT NULL,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens_without_cache_read INTEGER NOT NULL DEFAULT 0,
  cache_read_rate REAL NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  session_count INTEGER NOT NULL DEFAULT 0,
  source_split TEXT NOT NULL,
  top_models TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS daily_report_history_user_date_slot_idx
ON daily_report_history(user_id, report_date, schedule_slot);

CREATE INDEX IF NOT EXISTS daily_report_history_user_generated_idx
ON daily_report_history(user_id, generated_at);

CREATE INDEX IF NOT EXISTS daily_report_history_report_date_idx
ON daily_report_history(report_date);
