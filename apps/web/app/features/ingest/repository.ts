import { snapshotHashPayload, type UsageSnapshot, type UsageSnapshotKey } from '@tokenboard/usage-core'

export type IngestRecord = UsageSnapshot & {
  userId: string
  deviceId: string
}

export type ExistingSnapshotHash = UsageSnapshotKey & {
  snapshotHash: string
}

type UsageSummaryKey = Pick<IngestRecord, 'userId' | 'usageDate' | 'source' | 'model'>
type UsageSummaryBackfillEnv = {
  TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT?: string
}
type UsageSummaryBackfillPhase = 'summaries' | 'totals'
type UsageSummaryBackfillState = {
  phase: UsageSummaryBackfillPhase
  cursorUserId: string | null
  cursorUsageDate: string | null
  cursorSource: string | null
  cursorModel: string | null
  completedAt: string | null
}
type UsageSummaryBackfillRow = {
  phase: string | null
  cursorUserId: string | null
  cursorUsageDate: string | null
  cursorSource: string | null
  cursorModel: string | null
  completedAt: string | null
}

const d1MaxBoundParameters = 100
const d1MaxBatchStatements = 100
const snapshotHashKeyParameterCount = 3
const snapshotHashBaseParameterCount = 2
const summaryRefreshCheckParameterCount = 4
const usageSummaryBackfillStateId = 'initial'
const backfillLookahead = 1
const snapshotHashQueryChunkSize = Math.floor(
  (d1MaxBoundParameters - snapshotHashBaseParameterCount) / snapshotHashKeyParameterCount
)
const summaryRefreshCheckChunkSize = Math.floor(d1MaxBoundParameters / summaryRefreshCheckParameterCount)
const totalRefreshCheckChunkSize = d1MaxBoundParameters
const snapshotUpsertBatchSize = 30
export const defaultUsageSummaryBackfillLimit = 50
export const maxUsageSummaryBackfillLimit = 500

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
  const summaryKeysToRefresh = uniqueSummaryKeys([
    ...changedRecords,
    ...missingOrStaleSummaryKeys
  ])
  const knownSummaryRefreshUserIds = new Set(uniqueUserIds(summaryKeysToRefresh))
  const totalUserIdsToRefresh = [
    ...knownSummaryRefreshUserIds,
    ...await listUserIdsNeedingTotalRefresh(
      db,
      uniqueUserIds(unchangedRecords).filter((userId) => !knownSummaryRefreshUserIds.has(userId))
    )
  ]
  if (summaryKeysToRefresh.length > 0 || totalUserIdsToRefresh.length > 0) {
    await runStatementBatches(db, [
      ...summaryKeysToRefresh.map((key) => prepareSummaryRefresh(db, key)),
      ...totalUserIdsToRefresh.map((userId) => prepareUserTotalFromSummaryRefresh(db, userId))
    ])
  }
  return changedRecords.length
}

async function runStatementBatches(db: D1Database, statements: D1PreparedStatement[]) {
  const results: D1Result<unknown>[] = []
  for (let index = 0; index < statements.length; index += d1MaxBatchStatements) {
    const batchResults = await db.batch(statements.slice(index, index + d1MaxBatchStatements))
    assertBatchSucceeded(batchResults)
    results.push(...batchResults)
  }
  return results
}

function assertBatchSucceeded(results: D1Result<unknown>[]) {
  const batchResults = results as Array<{ success?: boolean; error?: string }>
  const failedIndex = batchResults.findIndex((result) => result.success === false)
  if (failedIndex < 0) return

  const error = batchResults[failedIndex]?.error
  throw new Error(
    `D1 batch statement ${failedIndex + 1} failed${error ? `: ${error}` : ''}`
  )
}

async function prepareUsageUpsert(db: D1Database, record: IngestRecord) {
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
    record.collectedAt
  )
}

function prepareSummaryRefresh(db: D1Database, key: UsageSummaryKey) {
  return db
    .prepare(refreshSummarySql)
    .bind(key.userId, key.usageDate, key.source, key.model, key.userId, key.usageDate, key.source, key.model)
}

function prepareUserTotalFromSummaryRefresh(db: D1Database, userId: string) {
  return db
    .prepare(refreshUserTotalsFromSummarySql)
    .bind(userId, userId)
}

function statementChanged(result: D1Result<unknown> | undefined) {
  if (result?.meta?.changes === undefined) return true
  const changes = Number(result.meta.changes)
  if (!Number.isFinite(changes)) return true
  return changes > 0
}

