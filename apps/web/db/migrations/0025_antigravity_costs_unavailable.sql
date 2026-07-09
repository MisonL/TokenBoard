UPDATE daily_usage
SET cost_usd = 0
WHERE source IN ('antigravity-cli', 'antigravity', 'antigravity-ide')
  AND cost_usd > 0;

UPDATE daily_usage_summary
SET cost_usd = 0
WHERE source IN ('antigravity-cli', 'antigravity', 'antigravity-ide')
  AND cost_usd > 0;

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
UPDATE user_usage_totals
SET cost_usd = COALESCE((
  SELECT SUM(effective_daily_usage.cost_usd)
  FROM effective_daily_usage
  WHERE effective_daily_usage.user_id = user_usage_totals.user_id
), 0)
WHERE user_id IN (
  SELECT DISTINCT user_id
  FROM daily_usage
  WHERE source IN ('antigravity-cli', 'antigravity', 'antigravity-ide')
  UNION
  SELECT DISTINCT user_id
  FROM daily_usage_summary
  WHERE source IN ('antigravity-cli', 'antigravity', 'antigravity-ide')
);

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
SET
  cost_usd = COALESCE((
    SELECT SUM(effective_daily_usage.cost_usd)
    FROM effective_daily_usage
    WHERE effective_daily_usage.user_id = daily_report_history.user_id
      AND effective_daily_usage.usage_date = daily_report_history.report_date
  ), 0),
  top_models = (
    SELECT json_group_array(
      json_set(
        top_model.value,
        '$.costUsd',
        COALESCE((
          SELECT SUM(effective_daily_usage.cost_usd)
          FROM effective_daily_usage
          WHERE effective_daily_usage.user_id = daily_report_history.user_id
            AND effective_daily_usage.usage_date = daily_report_history.report_date
            AND effective_daily_usage.model = json_extract(top_model.value, '$.model')
        ), 0)
      )
    )
    FROM json_each(
      CASE
        WHEN json_valid(daily_report_history.top_models) THEN daily_report_history.top_models
        ELSE '[]'
      END
    ) AS top_model
  )
WHERE json_valid(source_split)
  AND json_valid(top_models)
  AND EXISTS (
    SELECT 1
    FROM json_each(
      CASE
        WHEN json_valid(daily_report_history.source_split) THEN daily_report_history.source_split
        ELSE '[]'
      END
    ) AS source_item
    WHERE json_extract(source_item.value, '$.source') IN ('antigravity-cli', 'antigravity', 'antigravity-ide')
  );
