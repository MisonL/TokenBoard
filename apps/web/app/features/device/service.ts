import { ApiError } from '../../lib/errors'
import { randomId, randomToken, sha256Hex } from '../../lib/crypto'
import { defaultTimezone, parseTimezone } from '../../lib/timezone'
import type { DevicePairRequest } from './schema'

export type PairingType = 'new_device' | 'reconnect_device'

export type PairingCodeRecord = {
  id: string
  userId: string
  pairingType: PairingType
  targetDeviceId: string | null
  expiresAt: string
  consumedAt: string | null
}

export type DevicePairingRepository = {
  findUsablePairingCode(codeHash: string, now: string): Promise<PairingCodeRecord | null>
  createPairingCode(input: {
    pairingCodeId: string
    userId: string
    codeHash: string
    pairingType: PairingType
    targetDeviceId?: string | null
    metadata?: string | null
    expiresAt: string
    createdAt: string
  }): Promise<void>
  ensureDeviceOwnedByUser(userId: string, deviceId: string): Promise<boolean>
  createUploadTokenAndDevice(input: {
    uploadTokenId: string
    uploadTokenHash: string
    deviceId: string
    installationId: string
    installClaimHash: string
    userId: string
    deviceName: string
    platform: string
    createdAt: string
  }): Promise<void>
  createUploadTokenAndInstallation(input: {
    uploadTokenId: string
    uploadTokenHash: string
    deviceId: string
    installationId: string
    installClaimHash: string
    userId: string
    deviceName: string
    platform: string
    createdAt: string
  }): Promise<void>
  createAuditLog(input: {
    auditLogId: string
    userId: string
    actorType: string
    action: string
    targetType: string
    targetId: string | null
    metadata?: string | null
    createdAt: string
  }): Promise<void>
  consumePairingCode(pairingCodeId: string, consumedAt: string): Promise<boolean>
}

export type PairDeviceDeps = {
  now: () => string
  endpoint: string
  randomId: () => string
  randomToken: () => string
  hash: (value: string) => Promise<string>
}

export type CreatePairingCodeDeps = {
  now: () => Date
  randomId: () => string
  randomToken: () => string
  hash: (value: string) => Promise<string>
}

export type UserDevice = {
  id: string
  name: string
  platform: string
  lastSyncedAt: string | null
  createdAt: string
  activeTokenCount: number
  installations: UserDeviceInstallation[]
}

export type UserDeviceInstallation = {
  id: string
  deviceId: string
  platform: string
  hostname: string | null
  clientVersion: string | null
  firstSeenAt: string
  lastSeenAt: string | null
  revokedAt: string | null
  activeTokenCount: number
}

export type UserDeviceAuditLog = {
  id: string
  action: string
  targetType: string
  targetId: string | null
  metadata: string | null
  createdAt: string
}

type DeviceRow = Omit<UserDevice, 'activeTokenCount' | 'installations'> & {
  activeTokenCount: number | null
}

type InstallationRow = Omit<UserDeviceInstallation, 'activeTokenCount'> & {
  activeTokenCount: number | null
}

export function createPairDeviceDeps(endpoint: string): PairDeviceDeps {
  return {
    now: () => new Date().toISOString(),
    endpoint,
    randomId: () => randomId('id'),
    randomToken: () => randomToken('tb_upload'),
    hash: sha256Hex
  }
}

export function createPairingCodeDeps(): CreatePairingCodeDeps {
  return {
    now: () => new Date(),
    randomId: () => randomId('pair'),
    randomToken: () => randomToken('tb_pair'),
    hash: sha256Hex
  }
}

