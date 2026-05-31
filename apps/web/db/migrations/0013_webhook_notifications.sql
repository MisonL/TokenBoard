CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  webhook_url_encrypted TEXT NOT NULL,
  webhook_url_host TEXT NOT NULL,
  webhook_url_masked TEXT NOT NULL,
  signing_secret_encrypted TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  schedule_time_local TEXT NOT NULL DEFAULT '09:00',
  send_empty_report INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at TEXT NOT NULL,
  pending_report_date TEXT,
  locked_until TEXT,
  locked_at TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_success_at TEXT,
  last_failure_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS webhook_subscriptions_user_idx
ON webhook_subscriptions(user_id, created_at);

CREATE INDEX IF NOT EXISTS webhook_subscriptions_due_idx
ON webhook_subscriptions(enabled, next_run_at, locked_until);

CREATE TABLE IF NOT EXISTS webhook_delivery_logs (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  report_date TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'daily',
  status TEXT NOT NULL,
  http_status INTEGER,
  attempt INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS webhook_delivery_logs_subscription_idx
ON webhook_delivery_logs(subscription_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS webhook_delivery_logs_daily_success_idx
ON webhook_delivery_logs(subscription_id, report_date, kind)
WHERE status = 'success' AND kind = 'daily';
