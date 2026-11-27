import {
  summaryRefreshCheckChunkSize,
  totalRefreshCheckChunkSize,
  uniqueSummaryKeys,
  usageSummaryBackfillStateId,
  type UsageSummaryKey
} from './types'
import { billableCostSql } from '../../../lib/usage-cost'

// One timestamp per batch: the public-card cache key hashes both aggregate `updated_at`
// columns, so a request-wide stamp would keep the key constant across batches while the
// underlying data changed. A per-batch stamp advances it; all statements in one batch share
// the same value so a reader can never see a newer stamp on one aggregate than the other.
export function nextAggregateTimestamp(previous?: Date): Date {
  const now = new Date()
  return previous && now.getTime() <= previous.getTime() ? new Date(previous.getTime() + 1) : now
}

export function prepareSummaryRefresh(db: D1Database, key: UsageSummaryKey, updatedAt: string) {
  return db
    .prepare(refreshSummarySql)
    .bind(key.userId, key.usageDate, key.source, key.model, key.userId, key.usageDate, key.source, key.model, updatedAt)
}

export function prepareUserTotalFromSummaryRefresh(db: D1Database, userId: string, updatedAt: string) {
  // Parameter order follows the SQL text: the selected user_id, then updated_at, then the
  // join's user_id. The timestamp sits between the two user ids because it appears in the
  // final SELECT column list, ahead of the LEFT JOIN.
  return db.prepare(refreshUserTotalsFromSummarySql).bind(userId, updatedAt, userId)
}

export async function listSummaryKeysNeedingRefresh(db: D1Database, records: UsageSummaryKey[]) {
  const keys = uniqueSummaryKeys(records)
  if (keys.length === 0) return []
  const missingOrStale: UsageSummaryKey[] = []
  for (let index = 0; index < keys.length; index += summaryRefreshCheckChunkSize) {
    const chunk = keys.slice(index, index + summaryRefreshCheckChunkSize)
    const rows = await db
      .prepare(summaryRefreshCheckSql(chunk))
      .bind(...chunk.flatMap((key) => [key.userId, key.usageDate, key.source, key.model]))
      .all<UsageSummaryKey>()
    missingOrStale.push(...(rows.results ?? []))
  }
  return missingOrStale
}

export async function listUserIdsNeedingTotalRefresh(db: D1Database, userIds: string[]) {
  if (userIds.length === 0) return []
  const missingOrStale: string[] = []
  for (let index = 0; index < userIds.length; index += totalRefreshCheckChunkSize) {
    const chunk = userIds.slice(index, index + totalRefreshCheckChunkSize)
    const rows = await db
      .prepare(totalRefreshCheckSql(chunk))
      .bind(...chunk)
      .all<{ userId: string }>()
    missingOrStale.push(...(rows.results ?? []).map((row) => row.userId))
  }
  return missingOrStale
}

function summaryRefreshCheckSql(keys: UsageSummaryKey[]) {
  const predicates = keys.map(() => '(user_id = ? AND usage_date = ? AND source = ? AND model = ?)').join(' OR ')
  return `
    WITH requested_keys AS (
      SELECT user_id, usage_date, source, model
      FROM daily_usage
      WHERE ${predicates}
      GROUP BY user_id, usage_date, source, model
    ),
    expected_summary AS (
      SELECT
        requested_keys.user_id,
        requested_keys.usage_date,
        requested_keys.source,
        requested_keys.model,
        COALESCE(SUM(daily_usage.input_tokens), 0) as input_tokens,
        COALESCE(SUM(daily_usage.output_tokens), 0) as output_tokens,
        COALESCE(SUM(daily_usage.cache_creation_tokens), 0) as cache_creation_tokens,
        COALESCE(SUM(daily_usage.cache_read_tokens), 0) as cache_read_tokens,
        COALESCE(SUM(daily_usage.total_tokens), 0) as total_tokens,
        COALESCE(SUM(daily_usage.total_tokens - daily_usage.cache_read_tokens), 0) as total_tokens_without_cache_read,
        COALESCE(SUM(${billableCostSql({ sourceColumn: 'daily_usage.source', costColumn: 'daily_usage.cost_usd' })}), 0) as cost_usd,
        COALESCE(SUM(daily_usage.session_count), 0) as session_count
      FROM requested_keys
      JOIN daily_usage
        ON daily_usage.user_id = requested_keys.user_id
        AND daily_usage.usage_date = requested_keys.usage_date
        AND daily_usage.source = requested_keys.source
        AND daily_usage.model = requested_keys.model
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
      GROUP BY requested_keys.user_id, requested_keys.usage_date, requested_keys.source, requested_keys.model
    )
    SELECT
      expected_summary.user_id as userId,
      expected_summary.usage_date as usageDate,
      expected_summary.source,
      expected_summary.model
    FROM expected_summary
    LEFT JOIN daily_usage_summary
      ON daily_usage_summary.user_id = expected_summary.user_id
      AND daily_usage_summary.usage_date = expected_summary.usage_date
      AND daily_usage_summary.source = expected_summary.source
      AND daily_usage_summary.model = expected_summary.model
    WHERE daily_usage_summary.user_id IS NULL
      OR daily_usage_summary.input_tokens <> expected_summary.input_tokens
      OR daily_usage_summary.output_tokens <> expected_summary.output_tokens
      OR daily_usage_summary.cache_creation_tokens <> expected_summary.cache_creation_tokens
      OR daily_usage_summary.cache_read_tokens <> expected_summary.cache_read_tokens
      OR daily_usage_summary.total_tokens <> expected_summary.total_tokens
      OR daily_usage_summary.total_tokens_without_cache_read <> expected_summary.total_tokens_without_cache_read
      OR daily_usage_summary.cost_usd <> expected_summary.cost_usd
      OR daily_usage_summary.session_count <> expected_summary.session_count
  `
}