export async function listUserDevices(db: D1Database, userId: string): Promise<UserDevice[]> {
  const [deviceRows, installationRows] = await Promise.all([
    db
      .prepare(
        `
          SELECT
            devices.id,
            devices.name,
            devices.platform,
            devices.last_synced_at as lastSyncedAt,
            devices.created_at as createdAt,
            COALESCE(SUM(CASE WHEN upload_tokens.id IS NOT NULL AND upload_tokens.revoked_at IS NULL THEN 1 ELSE 0 END), 0) as activeTokenCount
          FROM devices
          LEFT JOIN upload_tokens ON upload_tokens.device_id = devices.id
            AND upload_tokens.user_id = devices.user_id
          WHERE devices.user_id = ?
          GROUP BY devices.id
          ORDER BY devices.last_synced_at DESC, devices.created_at DESC
        `
      )
      .bind(userId)
      .all<DeviceRow>(),
    db
      .prepare(
        `
          SELECT
            device_installations.id,
            device_installations.device_id as deviceId,
            device_installations.platform,
            device_installations.hostname,
            device_installations.client_version as clientVersion,
            device_installations.first_seen_at as firstSeenAt,
            device_installations.last_seen_at as lastSeenAt,
            device_installations.revoked_at as revokedAt,
            COALESCE(SUM(CASE WHEN upload_tokens.id IS NOT NULL AND upload_tokens.revoked_at IS NULL THEN 1 ELSE 0 END), 0) as activeTokenCount
          FROM device_installations
          LEFT JOIN upload_tokens ON upload_tokens.installation_id = device_installations.id
            AND upload_tokens.user_id = device_installations.user_id
          WHERE device_installations.user_id = ?
          GROUP BY device_installations.id
          ORDER BY device_installations.last_seen_at DESC, device_installations.created_at DESC
        `
      )
      .bind(userId)
      .all<InstallationRow>()
  ])

  const installationsByDevice = new Map<string, UserDeviceInstallation[]>()
  for (const row of installationRows.results ?? []) {
    const installation = {
      id: row.id,
      deviceId: row.deviceId,
      platform: row.platform,
      hostname: row.hostname ?? null,
      clientVersion: row.clientVersion ?? null,
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt ?? null,
      revokedAt: row.revokedAt ?? null,
      activeTokenCount: Number(row.activeTokenCount ?? 0)
    }
    installationsByDevice.set(row.deviceId, [
      ...(installationsByDevice.get(row.deviceId) ?? []),
      installation
    ])
  }

  return (deviceRows.results ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    platform: row.platform,
    lastSyncedAt: row.lastSyncedAt ?? null,
    createdAt: row.createdAt,
    activeTokenCount: Number(row.activeTokenCount ?? 0),
    installations: installationsByDevice.get(row.id) ?? []
  }))
}

export async function listDeviceAuditLogs(
  db: D1Database,
  input: {
    userId: string
    deviceId: string
    limit?: number
  }
) {
  const rows = await db
    .prepare(
      `
        SELECT
          id,
          action,
          target_type as targetType,
          target_id as targetId,
          metadata,
          created_at as createdAt
        FROM audit_logs
        WHERE user_id = ?
          AND (
            target_id = ?
            OR metadata LIKE ?
          )
        ORDER BY created_at DESC
        LIMIT ?
      `
    )
    .bind(input.userId, input.deviceId, `%"deviceId":"${input.deviceId}"%`, input.limit ?? 20)
    .all<UserDeviceAuditLog>()

  return rows.results ?? []
}

export function parseDeviceNameForm(form: Record<string, unknown>) {
  const name = String(form.name ?? '').trim()
  if (name.length < 1 || name.length > 80) {
    throw new ApiError('BAD_REQUEST', 'Device name must be 1-80 characters', 400)
  }
  return name
}

