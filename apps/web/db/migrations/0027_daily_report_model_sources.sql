WITH effective_daily_usage AS (
  SELECT daily_usage.*
  FROM daily_usage
  WHERE daily_usage.device_id <> 'legacy'
    OR NOT EXISTS (
      SELECT 1
      FROM daily_usage AS current_usage
      WHERE current_usage.user_id = daily_usage.user_id
        AND current_usage.usage_date = daily_usage.usage_date
        AND current_usage.source = daily_usage.source
        AND current_usage.model = daily_usage.model
        AND current_usage.device_id <> 'legacy'
    )
)
UPDATE daily_report_history
SET top_models = (
  SELECT json_group_array(
    CASE
      WHEN json_type(top_model.value, '$.sourceSplit') IS NOT NULL THEN top_model.value
      ELSE json_set(
        top_model.value,
        '$.sourceSplit',
        json((
          SELECT COALESCE(json_group_array(json_object('source', model_sources.source)), '[]')
          FROM (
            SELECT source
            FROM effective_daily_usage
            WHERE user_id = daily_report_history.user_id
              AND usage_date = daily_report_history.report_date
              AND model = json_extract(top_model.value, '$.model')
            GROUP BY source
            ORDER BY source
          ) AS model_sources
        ))
      )
    END
  )
  FROM json_each(daily_report_history.top_models) AS top_model
)
WHERE json_valid(source_split)
  AND json_valid(top_models)
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(daily_report_history.source_split) AS source_item
    WHERE COALESCE((
      SELECT SUM(effective_daily_usage.total_tokens)
      FROM effective_daily_usage
      WHERE effective_daily_usage.user_id = daily_report_history.user_id
        AND effective_daily_usage.usage_date = daily_report_history.report_date
        AND effective_daily_usage.source = json_extract(source_item.value, '$.source')
    ), 0) <> json_extract(source_item.value, '$.totalTokens')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM effective_daily_usage
    WHERE effective_daily_usage.user_id = daily_report_history.user_id
      AND effective_daily_usage.usage_date = daily_report_history.report_date
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(daily_report_history.source_split) AS source_item
        WHERE json_extract(source_item.value, '$.source') = effective_daily_usage.source
      )
  );
