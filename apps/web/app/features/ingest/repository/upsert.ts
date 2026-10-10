import {
  listSummaryKeysNeedingRefresh,
  listUserIdsNeedingTotalRefresh,
  prepareSummaryRefresh,
  prepareUserTotalFromSummaryRefresh
} from './refresh'
import {
  runStatementBatches,
  snapshotHash,
  statementChanged,
  uniqueSummaryKeys,
  uniqueUserIds,
  type IngestRecord
} from './types'

const snapshotUpsertBatchSize = 30

export async function upsertUsageSnapshots(db: D1Database, records: IngestRecord[]) {
  let upserted = 0
  for (let index = 0; index < records.length; index += snapshotUpsertBatchSize) {
    const batch = records.slice(index, index + snapshotUpsertBatchSize)
    upserted += await upsertUsageSnapshotBatch(db, batch)
  }

  return { upserted }
}

async function upsertUsageSnapshotBatch(db: D1Database, records: IngestRecord[]) {
  if (records.length === 0) return 0
  const usageStatements = await Promise.all(records.map((record) => prepareUsageUpsert(db, record)))
  const results = await runStatementBatches(db, usageStatements)
  const changedRecords = records.filter((_, index) => statementChanged(results[index]))
  const unchangedRecords = records.filter((_, index) => !statementChanged(results[index]))
  const missingOrStaleSummaryKeys = await listSummaryKeysNeedingRefresh(db, unchangedRecords)
  const summaryKeysToRefresh = uniqueSummaryKeys([...changedRecords, ...missingOrStaleSummaryKeys])
  const knownSummaryRefreshUserIds = new Set(uniqueUserIds(summaryKeysToRefresh))
  const totalUserIdsToRefresh = [
    ...knownSummaryRefreshUserIds,
    ...(await listUserIdsNeedingTotalRefresh(
      db,
      uniqueUserIds(unchangedRecords).filter((userId) => !knownSummaryRefreshUserIds.has(userId))
    ))
  ]
  if (summaryKeysToRefresh.length > 0 || totalUserIdsToRefresh.length > 0) {
    await runStatementBatches(db, [
      ...summaryKeysToRefresh.map((key) => prepareSummaryRefresh(db, key)),
      ...totalUserIdsToRefresh.map((userId) => prepareUserTotalFromSummaryRefresh(db, userId))
    ])
  }
  return changedRecords.length
}

async function prepareUsageUpsert(db: D1Database, record: IngestRecord) {
  const correctionFlag = record.correction ? 1 : 0
  return db.prepare(upsertUsageSql).bind(
    record.userId,
    record.deviceId,
    record.source,
    record.usageDate,
    record.timezone,
    record.model,
    record.inputTokens,
    record.outputTokens,
    record.cacheCreationTokens,
    record.cacheReadTokens,
    record.totalTokens,
    record.costUsd,
    record.sessionCount,
    await snapshotHash(record),
    // This column is the last-writer-wins freshness marker for the snapshot;
    // server receipt time is tracked separately by the device heartbeat rows.
    record.collectedAt,
    // One correction-flag bind per `?` that guards a correction exemption: six in the
    // token/cost CASE arms, one in the cost CASE's unchanged-measurement arm, one in the
    // WHERE clause.
    ...Array.from({ length: 8 }, () => correctionFlag)
  )
}

/**
 * True when the stored row and the incoming snapshot measured the same tokens.
 *
 * Cost is a function of the price catalogue *at the moment of measurement*, not of the
 * catalogue now, so a re-scan that finds identical token counts is not a new measurement —
 * it is the old one re-derived. Adopting its cost would silently rewrite already-reported
 * spend whenever models.dev adjusts a price, with nothing in the data to show it happened.
 * A real re-measurement (more turns, a different model) changes the counts and takes the
 * incoming cost with it.
 *
 * Callers must pair this with `? = 0` (see the cost CASE): a correction row's tokens are
 * structurally always zero, so the comparison is trivially true for it on every re-derive.
 * Its cost is a derived remainder that moves when the day grows, and freezing it would
 * strand the row on its first correction.
 */