function totalRefreshCheckSql(userIds: string[]) {
  const predicates = userIds.map(() => '?').join(', ')
  return `
    WITH totals_refresh_allowed AS (
      SELECT 1 AS allowed
      FROM usage_summary_backfill_state
      WHERE id = '${usageSummaryBackfillStateId}'
        AND (
          phase = 'totals'
          OR completed_at IS NOT NULL
        )
    ),
    requested_users AS (
      SELECT user_id
      FROM daily_usage_summary
      JOIN totals_refresh_allowed
      WHERE user_id IN (${predicates})
      GROUP BY user_id
    ),
    expected_totals AS (
      SELECT
        requested_users.user_id,
        COALESCE(SUM(daily_usage_summary.total_tokens), 0) as total_tokens,
        COALESCE(SUM(daily_usage_summary.total_tokens_without_cache_read), 0) as total_tokens_without_cache_read,
        COALESCE(SUM(${billableCostSql({ sourceColumn: 'daily_usage_summary.source', costColumn: 'daily_usage_summary.cost_usd' })}), 0) as cost_usd,
        COALESCE(SUM(daily_usage_summary.session_count), 0) as session_count
      FROM requested_users
      JOIN daily_usage_summary ON daily_usage_summary.user_id = requested_users.user_id
      GROUP BY requested_users.user_id
    )
    SELECT expected_totals.user_id as userId
    FROM expected_totals
    LEFT JOIN user_usage_totals ON user_usage_totals.user_id = expected_totals.user_id
    WHERE user_usage_totals.user_id IS NULL
      OR user_usage_totals.total_tokens <> expected_totals.total_tokens
      OR user_usage_totals.total_tokens_without_cache_read <> expected_totals.total_tokens_without_cache_read
      OR user_usage_totals.cost_usd <> expected_totals.cost_usd
      OR user_usage_totals.session_count <> expected_totals.session_count
  `
}