export async function renameDevice(
  db: D1Database,
  input: {
    userId: string
    deviceId: string
    name: string
    now?: string
  }
) {
  const now = input.now ?? new Date().toISOString()
  const name = parseDeviceNameForm({ name: input.name })
  const result = await db
    .prepare('UPDATE devices SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .bind(name, now, input.deviceId, input.userId)
    .run()

  if ((result.meta.changes ?? 0) === 0) {
    throw new ApiError('NOT_FOUND', 'Device not found', 404)
  }

  await createDeviceAuditLog(db, {
    userId: input.userId,
    action: 'device.rename',
    targetType: 'device',
    targetId: input.deviceId,
    metadata: { name },
    now
  })
}

export async function revokeDevice(
  db: D1Database,
  input: {
    userId: string
    deviceId: string
    now?: string
  }
) {
  const now = input.now ?? new Date().toISOString()

  await revokeDeviceTokens(db, {
    userId: input.userId,
    deviceId: input.deviceId,
    now
  })

  await db
    .prepare(
      `
        UPDATE device_installations
        SET revoked_at = ?, updated_at = ?
        WHERE user_id = ?
          AND device_id = ?
          AND revoked_at IS NULL
      `
    )
    .bind(now, now, input.userId, input.deviceId)
    .run()

  const result = await db
    .prepare('UPDATE devices SET updated_at = ? WHERE id = ? AND user_id = ?')
    .bind(now, input.deviceId, input.userId)
    .run()

  if ((result.meta.changes ?? 0) === 0) {
    throw new ApiError('NOT_FOUND', 'Device not found', 404)
  }

  await createDeviceAuditLog(db, {
    userId: input.userId,
    action: 'device.revoke',
    targetType: 'device',
    targetId: input.deviceId,
    metadata: { deviceId: input.deviceId },
    now
  })
}

export async function revokeInstallation(
  db: D1Database,
  input: {
    userId: string
    installationId: string
    now?: string
  }
) {
  const now = input.now ?? new Date().toISOString()
  const installation = await findInstallationForUser(db, input.userId, input.installationId)
  if (!installation) {
    throw new ApiError('NOT_FOUND', 'Installation not found', 404)
  }

  await db
    .prepare(
      `
        UPDATE upload_tokens
        SET revoked_at = ?
        WHERE user_id = ?
          AND installation_id = ?
          AND revoked_at IS NULL
      `
    )
    .bind(now, input.userId, input.installationId)
    .run()

  const result = await db
    .prepare(
      `
        UPDATE device_installations
        SET revoked_at = ?, updated_at = ?
        WHERE id = ?
          AND user_id = ?
          AND revoked_at IS NULL
      `
    )
    .bind(now, now, input.installationId, input.userId)
    .run()

  if ((result.meta.changes ?? 0) === 0) {
    throw new ApiError('NOT_FOUND', 'Installation not found', 404)
  }

  await createDeviceAuditLog(db, {
    userId: input.userId,
    action: 'installation.revoke',
    targetType: 'device_installation',
    targetId: input.installationId,
    metadata: { deviceId: installation.deviceId },
    now
  })
}

export async function revokeUploadToken(
  db: D1Database,
  input: {
    userId: string
    uploadTokenId: string
    now?: string
  }
) {
  const now = input.now ?? new Date().toISOString()
  const token = await findUploadTokenForUser(db, input.userId, input.uploadTokenId)
  if (!token) {
    throw new ApiError('NOT_FOUND', 'Upload token not found', 404)
  }

  const result = await db
    .prepare(
      `
        UPDATE upload_tokens
        SET revoked_at = ?
        WHERE user_id = ?
          AND id = ?
          AND revoked_at IS NULL
      `
    )
    .bind(now, input.userId, input.uploadTokenId)
    .run()

  if ((result.meta.changes ?? 0) === 0) {
    throw new ApiError('NOT_FOUND', 'Upload token not found', 404)
  }

  await createDeviceAuditLog(db, {
    userId: input.userId,
    action: 'token.revoke',
    targetType: 'upload_token',
    targetId: input.uploadTokenId,
    metadata: {
      deviceId: token.deviceId,
      installationId: token.installationId
    },
    now
  })
}

async function findInstallationForUser(db: D1Database, userId: string, installationId: string) {
  return await db
    .prepare(
      `
        SELECT device_id as deviceId
        FROM device_installations
        WHERE id = ?
          AND user_id = ?
        LIMIT 1
      `
    )
    .bind(installationId, userId)
    .first<{ deviceId: string }>()
}

async function findUploadTokenForUser(db: D1Database, userId: string, uploadTokenId: string) {
  return await db
    .prepare(
      `
        SELECT
          device_id as deviceId,
          installation_id as installationId
        FROM upload_tokens
        WHERE id = ?
          AND user_id = ?
        LIMIT 1
      `
    )
    .bind(uploadTokenId, userId)
    .first<{ deviceId: string | null; installationId: string | null }>()
}

async function createDeviceAuditLog(
  db: D1Database,
  input: {
    userId: string
    action: string
    targetType: string
    targetId: string | null
    metadata: Record<string, unknown>
    now: string
  }
) {
  await db
    .prepare(
      `
        INSERT INTO audit_logs (
          id,
          user_id,
          actor_type,
          action,
          target_type,
          target_id,
          metadata,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .bind(
      randomId('audit'),
      input.userId,
      'user',
      input.action,
      input.targetType,
      input.targetId,
      JSON.stringify(input.metadata),
      input.now
    )
    .run()
}

async function revokeDeviceTokens(
  db: D1Database,
  input: {
    userId: string
    deviceId: string
    now: string
  }
) {
  await db
    .prepare(
      `
        UPDATE upload_tokens
        SET revoked_at = ?
        WHERE user_id = ?
          AND device_id = ?
          AND revoked_at IS NULL
      `
    )
    .bind(input.now, input.userId, input.deviceId)
    .run()
}

export async function createPairingCode(
  repository: DevicePairingRepository,
  userId: string,
  deps: CreatePairingCodeDeps,
  ttlMinutes = 30,
  options: {
    pairingType?: PairingType
    targetDeviceId?: string | null
    metadata?: string | null
  } = {}
) {
  const now = deps.now()
  const createdAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000).toISOString()
  const pairingCode = deps.randomToken()
  const codeHash = await deps.hash(pairingCode)
  const pairingType = options.pairingType ?? 'new_device'
  const targetDeviceId = options.targetDeviceId ?? null

  if (pairingType === 'reconnect_device') {
    if (!targetDeviceId) {
      throw new ApiError('BAD_REQUEST', 'Reconnect pairing requires target device', 400)
    }
    const ownsTarget = await repository.ensureDeviceOwnedByUser(userId, targetDeviceId)
    if (!ownsTarget) {
      throw new ApiError('NOT_FOUND', 'Device not found', 404)
    }
  }

  await repository.createPairingCode({
    pairingCodeId: deps.randomId(),
    userId,
    codeHash,
    pairingType,
    targetDeviceId,
    metadata: options.metadata ?? null,
    expiresAt,
    createdAt
  })

  return {
    pairingCode,
    expiresAt
  }
}

export async function pairDevice(
  repository: DevicePairingRepository,
  request: DevicePairRequest,
  deps: PairDeviceDeps
) {
  const timezone = request.timezone ? parseTimezone(request.timezone) : defaultTimezone
  if (!timezone) {
    throw new ApiError('BAD_REQUEST', 'Invalid timezone', 400)
  }

  const now = deps.now()
  const pairingCodeHash = await deps.hash(request.pairingCode)
  const pairingCode = await repository.findUsablePairingCode(pairingCodeHash, now)
  if (!pairingCode) {
    throw new ApiError('UNAUTHORIZED', 'Invalid or expired pairing code', 401)
  }

  const id = deps.randomId()
  const deviceId = pairingCode.pairingType === 'reconnect_device' ? pairingCode.targetDeviceId : `dev_${id}`
  const uploadTokenId = `ut_${id}`
  const installationId = `inst_${id}`
  const uploadToken = deps.randomToken()
  const installClaim = deps.randomToken()
  const uploadTokenHash = await deps.hash(uploadToken)
  const installClaimHash = await deps.hash(installClaim)
  const consumed = await repository.consumePairingCode(pairingCode.id, now)
  if (!consumed) {
    throw new ApiError('UNAUTHORIZED', 'Invalid or expired pairing code', 401)
  }

  if (!deviceId) {
    throw new ApiError('BAD_REQUEST', 'Reconnect pairing is missing target device', 400)
  }

  const deviceName = request.deviceName ?? 'TokenBoard device'
  const platform = request.platform ?? 'unknown'
  const input = {
    uploadTokenId,
    uploadTokenHash,
    deviceId,
    installationId,
    installClaimHash,
    userId: pairingCode.userId,
    deviceName,
    platform,
    createdAt: now
  }

  if (pairingCode.pairingType === 'reconnect_device') {
    await repository.createUploadTokenAndInstallation(input)
  } else {
    await repository.createUploadTokenAndDevice(input)
  }

  await repository.createAuditLog({
    auditLogId: `audit_${id}`,
    userId: pairingCode.userId,
    actorType: 'user',
    action: pairingCode.pairingType === 'reconnect_device' ? 'device.reconnect' : 'device.pair',
    targetType: 'device',
    targetId: deviceId,
    metadata: JSON.stringify({ installationId, platform }),
    createdAt: now
  })

  return {
    endpoint: deps.endpoint,
    uploadToken,
    deviceId,
    installationId,
    installClaim,
    timezone
  }
}
