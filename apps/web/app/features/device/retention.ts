/**
 * Retention for the two device tables that only ever grow.
 *
 * `pairing_codes` is written on every install, reconnect, and rename, and `audit_logs` on
 * every device action; neither had a runtime delete, unlike `api_rate_limits`,
 * `webhook_delivery_logs`, and `daily_report_history`, which all prune. Rows accumulate
 * forever at a rate independent of active devices. The windows here match the sibling
 * tables' scale: a consumed or expired code is useless within minutes, and the audit trail
 * is read only on the per-device activity view, which no user pages back a year.
 */
export const pairingCodeRetentionDays = 7
export const auditLogRetentionDays = 365

/** Delete consumed/expired pairing codes and audit rows older than the retention windows. */
export async function pruneDeviceRetention(db: D1Database, now = new Date()) {
  const pairingCutoff = isoDaysAgo(now, pairingCodeRetentionDays)
  const auditCutoff = isoDaysAgo(now, auditLogRetentionDays)
  await db.batch([
    db
      .prepare(
        `DELETE FROM pairing_codes
         WHERE julianday(COALESCE(consumed_at, expires_at)) IS NULL
            OR julianday(COALESCE(consumed_at, expires_at)) <= julianday(?)`
      )
      .bind(pairingCutoff),
    db.prepare(`DELETE FROM audit_logs WHERE julianday(created_at) <= julianday(?)`).bind(auditCutoff)
  ])
}

function isoDaysAgo(now: Date, days: number) {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString()
}