export async function backfillUsageSummaryCache(input: {
  db: D1Database
  limit: number
}) {
  const state = await readUsageSummaryBackfillState(input.db)
  if (state.completedAt) return { backfilled: 0, totalsRefreshed: 0 }
  if (state.phase === 'totals') {
    return refreshBackfillTotals(input, state.cursorUserId)
  }
  return refreshBackfillSummaries(input, state)
}

export function usageSummaryBackfillLimit(env: UsageSummaryBackfillEnv) {
  const raw = env.TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT
  if (raw === undefined) return defaultUsageSummaryBackfillLimit
  const value = raw.trim()
  if (!/^\d+$/.test(value)) throw invalidUsageSummaryBackfillLimitError()
  const limit = Number(value)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxUsageSummaryBackfillLimit) {
    throw invalidUsageSummaryBackfillLimitError()
  }
  return limit
}

async function refreshBackfillSummaries(
  input: {
    db: D1Database
    limit: number
  },
  state: UsageSummaryBackfillState
) {
  const keys = await listSummaryKeysForBackfill({
    db: input.db,
    limit: input.limit + backfillLookahead,
    state
  })
  const keysToRefresh = keys.slice(0, input.limit)
  await runStatementBatches(input.db, keysToRefresh.map((key) => prepareSummaryRefresh(input.db, key)))

  const hasMoreSummaries = keys.length > input.limit
  if (hasMoreSummaries) {
    await writeUsageSummaryBackfillState(input.db, summaryStateFromCursor(keysToRefresh.at(-1)))
    return { backfilled: keysToRefresh.length, totalsRefreshed: 0 }
  }

  await writeUsageSummaryBackfillState(input.db, totalsBackfillState(null))
  const totalsLimit = input.limit - keysToRefresh.length
  if (totalsLimit < 1) {
    return { backfilled: keysToRefresh.length, totalsRefreshed: 0 }
  }

  const totals = await refreshBackfillTotals(
    { db: input.db, limit: totalsLimit },
    null
  )
  return {
    backfilled: keysToRefresh.length,
    totalsRefreshed: totals.totalsRefreshed
  }
}

async function refreshBackfillTotals(
  input: {
    db: D1Database
    limit: number
  },
  cursorUserId: string | null
) {
  const userIds = await listUserIdsForTotalsBackfill({
    db: input.db,
    limit: input.limit + backfillLookahead,
    cursorUserId
  })
  const userIdsToRefresh = userIds.slice(0, input.limit)
  await runStatementBatches(
    input.db,
    userIdsToRefresh.map((userId) => prepareUserTotalFromSummaryRefresh(input.db, userId))
  )

  if (userIds.length > input.limit) {
    await writeUsageSummaryBackfillState(input.db, totalsBackfillState(userIdsToRefresh.at(-1) ?? null))
  } else {
    await writeUsageSummaryBackfillState(input.db, completedBackfillState())
  }

  return { backfilled: 0, totalsRefreshed: userIdsToRefresh.length }
}

async function listSummaryKeysForBackfill(input: {
  db: D1Database
  limit: number
  state: UsageSummaryBackfillState
}) {
  const cursor = summaryBackfillCursor(input.state)
  const statement = cursor
    ? input.db.prepare(summaryBackfillCursorSql).bind(...cursor, input.limit)
    : input.db.prepare(summaryBackfillInitialSql).bind(input.limit)
  const rows = await statement.all<UsageSummaryKey>()

  return rows.results ?? []
}

async function listUserIdsForTotalsBackfill(input: {
  db: D1Database
  limit: number
  cursorUserId: string | null
}) {
  const statement = input.cursorUserId
    ? input.db.prepare(totalsBackfillCursorSql).bind(input.cursorUserId, input.limit)
    : input.db.prepare(totalsBackfillInitialSql).bind(input.limit)
  const rows = await statement.all<{ userId: string }>()

  return (rows.results ?? []).map((row) => row.userId)
}

