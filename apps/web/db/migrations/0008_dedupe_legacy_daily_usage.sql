CREATE INDEX IF NOT EXISTS daily_usage_logical_key_device_idx
ON daily_usage(user_id, usage_date, source, model, device_id);

DELETE FROM daily_usage
WHERE device_id = 'legacy'
  AND EXISTS (
    SELECT 1
    FROM daily_usage AS current_usage
    WHERE current_usage.user_id = daily_usage.user_id
      AND current_usage.usage_date = daily_usage.usage_date
      AND current_usage.source = daily_usage.source
      AND current_usage.model = daily_usage.model
      AND current_usage.device_id <> 'legacy'
    GROUP BY
      current_usage.user_id,
      current_usage.usage_date,
      current_usage.source,
      current_usage.model
    HAVING SUM(current_usage.input_tokens) = daily_usage.input_tokens
      AND SUM(current_usage.output_tokens) = daily_usage.output_tokens
      AND SUM(current_usage.cache_creation_tokens) = daily_usage.cache_creation_tokens
      AND SUM(current_usage.cache_read_tokens) = daily_usage.cache_read_tokens
      AND SUM(current_usage.total_tokens) = daily_usage.total_tokens
      AND ABS(SUM(current_usage.cost_usd) - daily_usage.cost_usd) < 0.000001
      AND SUM(current_usage.session_count) = daily_usage.session_count
  );
