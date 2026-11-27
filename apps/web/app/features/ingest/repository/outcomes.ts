import type { IngestRecord } from './types'

// The ingest upsert's WHERE clause silently skips a row for three different reasons, and the
// statement result only says "no write happened". Clients acknowledge cursors off what the
// server reports as delivered, so a skipped row that still reads as delivered is dropped for
// good — upload-backoff then pauses on top of a batch that "succeeded". This module names the
// reason for every row the batch did not write, so the response can carry it.
//
// The classification must agree with the upsert SQL (`upsert.ts` `upsertUsageSql`), which is
// the authority on *whether* a row was written; this file only explains a write that did not
// happen, using the row as it stands after the batch:
//
//   `same`      — the stored snapshot hash equals the incoming one: the row already holds this
//                 exact measurement. Delivered: nothing to send, nothing to lose.
//   `protected` — the incoming row is a Codex zero-token session-only report and the stored row
//                 has usage; the upsert guard keeps the richer stored row. Delivered: re-sending
//                 can never change the outcome, and the stored row is a superset.
//   `stale`     — the stored `synced_at` is newer than the incoming `collectedAt`: the server
//                 holds a *different, later* measurement for this key. NOT delivered — the
//                 client must keep the row pending and surface a clock warning; acking here is
//                 how an older measurement gets discarded without a trace.
//   `unknown`   — no explanation (no stored row, unparseable timestamps). NOT delivered, for the
//                 same reason as `stale`: fail closed, keep it pending, say so.
export type IngestRowStatus = 'same' | 'protected' | 'stale' | 'unknown'

export type IngestRowOutcome = {
  index: number
  status: IngestRowStatus
}

export type StoredRow = {
  userId: string
  deviceId: string
  source: string
  usageDate: string
  model: string
  snapshotHash: string | null
  syncedAt: string
  storedHasUsage: number
}

// Two bindings (user, device) plus three per key, inside the same 100-parameter ceiling with
// one slot of headroom that the other chunk sizes keep (`types.ts` d1BoundParameterHeadroom).
export const outcomeQueryChunkSize = 32

export function outcomeQuerySql(keyCount: number) {
  const rows = Array.from({ length: keyCount }, () => '(?, ?, ?)').join(', ')
  return `
    SELECT
      user_id AS userId,
      device_id AS deviceId,
      source,
      usage_date AS usageDate,
      model,
      snapshot_hash AS snapshotHash,
      synced_at AS syncedAt,
      CASE WHEN input_tokens > 0 OR output_tokens > 0 OR cache_creation_tokens > 0
        OR cache_read_tokens > 0 OR total_tokens > 0 OR cost_usd > 0 THEN 1 ELSE 0 END AS storedHasUsage
    FROM daily_usage
    WHERE user_id = ?
      AND device_id = ?
      AND (source, usage_date, model) IN (VALUES ${rows})
  `
}

export async function listStoredRowsForOutcomes(db: D1Database, records: IngestRecord[]): Promise<StoredRow[]> {
  const stored: StoredRow[] = []
  // A request always carries one identity, but the repository is called directly by tests and
  // backfills, so group defensively instead of assuming.
  const byIdentity = new Map<string, IngestRecord[]>()
  for (const record of records) {
    const id = `${record.userId}\0${record.deviceId}`
    const group = byIdentity.get(id)
    if (group) group.push(record)
    else byIdentity.set(id, [record])
  }
  for (const group of byIdentity.values()) {
    for (let index = 0; index < group.length; index += outcomeQueryChunkSize) {
      const chunk = group.slice(index, index + outcomeQueryChunkSize)
      const bindings = chunk.flatMap((record) => [record.source, record.usageDate, record.model])
      const rows = await db
        .prepare(outcomeQuerySql(chunk.length))
        .bind(chunk[0]!.userId, chunk[0]!.deviceId, ...bindings)
        .all<StoredRow>()
      stored.push(...(rows.results ?? []))
    }
  }
  return stored
}

// Whether the upsert's WHERE-clause Codex guard applies to this incoming row: a report with
// nothing to say at all — zero tokens *and* zero session count — must not overwrite a stored
// row that has usage. Mirrors the `NOT (...)` clause of `upsertUsageSql` (whose stored-side half
// is `storedHasUsage`).
//
// This is deliberately narrower than the `preserveCodexSessionOnlySql` CASE guard, which needs
// `session_count > 0`: that one keeps the stored token columns but still *writes* the row (its
// session_count and hash land), so it is counted as `upserted` and never reaches this file.
// Verified against SQLite: the `session_count >0` report reports changes=1, the all-zero report
// and an out-of-window `collectedAt` both report changes=0.
function isCodexNothingToSay(record: IngestRecord) {
  return (
    !record.correction &&
    record.source === 'codex' &&
    record.inputTokens === 0 &&
    record.outputTokens === 0 &&
    record.cacheCreationTokens === 0 &&
    record.cacheReadTokens === 0 &&
    record.totalTokens === 0 &&
    record.sessionCount === 0
  )
}

export function classifyUnchangedRow(
  record: IngestRecord,
  incomingHash: string,
  stored: StoredRow | undefined
): IngestRowStatus {
  if (!stored) return 'unknown'
  if (stored.snapshotHash === incomingHash) return 'same'
  if (isCodexNothingToSay(record) && stored.storedHasUsage > 0) return 'protected'
  const storedMs = Date.parse(stored.syncedAt)
  const incomingMs = Date.parse(record.collectedAt)
  // `julianday(a) >= julianday(b)` in the upsert writes on equality, so an older incoming
  // timestamp at SQLite's precision means the stored row is strictly newer. Equality at
  // millisecond precision means the same: julianday resolves sub-millisecond fractions that
  // Date.parse truncates, so an instant-equal pair would have been written, and an
  // equal-millisecond skip is a stored row some fraction newer.
  if (Number.isFinite(storedMs) && Number.isFinite(incomingMs) && storedMs >= incomingMs) return 'stale'
  return 'unknown'
}

export async function classifyUnchangedRecords(
  db: D1Database,
  records: IngestRecord[],
  hashes: string[]
): Promise<IngestRowOutcome[]> {
  if (records.length === 0) return []
  const storedRows = await listStoredRowsForOutcomes(db, records)
  // Keyed by the full upsert identity, device included: a direct caller can pass records
  // from more than one device, and the conflict key — so the row each record was compared
  // against — carries the device.
  const storedByKey = new Map<string, StoredRow>()
  for (const row of storedRows) {
    storedByKey.set(identityKey(row), row)
  }
  return records.map((record, index) => ({
    index,
    status: classifyUnchangedRow(record, hashes[index]!, storedByKey.get(identityKey(record)))
  }))
}

function identityKey(row: { userId: string; deviceId: string; source: string; usageDate: string; model: string }) {
  return `${row.userId}\0${row.deviceId}\0${row.source}\0${row.usageDate}\0${row.model}`
}
