import { runStatementBatches } from './types'

export async function markIngestSynced(
  db: D1Database,
  input: {
    uploadTokenHash: string
    deviceId: string | null
    installationId?: string | null
    syncedAt: string
  }
) {
  const syncedAt = normalizeSyncedAt(input.syncedAt)
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE upload_tokens
       SET last_used_at = ?
       WHERE token_hash = ?
         AND (
           last_used_at IS NULL
           OR julianday(last_used_at) IS NULL
           OR julianday(last_used_at) <= julianday(?)
         )`
      )
      .bind(syncedAt, input.uploadTokenHash, syncedAt)
  ]

  if (input.deviceId) {
    statements.push(
      db
        .prepare(
          `UPDATE devices
         SET last_synced_at = ?, updated_at = ?
         WHERE id = ?
           AND (
             last_synced_at IS NULL
             OR julianday(last_synced_at) IS NULL
             OR julianday(last_synced_at) <= julianday(?)
           )
           AND user_id = (
             SELECT user_id FROM upload_tokens WHERE token_hash = ? LIMIT 1
           )`
        )
        .bind(syncedAt, syncedAt, input.deviceId, syncedAt, input.uploadTokenHash)
    )
  }

  if (input.installationId) {
    statements.push(
      db
        .prepare(
          `
          UPDATE device_installations
          SET last_seen_at = ?, updated_at = ?
          WHERE id = ?
            AND (
              last_seen_at IS NULL
              OR julianday(last_seen_at) IS NULL
              OR julianday(last_seen_at) <= julianday(?)
            )
            AND user_id = (
              SELECT user_id FROM upload_tokens WHERE token_hash = ? LIMIT 1
            )
        `
        )
        .bind(syncedAt, syncedAt, input.installationId, syncedAt, input.uploadTokenHash)
    )
  }
  await runStatementBatches(db, statements)
}

export function normalizeSyncedAt(value: string) {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) {
    throw new Error('Invalid syncedAt timestamp')
  }
  return new Date(timestamp).toISOString()
}
