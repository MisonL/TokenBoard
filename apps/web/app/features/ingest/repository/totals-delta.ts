import { usageSummaryBackfillStateId, type UsageSummaryKey } from './types'
import { billableCostSql } from '../../../lib/usage-cost'

// Incremental totals maintenance (batch B2/B4).
//
// The old path re-derived each user's totals from a full summary scan on every ingest batch, and
// on the unchanged-retry path scanned the whole summary table per user to *decide* whether a
// refresh was needed — that is what made totals ~55% of the daily D1 row reads. The user totals
// invariant is `user_usage_totals == SUM(daily_usage_summary)`, so a batch that refreshes a
// known set of summary keys can instead move the totals by exactly the difference each refreshed
// key's value changes by: read the new aggregate and the stored summary row, add the difference
// to the totals row, and write the summary row — all inside one D1 batch (single transaction,
// sequential), so no concurrent upload can be observed half-applied.
//
// The invariant this depends on, and the reason drift can only be fixed out of band: a
// difference is correct only if the stored totals agreed with the stored summaries before the
// batch. Nothing here notices a summary row deleted behind the client's back; the daily self-heal
// pass (selfheal.ts) is the repair channel for that class, and removing the per-request
// reconciliations without it online would make such drift permanent.

// Keys per difference statement: 4 binds per key + one shared timestamp, far under the 100-bind
// D1 ceiling (15 x 4 + 1 = 61). The ingest batch size (30 records) then needs at most 2
// difference statements + 30 summary upserts + a few creation refreshes — inside the 100-
// statement batch limit, which matters because runStatementBatches splits above 100 into
// *separate transactions*: a key's difference and its summary upsert must never straddle one of
// those split points, or a crash between them leaves the totals and the summary disagreeing.
export const totalsDeltaChunkKeys = 15

const deltaColumns: Array<{ column: string; new: (alias: string) => string; stored: string }> = [
  {
    column: 'total_tokens',
    new: (alias) => `SUM(${alias}.total_tokens)`,
    stored: 'total_tokens'
  },
  {
    column: 'total_tokens_without_cache_read',
    new: (alias) => `SUM(${alias}.total_tokens - ${alias}.cache_read_tokens)`,
    stored: 'total_tokens_without_cache_read'
  },
  {
    column: 'cost_usd',
    new: (alias) => `SUM(${billableCostSql({ sourceColumn: `${alias}.source`, costColumn: `${alias}.cost_usd` })})`,
    stored: 'cost_usd'
  },
  {
    column: 'session_count',
    new: (alias) => `SUM(${alias}.session_count)`,
    stored: 'session_count'
  }
]

// Must mirror refreshSummarySql exactly — this is the "new value" of the same aggregate the
// paired summary upsert writes. If the two ever disagree, the difference moves the totals by a
// value the summary never had.
function newAggregateSql(alias: string, column: (alias: string) => string) {
  return `
    COALESCE((
      SELECT ${column(alias)}
      FROM daily_usage AS ${alias}
      WHERE ${alias}.user_id = newkeys.user_id
        AND ${alias}.usage_date = newkeys.usage_date
        AND ${alias}.source = newkeys.source
        AND ${alias}.model = newkeys.model
        AND (
          ${alias}.device_id <> 'legacy'
          OR NOT EXISTS (
            SELECT 1
            FROM daily_usage AS current_usage
            WHERE current_usage.user_id = ${alias}.user_id
              AND current_usage.usage_date = ${alias}.usage_date
              AND current_usage.source = ${alias}.source
              AND current_usage.model = ${alias}.model
              AND current_usage.device_id <> 'legacy'
          )
        )
    ), 0)`
}

function storedSummarySql(column: string) {
  return `
    COALESCE((
      SELECT daily_usage_summary.${column}
      FROM daily_usage_summary
      WHERE daily_usage_summary.user_id = newkeys.user_id
        AND daily_usage_summary.usage_date = newkeys.usage_date
        AND daily_usage_summary.source = newkeys.source
        AND daily_usage_summary.model = newkeys.model
    ), 0)`
}

// The difference one refreshed key moves the totals by.
//
// A key whose summary row does not exist contributes its full aggregate, not zero: the totals is
// a sum over existing summary rows, so a key the summary pass never reached is missing from the
// totals and this batch's upsert is what brings it in. The accepted cost of that direction is the
// fault case — a summary row deleted behind the client's back while the totals kept counting it
// gets added a second time here (the probe reproduced 125 → 250), and the daily self-heal pass
// re-derives it. The plan (docs/research/2026-11-25-optimization-final-plan.md §B6) chose this
// split deliberately: the routine first-summarize path must be correct online, the delete-after-
// count path is healed within a heal round.
function differenceSql(alias: string, column: (alias: string) => string, stored: string) {
  return `${newAggregateSql(alias, column)} - ${storedSummarySql(stored)}`
}

export function totalsDeltaSql(keyCount: number) {
  const rows = Array.from({ length: keyCount }, () => '(?, ?, ?, ?)').join(',\n      ')
  const deltaSelects = deltaColumns
    .map((column) => `${differenceSql('new_usage', column.new, column.stored)} AS d_${column.column}`)
    .join(',\n      ')
  const setArms = deltaColumns
    .map(
      (column) => `    ${column.column} = ${column.column} + COALESCE((
      SELECT SUM(deltas.d_${column.column})
      FROM deltas
      WHERE deltas.user_id = user_usage_totals.user_id
    ), 0),`
    )
    .join('\n')
  return `
    WITH newkeys(user_id, usage_date, source, model) AS (
      VALUES
      ${rows}
    ),
    totals_refresh_allowed AS (
      SELECT 1 AS allowed
      FROM usage_summary_backfill_state
      WHERE id = '${usageSummaryBackfillStateId}'
        AND (
          phase = 'totals'
          OR completed_at IS NOT NULL
        )
    ),
    deltas AS (
      SELECT newkeys.user_id AS user_id,
      ${deltaSelects}
      FROM newkeys
    )
    UPDATE user_usage_totals SET
${setArms}
      -- The batch timestamp, shared with this batch's summary upserts: the public-card path
      -- must never observe a summary stamp newer than the totals stamp for values that agree.
      updated_at = ?
    WHERE EXISTS (SELECT 1 FROM totals_refresh_allowed)
      -- Re-check the gate inside the derived transaction, not just at request start: the initial
      -- backfill can reach its totals phase between the probe and this statement, and a totals
      -- row written before the summaries are complete would claim a partial history.
      AND user_usage_totals.user_id IN (SELECT user_id FROM deltas)
  `
}

export function prepareTotalsDelta(db: D1Database, keys: UsageSummaryKey[], updatedAt: string) {
  return db
    .prepare(totalsDeltaSql(keys.length))
    .bind(...keys.flatMap((key) => [key.userId, key.usageDate, key.source, key.model]), updatedAt)
}

// Rows for users whose totals row does not exist yet (the request-start probe found nothing):
// an UPDATE has nothing to add to. Those users take the existing full refresh — once per batch,
// after the batch's summary upserts so the SUM sees this batch's values — which is also the
// creation path. A user with neither summaries nor a totals row gains nothing from it, and the
// refresh statement's own backfill gate keeps it silent while the initial backfill runs.
export function listUsersWithTotalRowsSql(userCount: number) {
  const placeholders = Array.from({ length: userCount }, () => '?').join(', ')
  return `
    SELECT user_id AS userId
    FROM user_usage_totals
    WHERE user_id IN (${placeholders})
  `
}
