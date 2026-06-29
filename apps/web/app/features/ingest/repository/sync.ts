export async function markIngestSynced(
  db: D1Database,
  input: {
    uploadTokenHash: string
    deviceId: string | null
    installationId?: string | null
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

  if (input.installationId) {
    await db
      .prepare(
        `
          UPDATE device_installations
          SET last_seen_at = ?, updated_at = ?
          WHERE id = ?
            AND user_id = (
              SELECT user_id FROM upload_tokens WHERE token_hash = ? LIMIT 1
            )
        `
      )
      .bind(input.syncedAt, input.syncedAt, input.installationId, input.uploadTokenHash)
      .run()
  }
}
