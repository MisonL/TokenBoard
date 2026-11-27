import { billableCostSql } from '../../../lib/usage-cost'

// SQL for the daily aggregate self-heal pass (batch B6).
//
// The incremental totals path keeps `user_usage_totals` in step with the summary rows it sees,
// but a difference is only correct relative to what both sides held when it was computed: a
// summary row deleted behind the client's back leaves the totals over-counting forever. The
// probe in docs/research/2026-11-25-d1-write-probe/delta-correctness-probe.mjs reproduced
// exactly that (125 → 250 after a delete followed by a re-upload). This pass is the only channel
// that detects and repairs that class of drift, and it has to be online before the per-request
// full reconciliations are removed.
//
// Three sweeps, each cursor-bounded so one scheduled tick does a bounded amount of work:
//   1. summaries — every (user, date, source, model) key in daily_usage whose stored summary
//      row disagrees with the raw rows (missing or wrong);
//   2. orphans — summary rows with no daily_usage row behind them (deleted raw usage), removed;
//  3. totals — every user that has a summary row *or* a totals row, with the totals re-derived
//      when it disagrees. Enumerating the union is what catches a totals row that outlived its
//      last summary row, which a summary-keyed sweep cannot see.

export const selfHealStateId = 'selfheal'

export const selfHealSummaryKeysInitialSql = `
  SELECT
    user_id as userId,
    usage_date as usageDate,
    source,
    model
  FROM daily_usage
  GROUP BY user_id, usage_date, source, model
  ORDER BY user_id ASC, usage_date ASC, source ASC, model ASC
  LIMIT ?
`

export const selfHealSummaryKeysCursorSql = `
  SELECT
    user_id as userId,
    usage_date as usageDate,
    source,
    model
  FROM daily_usage
  WHERE (user_id, usage_date, source, model) > (?, ?, ?, ?)
  GROUP BY user_id, usage_date, source, model
  ORDER BY user_id ASC, usage_date ASC, source ASC, model ASC
  LIMIT ?
`

// A summary row whose raw device rows are all gone. The expected aggregate for such a key is
// zero, which refreshSummarySql would write back as a live zero row — so orphans are deleted
// instead, and the totals sweep afterwards re-derives the user's totals without them.
export const selfHealOrphanSummaryRowsSql = `
  SELECT
    daily_usage_summary.user_id as userId,
    daily_usage_summary.usage_date as usageDate,
    daily_usage_summary.source as source,
    daily_usage_summary.model as model
  FROM daily_usage_summary
  WHERE (daily_usage_summary.user_id, daily_usage_summary.usage_date, daily_usage_summary.source,
         daily_usage_summary.model) > (?, ?, ?, ?)
    AND NOT EXISTS (
      SELECT 1
      FROM daily_usage
      WHERE daily_usage.user_id = daily_usage_summary.user_id
        AND daily_usage.usage_date = daily_usage_summary.usage_date
        AND daily_usage.source = daily_usage_summary.source
        AND daily_usage.model = daily_usage_summary.model
    )
  ORDER BY daily_usage_summary.user_id ASC, daily_usage_summary.usage_date ASC,
           daily_usage_summary.source ASC, daily_usage_summary.model ASC
  LIMIT ?
`

export const deleteOrphanSummaryRowSql = `
  DELETE FROM daily_usage_summary
  WHERE user_id = ? AND usage_date = ? AND source = ? AND model = ?
`

// The candidate user space is summaries ∪ totals. A user whose last summary row was just deleted
// by the orphan sweep still has a totals row, and only this union makes that user visible. Each
// branch is capped at the same limit because only the first `limit` users of the merged, ordered
// stream can be taken.
export function selfHealCandidateUsersSql(withCursor: boolean) {
  const summaryFilter = withCursor ? 'WHERE user_id > ?' : ''
  const totalsFilter = withCursor ? 'WHERE user_id > ?' : ''
  // SQLite rejects ORDER BY inside a UNION branch, so each capped branch is its own subquery.
  // The per-branch cap must equal the outer limit: after the union dedupes and re-sorts, only
  // the first `limit` users can be taken, and each branch alone could supply all of them.
  return `
    SELECT user_id AS userId
    FROM (
      SELECT user_id FROM (
        SELECT user_id FROM daily_usage_summary ${summaryFilter} ORDER BY user_id ASC LIMIT ?
      )
      UNION ALL
      SELECT user_id FROM (
        SELECT user_id FROM user_usage_totals ${totalsFilter} ORDER BY user_id ASC LIMIT ?
      )
    )
    GROUP BY user_id
    ORDER BY user_id ASC
    LIMIT ?
  `
}

// Expected-vs-stored totals for the candidate users. The expected cost is the *billable* sum,
// matching what refreshUserTotalsFromSummarySql writes: a user holding an antigravity-family
// summary row must not be flagged as drifted simply because the raw cost is nonzero.
//
// `totals_refresh_allowed` gates the check the same way the writer does: while the initial
// backfill has not reached the totals phase there is nothing to repair, and treating a not-yet
// -written row as drift would race the backfill.
export function totalRepairCheckSql(userCount: number) {
  const placeholders = Array.from({ length: userCount }, () => '(?)').join(', ')
  return `
    WITH requested_users(user_id) AS (VALUES ${placeholders}),
    totals_refresh_allowed AS (
      SELECT 1 AS allowed
      FROM usage_summary_backfill_state
      WHERE id = 'initial'
        AND (
          phase = 'totals'
          OR completed_at IS NOT NULL
        )
    ),
    expected_totals AS (
      SELECT
        requested_users.user_id,
        COALESCE(SUM(daily_usage_summary.total_tokens), 0) AS total_tokens,
        COALESCE(SUM(daily_usage_summary.total_tokens_without_cache_read), 0) AS without_cache_read,
        COALESCE(SUM(${billableCostSql({
          sourceColumn: 'daily_usage_summary.source',
          costColumn: 'daily_usage_summary.cost_usd'
        })}), 0) AS cost_usd,
        COALESCE(SUM(daily_usage_summary.session_count), 0) AS session_count
      FROM requested_users
      JOIN totals_refresh_allowed
      LEFT JOIN daily_usage_summary ON daily_usage_summary.user_id = requested_users.user_id
      GROUP BY requested_users.user_id
    )
    SELECT requested_users.user_id AS userId
    FROM requested_users
    JOIN totals_refresh_allowed
    LEFT JOIN expected_totals ON expected_totals.user_id = requested_users.user_id
    LEFT JOIN user_usage_totals ON user_usage_totals.user_id = requested_users.user_id
    WHERE (
          -- A totals row that outlived its summaries (or was tampered with) is drift even when
          -- the expected values are zero; the refresh writer re-derives the row to zeros.
          (user_usage_totals.user_id IS NOT NULL
            AND (
              user_usage_totals.total_tokens <> expected_totals.total_tokens
              OR user_usage_totals.total_tokens_without_cache_read <> expected_totals.without_cache_read
              OR user_usage_totals.cost_usd <> expected_totals.cost_usd
              OR user_usage_totals.session_count <> expected_totals.session_count
            ))
          -- A user with summaries but no totals row is the other half of the gap the incremental
          -- path cannot close by itself. A user with neither stays row-less: creating an
          -- all-zero placeholder is forbidden (it would satisfy future deltas against a row that
          -- never described real data).
          OR (user_usage_totals.user_id IS NULL AND expected_totals.total_tokens > 0)
        )
`
}
