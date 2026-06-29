import type { DevicePairingRepository, PairingCodeRecord } from './service'

type InstallationInput = {
  uploadTokenId: string
  uploadTokenHash: string
  deviceId: string
  installationId: string
  userId: string
  deviceName: string
  platform: string
  createdAt: string
}

export class D1DevicePairingRepository implements DevicePairingRepository {
  constructor(private readonly db: D1Database) {}

  async createPairingCode(input: {
    pairingCodeId: string
    userId: string
    codeHash: string
    pairingType: string
    targetDeviceId?: string | null
    metadata?: string | null
    expiresAt: string
    createdAt: string
  }) {
    await this.db
      .prepare(
        `
          INSERT INTO pairing_codes (
            id,
            user_id,
            code_hash,
            pairing_type,
            target_device_id,
            metadata,
            expires_at,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .bind(
        input.pairingCodeId,
        input.userId,
        input.codeHash,
        input.pairingType,
        input.targetDeviceId ?? null,
        input.metadata ?? null,
        input.expiresAt,
        input.createdAt
      )
      .run()
  }

  async findUsablePairingCode(codeHash: string, now: string): Promise<PairingCodeRecord | null> {
    const row = await this.db
      .prepare(
        `
          SELECT
            id,
            user_id as userId,
            pairing_type as pairingType,
            target_device_id as targetDeviceId,
            expires_at as expiresAt,
            consumed_at as consumedAt
          FROM pairing_codes
          WHERE code_hash = ?
            AND consumed_at IS NULL
            AND expires_at > ?
          LIMIT 1
        `
      )
      .bind(codeHash, now)
      .first<PairingCodeRecord>()

    return row ?? null
  }

  async ensureDeviceOwnedByUser(userId: string, deviceId: string) {
    const row = await this.db
      .prepare('SELECT id FROM devices WHERE id = ? AND user_id = ? LIMIT 1')
      .bind(deviceId, userId)
      .first<{ id: string }>()
    return Boolean(row)
  }

  async createUploadTokenAndDevice(input: {
    uploadTokenId: string
    uploadTokenHash: string
    deviceId: string
    installationId: string
    userId: string
    deviceName: string
    platform: string
    createdAt: string
  }) {
    await this.db.batch([
      this.deviceInsertStatement(input),
      this.installationInsertStatement(input),
      this.uploadTokenInsertStatement(input)
    ])
  }

  async createUploadTokenAndInstallation(input: {
    uploadTokenId: string
    uploadTokenHash: string
    deviceId: string
    installationId: string
    userId: string
    deviceName: string
    platform: string
    createdAt: string
  }) {
    await this.db.batch([
      this.installationInsertStatement(input),
      this.uploadTokenInsertStatement(input)
    ])
  }

  private deviceInsertStatement(input: InstallationInput) {
    return this.db
      .prepare(
        `
          INSERT INTO devices (id, user_id, name, platform, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `
      )
      .bind(
        input.deviceId,
        input.userId,
        input.deviceName,
        input.platform,
        input.createdAt,
        input.createdAt
      )
  }

  private installationInsertStatement(input: InstallationInput) {
    return this.db
      .prepare(
        `
          INSERT INTO device_installations (
            id,
            user_id,
            device_id,
            platform,
            hostname,
            first_seen_at,
            last_seen_at,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .bind(
        input.installationId,
        input.userId,
        input.deviceId,
        input.platform,
        input.deviceName,
        input.createdAt,
        input.createdAt,
        input.createdAt,
        input.createdAt
      )
  }

  private uploadTokenInsertStatement(input: InstallationInput) {
    return this.db
      .prepare(
        `
          INSERT INTO upload_tokens (
            id,
            user_id,
            name,
            token_hash,
            device_id,
            installation_id,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `
      )
      .bind(
        input.uploadTokenId,
        input.userId,
        input.deviceName,
        input.uploadTokenHash,
        input.deviceId,
        input.installationId,
        input.createdAt
      )
  }

  async createAuditLog(input: {
    auditLogId: string
    userId: string
    actorType: string
    action: string
    targetType: string
    targetId: string | null
    metadata?: string | null
    createdAt: string
  }) {
    await this.db
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
        input.auditLogId,
        input.userId,
        input.actorType,
        input.action,
        input.targetType,
        input.targetId,
        input.metadata ?? null,
        input.createdAt
      )
      .run()
  }

  async consumePairingCode(pairingCodeId: string, consumedAt: string) {
    const result = await this.db
      .prepare('UPDATE pairing_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL')
      .bind(consumedAt, pairingCodeId)
      .run()
    return (result.meta.changes ?? 0) > 0
  }
}
