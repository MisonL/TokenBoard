import type { UsageSnapshot, UsageSnapshotKey } from '@tokenboard/usage-core'
import type { AuthenticatedUser } from '../auth/middleware'
import { findExistingSnapshotHashes, markIngestSynced, normalizeSyncedAt, upsertUsageSnapshots } from './repository'

const legacyDeviceId = 'legacy'

export async function ingestSnapshots(
  db: D1Database,
  user: AuthenticatedUser,
  snapshots: UsageSnapshot[],
  syncedAt = new Date().toISOString()
) {
  const normalizedSyncedAt = normalizeSyncedAt(syncedAt)
  const result = await upsertUsageSnapshots(
    db,
    snapshots.map((snapshot) => ({
      ...snapshot,
      collectedAt: normalizeCollectedAt(snapshot.collectedAt, normalizedSyncedAt),
      userId: user.id,
      deviceId: user.deviceId ?? legacyDeviceId
    }))
  )
  await markIngestSynced(db, {
    uploadTokenHash: user.uploadTokenHash,
    deviceId: user.deviceId,
    installationId: user.installationId,
    syncedAt: normalizedSyncedAt
  })
  return result
}

export async function checkExistingSnapshots(db: D1Database, user: AuthenticatedUser, keys: UsageSnapshotKey[]) {
  const existing = await findExistingSnapshotHashes(db, {
    userId: user.id,
    deviceId: user.deviceId ?? legacyDeviceId,
    keys
  })
  return { existing }
}

function normalizeCollectedAt(value: string, syncedAt: string) {
  const collectedAt = Date.parse(value)
  const syncedAtMs = Date.parse(syncedAt)
  if (!Number.isFinite(collectedAt)) throw new Error('Invalid collectedAt timestamp')
  return collectedAt > syncedAtMs ? syncedAt : value
}
