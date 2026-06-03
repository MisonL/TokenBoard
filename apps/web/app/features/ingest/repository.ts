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
const usageSummaryBackfillStateId = 'initial'
const backfillLookahead = 1
const snapshotHashQueryChunkSize = Math.floor(
  (d1MaxBoundParameters - snapshotHashBaseParameterCount) / snapshotHashKeyParameterCount
)
const snapshotUpsertBatchSize = 30
export const defaultUsageSummaryBackfillLimit = 50
export const maxUsageSummaryBackfillLimit = 500

export async function upsertUsageSnapshots(db: D1Database, records: IngestRecord[]) {
  for (let index = 0; index < records.length; index += snapshotUpsertBatchSize) {
    const batch = records.slice(index, index + snapshotUpsertBatchSize)
    await upsertUsageSnapshotBatch(db, batch)
  }

  return { upserted: records.length }
}

async function upsertUsageSnapshotBatch(db: D1Database, records: IngestRecord[]) {
  if (records.length === 0) return
  const statements = await Promise.all([
    ...records.map((record) => prepareUsageUpsert(db, record)),
    ...prepareSummaryRefreshes(db, records),
    ...prepareUserTotalRefreshes(db, records)
  ])
  await runStatementBatches(db, statements)
}

async function runStatementBatches(db: D1Database, statements: D1PreparedStatement[]) {
  for (let index = 0; index < statements.length; index += d1MaxBatchStatements) {
    const results = await db.batch(statements.slice(index, index + d1MaxBatchStatements))
    assertBatchSucceeded(results)
  }
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

function prepareSummaryRefreshes(db: D1Database, records: IngestRecord[]) {
  return uniqueSummaryKeys(records).map((key) => prepareSummaryRefresh(db, key))
}

function prepareSummaryRefresh(db: D1Database, key: UsageSummaryKey) {
  return db
    .prepare(refreshSummarySql)
    .bind(key.userId, key.usageDate, key.source, key.model, key.userId, key.usageDate, key.source, key.model)
}

function prepareUserTotalRefreshes(db: D1Database, records: IngestRecord[]) {
  return uniqueUserIds(records).map((userId) => prepareUserTotalRefresh(db, userId))
}

function prepareUserTotalRefresh(db: D1Database, userId: string) {
  return db
    .prepare(refreshUserTotalsSql)
    .bind(userId, userId)
}

function prepareUserTotalFromSummaryRefresh(db: D1Database, userId: string) {
  return db
    .prepare(refreshUserTotalsFromSummarySql)
    .bind(userId, userId)
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
  const rows = await input.db
    .prepare(
      `
        SELECT
          user_id as userId,
          usage_date as usageDate,
          source,
          model
        FROM daily_usage
        WHERE ? IS NULL
          OR user_id > ?
          OR (user_id = ? AND usage_date > ?)
          OR (user_id = ? AND usage_date = ? AND source > ?)
          OR (user_id = ? AND usage_date = ? AND source = ? AND model > ?)
        GROUP BY user_id, usage_date, source, model
        ORDER BY user_id ASC, usage_date ASC, source ASC, model ASC
        LIMIT ?
      `
    )
    .bind(
      input.state.cursorUserId,
      input.state.cursorUserId,
      input.state.cursorUserId,
      input.state.cursorUsageDate,
      input.state.cursorUserId,
      input.state.cursorUsageDate,
      input.state.cursorSource,
      input.state.cursorUserId,
      input.state.cursorUsageDate,
      input.state.cursorSource,
      input.state.cursorModel,
      input.limit
    )
    .all<UsageSummaryKey>()

  return rows.results ?? []
}

async function listUserIdsForTotalsBackfill(input: {
  db: D1Database
  limit: number
  cursorUserId: string | null
}) {
  const rows = await input.db
    .prepare(
      `
        SELECT user_id as userId
        FROM daily_usage_summary
        WHERE ? IS NULL
          OR user_id > ?
        GROUP BY user_id
        ORDER BY user_id ASC
        LIMIT ?
      `
    )
    .bind(input.cursorUserId, input.cursorUserId, input.limit)
    .all<{ userId: string }>()

  return (rows.results ?? []).map((row) => row.userId)
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
    cursorUserId: row.cursorUserId,
    cursorUsageDate: row.cursorUsageDate,
    cursorSource: row.cursorSource,
    cursorModel: row.cursorModel,
    completedAt: row.completedAt
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

  return existing
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

const refreshUserTotalsSql = `
  INSERT INTO user_usage_totals (
    user_id,
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
    COALESCE(SUM(total_tokens), 0),
    COALESCE(SUM(total_tokens - cache_read_tokens), 0),
    COALESCE(SUM(cost_usd), 0),
    COALESCE(SUM(session_count), 0),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM deduped_usage
  WHERE true
  ON CONFLICT(user_id) DO UPDATE SET
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
  SELECT
    ?,
    COALESCE(SUM(total_tokens), 0),
    COALESCE(SUM(total_tokens_without_cache_read), 0),
    COALESCE(SUM(cost_usd), 0),
    COALESCE(SUM(session_count), 0),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM daily_usage_summary
  WHERE user_id = ?
  ON CONFLICT(user_id) DO UPDATE SET
    total_tokens = excluded.total_tokens,
    total_tokens_without_cache_read = excluded.total_tokens_without_cache_read,
    cost_usd = excluded.cost_usd,
    session_count = excluded.session_count,
    updated_at = excluded.updated_at
`

function uniqueSummaryKeys(records: IngestRecord[]) {
  const keys = new Map<string, Pick<IngestRecord, 'userId' | 'usageDate' | 'source' | 'model'>>()
  for (const record of records) {
    const key = `${record.userId}\0${record.usageDate}\0${record.source}\0${record.model}`
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

function uniqueUserIds(records: Array<Pick<IngestRecord, 'userId'>>) {
  return [...new Set(records.map((record) => record.userId))]
}

function invalidUsageSummaryBackfillLimitError() {
  return new Error(
    `TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT must be an integer from 1 to ${maxUsageSummaryBackfillLimit}`
  )
}
