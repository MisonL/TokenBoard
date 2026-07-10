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
  cost_usd = CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM json_each(daily_report_history.source_split) AS source_item
      WHERE json_extract(source_item.value, '$.source') NOT IN ('antigravity-cli', 'antigravity', 'antigravity-ide')
    ) THEN 0
    WHEN NOT EXISTS (
      SELECT 1
      FROM json_each(daily_report_history.source_split) AS source_item
      WHERE json_extract(source_item.value, '$.source') IN ('antigravity-cli', 'antigravity', 'antigravity-ide')
        AND COALESCE((
          SELECT SUM(effective_daily_usage.total_tokens)
          FROM effective_daily_usage
          WHERE effective_daily_usage.user_id = daily_report_history.user_id
            AND effective_daily_usage.usage_date = daily_report_history.report_date
            AND effective_daily_usage.source = json_extract(source_item.value, '$.source')
        ), 0) <> json_extract(source_item.value, '$.totalTokens')
    ) AND NOT EXISTS (
      SELECT 1
      FROM effective_daily_usage
      WHERE effective_daily_usage.user_id = daily_report_history.user_id
        AND effective_daily_usage.usage_date = daily_report_history.report_date
        AND effective_daily_usage.source IN ('antigravity-cli', 'antigravity', 'antigravity-ide')
        AND NOT EXISTS (
          SELECT 1
          FROM json_each(daily_report_history.source_split) AS source_item
          WHERE json_extract(source_item.value, '$.source') = effective_daily_usage.source
        )
    ) THEN MAX(daily_report_history.cost_usd - COALESCE((
      SELECT SUM(effective_daily_usage.cost_usd)
      FROM effective_daily_usage
      WHERE effective_daily_usage.user_id = daily_report_history.user_id
        AND effective_daily_usage.usage_date = daily_report_history.report_date
        AND effective_daily_usage.source IN ('antigravity-cli', 'antigravity', 'antigravity-ide')
    ), 0), 0)
    ELSE daily_report_history.cost_usd
  END,
  top_models = (
    SELECT json_group_array(
      json_set(
        top_model.value,
        '$.costUsd',
        CASE
          WHEN NOT EXISTS (
            SELECT 1
            FROM json_each(daily_report_history.source_split) AS source_item
            WHERE json_extract(source_item.value, '$.source') NOT IN ('antigravity-cli', 'antigravity', 'antigravity-ide')
          ) THEN 0
          WHEN NOT EXISTS (
            SELECT 1
            FROM json_each(daily_report_history.source_split) AS source_item
            WHERE json_extract(source_item.value, '$.source') IN ('antigravity-cli', 'antigravity', 'antigravity-ide')
              AND COALESCE((
                SELECT SUM(effective_daily_usage.total_tokens)
                FROM effective_daily_usage
                WHERE effective_daily_usage.user_id = daily_report_history.user_id
                  AND effective_daily_usage.usage_date = daily_report_history.report_date
                  AND effective_daily_usage.source = json_extract(source_item.value, '$.source')
              ), 0) <> json_extract(source_item.value, '$.totalTokens')
          ) AND NOT EXISTS (
            SELECT 1
            FROM effective_daily_usage
            WHERE effective_daily_usage.user_id = daily_report_history.user_id
              AND effective_daily_usage.usage_date = daily_report_history.report_date
              AND effective_daily_usage.source IN ('antigravity-cli', 'antigravity', 'antigravity-ide')
              AND NOT EXISTS (
                SELECT 1
                FROM json_each(daily_report_history.source_split) AS source_item
                WHERE json_extract(source_item.value, '$.source') = effective_daily_usage.source
              )
          ) AND EXISTS (
            SELECT 1
            FROM effective_daily_usage AS model_usage
            WHERE model_usage.user_id = daily_report_history.user_id
              AND model_usage.usage_date = daily_report_history.report_date
              AND model_usage.model = json_extract(top_model.value, '$.model')
              AND model_usage.source IN ('antigravity-cli', 'antigravity', 'antigravity-ide')
          ) AND NOT EXISTS (
            SELECT 1
            FROM effective_daily_usage AS model_usage
            WHERE model_usage.user_id = daily_report_history.user_id
              AND model_usage.usage_date = daily_report_history.report_date
              AND model_usage.model = json_extract(top_model.value, '$.model')
              AND model_usage.source NOT IN ('antigravity-cli', 'antigravity', 'antigravity-ide')
          ) THEN 0
          ELSE json_extract(top_model.value, '$.costUsd')
        END
      )
    )
    FROM json_each(daily_report_history.top_models) AS top_model
  )
WHERE json_valid(source_split)
  AND json_valid(top_models)
  AND EXISTS (
    SELECT 1
    FROM json_each(daily_report_history.source_split) AS source_item
    WHERE json_extract(source_item.value, '$.source') IN ('antigravity-cli', 'antigravity', 'antigravity-ide')
  );

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
