import { listSummaryKeysNeedingRefresh, listUserIdsNeedingTotalRefresh } from './refresh'
import { snapshotHashQueryChunkSize, summaryKeyId, type ExistingSnapshotHash, type UsageSummaryKey } from './types'
import type { UsageSnapshotKey } from '@tokenboard/usage-core'

// The key filter is a row-value IN over the three logical-key columns, not an OR
// chain of per-key predicates. The OR chain is only sargable on
// `daily_usage_user_device_date_idx(user_id, device_id, usage_date)`: the planner
// seeks the requested device and then filters every one of its dates, so a 30-key
// check reads that device's whole history. The row-value form matches
// `daily_usage_logical_key_device_idx(user_id, usage_date, source, model, device_id)`
// and seeks one row per key. Keep the VALUES list in the same column order as the
// tuple; the chunk size (32 keys) is unchanged because each key still binds three
// parameters.
export function snapshotHashKeyQuerySql(keyCount: number) {
  const rows = Array.from({ length: keyCount }, () => '(?, ?, ?)').join(', ')
  return `
          SELECT
            source,
            usage_date as usageDate,
            model,
            snapshot_hash as snapshotHash
          FROM daily_usage
          WHERE user_id = ?
            AND device_id = ?
            AND snapshot_hash IS NOT NULL
            AND (source, usage_date, model) IN (VALUES ${rows})
        `
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
    const bindings = keys.flatMap((key) => [key.source, key.usageDate, key.model])
    const rows = await db
      .prepare(snapshotHashKeyQuerySql(keys.length))
      .bind(input.userId, input.deviceId, ...bindings)
      .all<ExistingSnapshotHash>()

    existing.push(...(rows.results ?? []))
  }

  return filterExistingHashesWithCurrentCaches(db, input.userId, existing)
}

async function filterExistingHashesWithCurrentCaches(db: D1Database, userId: string, rows: ExistingSnapshotHash[]) {
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
  return rows.filter((row) => !staleKeyIds.has(summaryKeyId({ userId, ...row } as UsageSummaryKey)))
}
