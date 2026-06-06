CREATE TABLE IF NOT EXISTS usage_summary_backfill_state (
  id TEXT PRIMARY KEY,
  phase TEXT NOT NULL DEFAULT 'summaries',
  cursor_user_id TEXT,
  cursor_usage_date TEXT,
  cursor_source TEXT,
  cursor_model TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);

-- Historical usage is backfilled by the scheduled Worker job with a bounded cursor.
