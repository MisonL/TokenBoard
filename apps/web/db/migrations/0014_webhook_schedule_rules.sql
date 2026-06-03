ALTER TABLE webhook_subscriptions
ADD COLUMN schedule_times_local TEXT NOT NULL DEFAULT '18:00';

ALTER TABLE webhook_subscriptions
ADD COLUMN schedule_weekdays TEXT NOT NULL DEFAULT '0,1,2,3,4,5,6';

ALTER TABLE webhook_subscriptions
ADD COLUMN pending_schedule_slot TEXT;

UPDATE webhook_subscriptions
SET schedule_times_local = schedule_time_local
WHERE schedule_time_local IS NOT NULL;

UPDATE webhook_subscriptions
SET pending_schedule_slot = pending_report_date || 'T' || COALESCE(schedule_time_local, '18:00')
WHERE pending_report_date IS NOT NULL
  AND pending_schedule_slot IS NULL;

ALTER TABLE webhook_delivery_logs
ADD COLUMN schedule_slot TEXT;

CREATE INDEX IF NOT EXISTS webhook_delivery_logs_subscription_idx
ON webhook_delivery_logs(subscription_id);

UPDATE webhook_delivery_logs
SET schedule_slot = report_date || 'T' || COALESCE((
  SELECT webhook_subscriptions.schedule_time_local
  FROM webhook_subscriptions
  WHERE webhook_subscriptions.id = webhook_delivery_logs.subscription_id
), '18:00')
WHERE kind = 'daily'
  AND schedule_slot IS NULL;

DROP INDEX IF EXISTS webhook_delivery_logs_daily_success_idx;

CREATE UNIQUE INDEX IF NOT EXISTS webhook_delivery_logs_daily_success_idx
ON webhook_delivery_logs(subscription_id, report_date, kind, schedule_slot)
WHERE status = 'success' AND kind = 'daily' AND schedule_slot IS NOT NULL;

CREATE INDEX IF NOT EXISTS webhook_delivery_logs_created_idx
ON webhook_delivery_logs(created_at);
