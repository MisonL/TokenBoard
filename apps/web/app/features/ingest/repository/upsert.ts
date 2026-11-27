import { listSummaryKeysNeedingRefresh, prepareSummaryRefresh, prepareUserTotalFromSummaryRefresh } from './refresh'
import { listUsersWithTotalRowsSql, prepareTotalsDelta, totalsDeltaChunkKeys } from './totals-delta'
import {
  createAggregateStamps,
  runStatementBatches,
  snapshotHash,
  statementChanged,
  uniqueSummaryKeys,
  uniqueUserIds,
  type IngestRecord
} from './types'

const snapshotUpsertBatchSize = 30

export async function upsertUsageSnapshots(db: D1Database, records: IngestRecord[]) {
  // One stamp sequence for the whole request: it keeps the cache key moving batch to batch
  // (within-millisecond batches get distinct values) while every statement inside one batch
  // shares its stamp, so no reader can see the summary and totals aggregates disagree on
  // freshness when their values agree.
  const stamps = createAggregateStamps()
  let upserted = 0
  for (let index = 0; index < records.length; index += snapshotUpsertBatchSize) {
    const batch = records.slice(index, index + snapshotUpsertBatchSize)
    upserted += await upsertUsageSnapshotBatch(db, batch, stamps)
  }

  return { upserted }
}

async function upsertUsageSnapshotBatch(
  db: D1Database,
  records: IngestRecord[],
  stamps: ReturnType<typeof createAggregateStamps>
) {
  if (records.length === 0) return 0
  const usageStatements = await Promise.all(records.map((record) => prepareUsageUpsert(db, record)))
  const results = await runStatementBatches(db, usageStatements)
  const changedRecords = records.filter((_, index) => statementChanged(results[index]))
  const unchangedRecords = records.filter((_, index) => !statementChanged(results[index]))
  // A key whose summary row is missing or stale must be refreshed even if this batch did not
  // change it — the summary is the read path, and this is the only repair that keeps it current
  // without the per-request totals reconciliation.
  const missingOrStaleSummaryKeys = await listSummaryKeysNeedingRefresh(db, unchangedRecords)
  const summaryKeysToRefresh = uniqueSummaryKeys([...changedRecords, ...missingOrStaleSummaryKeys])
  if (summaryKeysToRefresh.length === 0) return changedRecords.length

  const userIdsToRefresh = uniqueUserIds(summaryKeysToRefresh)
  const existingTotalUsers = await listUsersWithTotalRows(db, userIdsToRefresh)
  const stamp = stamps.next()

  // Ordering is part of the contract. D1 executes a batch sequentially inside one transaction,
  // so every difference UPDATE reads the stored summary row as it was *before* this batch's
  // upserts: each key's difference is (new raw aggregate − stored summary), and the summary
  // upserts that follow land the new value.
  const statements: D1PreparedStatement[] = []
  const deltaKeys = summaryKeysToRefresh.filter((key) => existingTotalUsers.has(key.userId))
  for (let index = 0; index < deltaKeys.length; index += totalsDeltaChunkKeys) {
    const chunk = deltaKeys.slice(index, index + totalsDeltaChunkKeys)
    statements.push(prepareTotalsDelta(db, chunk, stamp))
  }
  for (const key of summaryKeysToRefresh) statements.push(prepareSummaryRefresh(db, key, stamp))
  // A user with no totals row yet has nothing to add a difference to, so the full refresh runs
  // for them instead — last, so its SUM includes the values this batch just wrote. That is the
  // first-upload path and the self-heal's creation path, never the routine one.
  for (const userId of userIdsToRefresh) {
    if (!existingTotalUsers.has(userId)) statements.push(prepareUserTotalFromSummaryRefresh(db, userId, stamp))
  }

  await runStatementBatches(db, statements)
  return changedRecords.length
}

async function listUsersWithTotalRows(db: D1Database, userIds: string[]) {
  const withRows = new Set<string>()
  for (let index = 0; index < userIds.length; index += totalsDeltaChunkKeys) {
    const chunk = userIds.slice(index, index + totalsDeltaChunkKeys)
    const rows = await db
      .prepare(listUsersWithTotalRowsSql(chunk.length))
      .bind(...chunk)
      .all<{ userId: string }>()
    for (const row of rows.results ?? []) withRows.add(row.userId)
  }
  return withRows
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
    // token/cost CASE arms, and one in the WHERE clause.
    ...Array.from({ length: 7 }, () => correctionFlag)
  )
}

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

/**
 * A re-upload whose only difference is `costUsd` overwrites the stored cost.
 *
 * The snapshot hash covers `costUsd`, so a re-price IS a different snapshot by the protocol's
 * own definition, and the `snapshot_hash <> excluded.snapshot_hash` guard below lets that update
 * through. The cost column therefore has to follow the payload. Freezing it on the theory that
 * "identical token counts mean the old measurement" left the row describing a snapshot that was
 * never stored: `snapshot_hash` was still assigned `excluded.snapshot_hash`, so the stored hash
 * no longer matched the stored row, and anything that recomputes the hash from the row would
 * read it as never delivered.
 *
 * This is the accepted semantic of the native-client design (D7,
 * `docs/superpowers/specs/2026-11-03-native-usage-sources-design.md` §9.4.1): a cost-accounting
 * change reaches history through the client's next upload, and the diff is tracked in
 * `docs/research/2026-11-13-s5-migration-diff-ledger.md` rather than blocked here.
 *
 * Not every branch below keeps `snapshot_hash` equal to the stored row, and it is worth being
 * precise about that: `preserveCodexSessionOnlySql` deliberately keeps the stored tokens AND cost
 * while the statement still writes the incoming hash — that is its whole purpose (a token-less
 * session-only report must not wipe a row's usage), so a recomputation from the row would differ
 * there by design. The invariant this file guarantees is the narrower, checkable one: **for a row
 * whose tokens the statement replaced, the stored cost is the payload's cost** — which is what
 * `idempotency.sqlite.test.ts` asserts.
 */
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