const refreshSummarySql = `
  INSERT INTO daily_usage_summary (
    user_id,
    usage_date,
    source,
    model,
    timezone,
    input_tokens,
    output_tokens,
    cache_creation_tokens,
    cache_read_tokens,
    total_tokens,
    total_tokens_without_cache_read,
    cost_usd,
    session_count,
    updated_at
  )
  WITH deduped_usage AS (
    SELECT daily_usage.*
    FROM daily_usage
    WHERE user_id = ?
      AND usage_date = ?
      AND source = ?
      AND model = ?
      AND (
        device_id <> 'legacy'
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
  )
  SELECT
    ?,
    ?,
    ?,
    ?,
    COALESCE(MAX(timezone), 'UTC'),
    COALESCE(SUM(input_tokens), 0),
    COALESCE(SUM(output_tokens), 0),
    COALESCE(SUM(cache_creation_tokens), 0),
    COALESCE(SUM(cache_read_tokens), 0),
    COALESCE(SUM(total_tokens), 0),
    COALESCE(SUM(total_tokens - cache_read_tokens), 0),
    COALESCE(SUM(${billableCostSql()}), 0),
    COALESCE(SUM(session_count), 0),
    -- Bound by the caller rather than strftime('now'): statements inside one D1 batch must
    -- carry the same stamp (the public-card freshness check compares summary.updated_at
    -- against totals.updated_at), and the batch loop keeps it monotonic across batches.
    ?
  FROM deduped_usage
  WHERE true
  ON CONFLICT(user_id, usage_date, source, model) DO UPDATE SET
    timezone = excluded.timezone,
    input_tokens = excluded.input_tokens,
    output_tokens = excluded.output_tokens,
    cache_creation_tokens = excluded.cache_creation_tokens,
    cache_read_tokens = excluded.cache_read_tokens,
    total_tokens = excluded.total_tokens,
    total_tokens_without_cache_read = excluded.total_tokens_without_cache_read,
    cost_usd = excluded.cost_usd,
    session_count = excluded.session_count,
    updated_at = excluded.updated_at
  -- W3: rewriting an unchanged row is wasted work twice over. D1 bills one index write per
  -- index column on every UPDATE, and — the larger cost — advancing updated_at changes the
  -- public-card cache key (profile.ts folds MAX(summary.updated_at) into it), so an identical
  -- re-upload invalidates a cached card for 300 seconds of nothing-new. IS NOT compares
  -- NULL-safely and treats 1 = 1.0, unlike the plain <> operator. A row whose stored columns are NULL (only
  -- reachable through a manual write) fails every comparison and is rewritten, which is the
  -- repair direction anyway.
  WHERE daily_usage_summary.timezone IS NOT excluded.timezone
    OR daily_usage_summary.input_tokens IS NOT excluded.input_tokens
    OR daily_usage_summary.output_tokens IS NOT excluded.output_tokens
    OR daily_usage_summary.cache_creation_tokens IS NOT excluded.cache_creation_tokens
    OR daily_usage_summary.cache_read_tokens IS NOT excluded.cache_read_tokens
    OR daily_usage_summary.total_tokens IS NOT excluded.total_tokens
    OR daily_usage_summary.total_tokens_without_cache_read IS NOT excluded.total_tokens_without_cache_read
    OR daily_usage_summary.cost_usd IS NOT excluded.cost_usd
    OR daily_usage_summary.session_count IS NOT excluded.session_count
`

const refreshUserTotalsFromSummarySql = `
  INSERT INTO user_usage_totals (
    user_id,
    total_tokens,
    total_tokens_without_cache_read,
    cost_usd,
    session_count,
    updated_at
  )
  WITH totals_refresh_allowed AS (
    SELECT 1 AS allowed
    FROM usage_summary_backfill_state
    WHERE id = '${usageSummaryBackfillStateId}'
      AND (
        phase = 'totals'
        OR completed_at IS NOT NULL
      )
  )
  SELECT
    ?,
    COALESCE(SUM(total_tokens), 0),
    COALESCE(SUM(total_tokens_without_cache_read), 0),
    COALESCE(SUM(${billableCostSql()}), 0),
    COALESCE(SUM(session_count), 0),
    ?
  FROM totals_refresh_allowed
  LEFT JOIN daily_usage_summary ON daily_usage_summary.user_id = ?
  GROUP BY totals_refresh_allowed.allowed
  ON CONFLICT(user_id) DO UPDATE SET
    total_tokens = excluded.total_tokens,
    total_tokens_without_cache_read = excluded.total_tokens_without_cache_read,
    cost_usd = excluded.cost_usd,
    session_count = excluded.session_count,
    updated_at = excluded.updated_at
  -- The same guard as the summary upsert, and for the same second reason: totals.updated_at
  -- is the other half of the public-card cache key (profile.ts reads it as usageUpdatedAt),
  -- and public/service/totals.ts compares summary.updated_at > totals.updated_at to decide
  -- whether to re-derive costs. If summary was written but totals kept an older stamp with
  -- identical values, every card read would take that re-derivation path. Skipping the write
  -- only when *both* are unchanged keeps the two stamps consistent: they move together in the
  -- same batch, so an unchanged batch advances neither.
  WHERE user_usage_totals.total_tokens IS NOT excluded.total_tokens
    OR user_usage_totals.total_tokens_without_cache_read IS NOT excluded.total_tokens_without_cache_read
    OR user_usage_totals.cost_usd IS NOT excluded.cost_usd
    OR user_usage_totals.session_count IS NOT excluded.session_count
`
