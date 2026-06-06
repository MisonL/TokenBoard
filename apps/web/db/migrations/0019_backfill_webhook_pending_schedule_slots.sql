UPDATE webhook_subscriptions
SET pending_schedule_slot = pending_report_date || 'T' || COALESCE(
  NULLIF(schedule_time_local, ''),
  NULLIF(
    CASE
      WHEN INSTR(schedule_times_local, ',') > 0 THEN SUBSTR(schedule_times_local, 1, INSTR(schedule_times_local, ',') - 1)
      ELSE schedule_times_local
    END,
    ''
  ),
  '18:00'
)
WHERE pending_report_date IS NOT NULL
  AND pending_schedule_slot IS NULL;