const unchangedTokenMeasurementSql = `
  daily_usage.input_tokens = excluded.input_tokens
  AND daily_usage.output_tokens = excluded.output_tokens
  AND daily_usage.cache_creation_tokens = excluded.cache_creation_tokens
  AND daily_usage.cache_read_tokens = excluded.cache_read_tokens
  AND daily_usage.total_tokens = excluded.total_tokens
`

const preserveCodexSessionOnlySql = `
  ? = 0
  AND excluded.source = 'codex'
  AND excluded.input_tokens = 0
  AND excluded.output_tokens = 0
  AND excluded.cache_creation_tokens = 0
  AND excluded.cache_read_tokens = 0
  AND excluded.total_tokens = 0
  AND excluded.session_count > 0
  AND (
    daily_usage.input_tokens > 0
    OR daily_usage.output_tokens > 0
    OR daily_usage.cache_creation_tokens > 0
    OR daily_usage.cache_read_tokens > 0
    OR daily_usage.total_tokens > 0
    OR daily_usage.cost_usd > 0
  )
`

const upsertUsageSql = `
  INSERT INTO daily_usage (
    user_id,
    device_id,
    source,
    usage_date,
    timezone,
    model,
    input_tokens,
    output_tokens,
    cache_creation_tokens,
    cache_read_tokens,
    total_tokens,
    cost_usd,
    session_count,
    snapshot_hash,
    synced_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id, device_id, source, usage_date, model) DO UPDATE SET
    timezone = excluded.timezone,
    input_tokens = CASE WHEN ${preserveCodexSessionOnlySql} THEN daily_usage.input_tokens ELSE excluded.input_tokens END,
    output_tokens = CASE WHEN ${preserveCodexSessionOnlySql} THEN daily_usage.output_tokens ELSE excluded.output_tokens END,
    cache_creation_tokens = CASE WHEN ${preserveCodexSessionOnlySql} THEN daily_usage.cache_creation_tokens ELSE excluded.cache_creation_tokens END,
    cache_read_tokens = CASE WHEN ${preserveCodexSessionOnlySql} THEN daily_usage.cache_read_tokens ELSE excluded.cache_read_tokens END,
    total_tokens = CASE WHEN ${preserveCodexSessionOnlySql} THEN daily_usage.total_tokens ELSE excluded.total_tokens END,
    cost_usd = CASE
      WHEN ${preserveCodexSessionOnlySql} THEN daily_usage.cost_usd
      WHEN ? = 0 AND ${unchangedTokenMeasurementSql} THEN daily_usage.cost_usd
      ELSE excluded.cost_usd
    END,
    session_count = excluded.session_count,
    snapshot_hash = excluded.snapshot_hash,
    synced_at = excluded.synced_at
  WHERE (
    daily_usage.snapshot_hash IS NULL
    OR daily_usage.snapshot_hash <> excluded.snapshot_hash
  )
  AND NOT (
    ? = 0
    AND
    excluded.source = 'codex'
    AND excluded.input_tokens = 0
    AND excluded.output_tokens = 0
    AND excluded.cache_creation_tokens = 0
    AND excluded.cache_read_tokens = 0
    AND excluded.total_tokens = 0
    AND excluded.session_count = 0
    AND (
      daily_usage.input_tokens > 0
      OR daily_usage.output_tokens > 0
      OR daily_usage.cache_creation_tokens > 0
      OR daily_usage.cache_read_tokens > 0
      OR daily_usage.total_tokens > 0
      OR daily_usage.cost_usd > 0
    )
  )
  AND (
    julianday(daily_usage.synced_at) IS NULL
    OR julianday(excluded.synced_at) >= julianday(daily_usage.synced_at)
  )
`