async function listSummaryKeysNeedingRefresh(
  db: D1Database,
  records: UsageSummaryKey[]
) {
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

async function listUserIdsNeedingTotalRefresh(
  db: D1Database,
  userIds: string[]
) {
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

async function readUsageSummaryBackfillState(db: D1Database): Promise<UsageSummaryBackfillState> {
  const row = await db
    .prepare(
      `
        SELECT
          phase,
          cursor_user_id as cursorUserId,
          cursor_usage_date as cursorUsageDate,
          cursor_source as cursorSource,
          cursor_model as cursorModel,
          completed_at as completedAt
        FROM usage_summary_backfill_state
        WHERE id = ?
      `
    )
    .bind(usageSummaryBackfillStateId)
    .first<UsageSummaryBackfillRow>()

  return normalizeBackfillState(row)
}

async function writeUsageSummaryBackfillState(
  db: D1Database,
  state: UsageSummaryBackfillState
) {
  await db
    .prepare(
      `
        INSERT INTO usage_summary_backfill_state (
          id,
          phase,
          cursor_user_id,
          cursor_usage_date,
          cursor_source,
          cursor_model,
          completed_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        ON CONFLICT(id) DO UPDATE SET
          phase = excluded.phase,
          cursor_user_id = excluded.cursor_user_id,
          cursor_usage_date = excluded.cursor_usage_date,
          cursor_source = excluded.cursor_source,
          cursor_model = excluded.cursor_model,
          completed_at = excluded.completed_at,
          updated_at = excluded.updated_at
      `
    )
    .bind(
      usageSummaryBackfillStateId,
      state.phase,
      state.cursorUserId,
      state.cursorUsageDate,
      state.cursorSource,
      state.cursorModel,
      state.completedAt
    )
    .run()
}

function normalizeBackfillState(
  row: UsageSummaryBackfillRow | null
): UsageSummaryBackfillState {
  if (!row) return summariesBackfillState(null)
  const phase = row.phase === 'totals' ? 'totals' : 'summaries'
  return {
    phase,
    cursorUserId: row.cursorUserId ?? null,
    cursorUsageDate: row.cursorUsageDate ?? null,
    cursorSource: row.cursorSource ?? null,
    cursorModel: row.cursorModel ?? null,
    completedAt: row.completedAt ?? null
  }
}

function summaryStateFromCursor(
  cursor: UsageSummaryKey | undefined
): UsageSummaryBackfillState {
  if (!cursor) return summariesBackfillState(null)
  return summariesBackfillState(cursor)
}

function summariesBackfillState(
  cursor: UsageSummaryKey | null
): UsageSummaryBackfillState {
  return {
    phase: 'summaries',
    cursorUserId: cursor?.userId ?? null,
    cursorUsageDate: cursor?.usageDate ?? null,
    cursorSource: cursor?.source ?? null,
    cursorModel: cursor?.model ?? null,
    completedAt: null
  }
}

function totalsBackfillState(cursorUserId: string | null): UsageSummaryBackfillState {
  return {
    phase: 'totals',
    cursorUserId,
    cursorUsageDate: null,
    cursorSource: null,
    cursorModel: null,
    completedAt: null
  }
}

function completedBackfillState(): UsageSummaryBackfillState {
  return {
    phase: 'totals',
    cursorUserId: null,
    cursorUsageDate: null,
    cursorSource: null,
    cursorModel: null,
    completedAt: new Date().toISOString()
  }
}

function summaryBackfillCursor(state: UsageSummaryBackfillState) {
  const values = [state.cursorUserId, state.cursorUsageDate, state.cursorSource, state.cursorModel]
  const hasCursor = values.some((value) => value !== null && value !== undefined)
  if (!hasCursor) return null
  if (values.some((value) => value === null || value === undefined || value === '')) {
    throw new Error('Usage summary backfill cursor is incomplete')
  }
  return [state.cursorUserId, state.cursorUsageDate, state.cursorSource, state.cursorModel] as const
}

const summaryBackfillSelectSql = `
  SELECT
    user_id as userId,
    usage_date as usageDate,
    source,
    model
  FROM daily_usage
`

const summaryBackfillOrderSql = `
  GROUP BY user_id, usage_date, source, model
  ORDER BY user_id ASC, usage_date ASC, source ASC, model ASC
  LIMIT ?
`

const summaryBackfillInitialSql = `
  ${summaryBackfillSelectSql}
  ${summaryBackfillOrderSql}
`

const summaryBackfillCursorSql = `
  ${summaryBackfillSelectSql}
  WHERE (user_id, usage_date, source, model) > (?, ?, ?, ?)
  ${summaryBackfillOrderSql}
`

const totalsBackfillSelectSql = `
  SELECT user_id as userId
  FROM daily_usage_summary
`

const totalsBackfillOrderSql = `
  GROUP BY user_id
  ORDER BY user_id ASC
  LIMIT ?
`

const totalsBackfillInitialSql = `
  ${totalsBackfillSelectSql}
  ${totalsBackfillOrderSql}
`

const totalsBackfillCursorSql = `
  ${totalsBackfillSelectSql}
  WHERE user_id > ?
  ${totalsBackfillOrderSql}
`

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
        COALESCE(SUM(daily_usage.cost_usd), 0) as cost_usd,
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
        COALESCE(SUM(daily_usage_summary.cost_usd), 0) as cost_usd,
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
    input_tokens = excluded.input_tokens,
    output_tokens = excluded.output_tokens,
    cache_creation_tokens = excluded.cache_creation_tokens,
    cache_read_tokens = excluded.cache_read_tokens,
    total_tokens = excluded.total_tokens,
    cost_usd = excluded.cost_usd,
    session_count = excluded.session_count,
    snapshot_hash = excluded.snapshot_hash,
    synced_at = excluded.synced_at
  WHERE daily_usage.snapshot_hash IS NULL
    OR daily_usage.snapshot_hash <> excluded.snapshot_hash
`

async function snapshotHash(snapshot: UsageSnapshot) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(snapshotHashPayload(snapshot))
  )
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export async function findExistingSnapshotHashes(
  db: D1Database,
  input: {
    userId: string
    deviceId: string
    keys: UsageSnapshotKey[]
  }
): Promise<ExistingSnapshotHash[]> {
  if (input.keys.length === 0) {
    return []
  }

  const existing: ExistingSnapshotHash[] = []
  for (let index = 0; index < input.keys.length; index += snapshotHashQueryChunkSize) {
    const keys = input.keys.slice(index, index + snapshotHashQueryChunkSize)
    const predicates = keys.map(() => '(source = ? AND usage_date = ? AND model = ?)').join(' OR ')
    const bindings = keys.flatMap((key) => [key.source, key.usageDate, key.model])
    const rows = await db
      .prepare(
        `
          SELECT
            source,
            usage_date as usageDate,
            model,
            snapshot_hash as snapshotHash
          FROM daily_usage
          WHERE user_id = ?
            AND device_id = ?
            AND snapshot_hash IS NOT NULL
            AND (${predicates})
        `
      )
      .bind(input.userId, input.deviceId, ...bindings)
      .all<ExistingSnapshotHash>()

    existing.push(...(rows.results ?? []))
  }

  return filterExistingHashesWithCurrentCaches(db, input.userId, existing)
}

async function filterExistingHashesWithCurrentCaches(
  db: D1Database,
  userId: string,
  rows: ExistingSnapshotHash[]
) {
  if (rows.length === 0) return []
  const staleSummaryKeys = await listSummaryKeysNeedingRefresh(
    db,
    rows.map((row) => ({
      userId,
      usageDate: row.usageDate,
      source: row.source,
      model: row.model
    }))
  )
  const staleKeyIds = new Set(staleSummaryKeys.map(summaryKeyId))
  const staleTotalUserIds = new Set(await listUserIdsNeedingTotalRefresh(db, [userId]))
  if (staleTotalUserIds.has(userId)) return []
  return rows.filter((row) => !staleKeyIds.has(summaryKeyId({ userId, ...row })))
}

export async function markIngestSynced(
  db: D1Database,
  input: {
    uploadTokenHash: string
    deviceId: string | null
    syncedAt: string
  }
) {
  await db
    .prepare('UPDATE upload_tokens SET last_used_at = ? WHERE token_hash = ?')
    .bind(input.syncedAt, input.uploadTokenHash)
    .run()

  if (input.deviceId) {
    await db
      .prepare('UPDATE devices SET last_synced_at = ?, updated_at = ? WHERE id = ?')
      .bind(input.syncedAt, input.syncedAt, input.deviceId)
      .run()
  }
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
    COALESCE(SUM(cost_usd), 0),
    COALESCE(SUM(session_count), 0),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
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
    COALESCE(SUM(cost_usd), 0),
    COALESCE(SUM(session_count), 0),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM totals_refresh_allowed
  LEFT JOIN daily_usage_summary ON daily_usage_summary.user_id = ?
  GROUP BY totals_refresh_allowed.allowed
  ON CONFLICT(user_id) DO UPDATE SET
    total_tokens = excluded.total_tokens,
    total_tokens_without_cache_read = excluded.total_tokens_without_cache_read,
    cost_usd = excluded.cost_usd,
    session_count = excluded.session_count,
    updated_at = excluded.updated_at
`

function uniqueSummaryKeys(records: UsageSummaryKey[]) {
  const keys = new Map<string, UsageSummaryKey>()
  for (const record of records) {
    const key = summaryKeyId(record)
    if (!keys.has(key)) {
      keys.set(key, {
        userId: record.userId,
        usageDate: record.usageDate,
        source: record.source,
        model: record.model
      })
    }
  }
  return [...keys.values()]
}

function summaryKeyId(key: UsageSummaryKey) {
  return `${key.userId}\0${key.usageDate}\0${key.source}\0${key.model}`
}

function uniqueUserIds(records: Array<Pick<IngestRecord, 'userId'>>) {
  return [...new Set(records.map((record) => record.userId))]
}

function invalidUsageSummaryBackfillLimitError() {
  return new Error(
    `TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT must be an integer from 1 to ${maxUsageSummaryBackfillLimit}`
  )
}
