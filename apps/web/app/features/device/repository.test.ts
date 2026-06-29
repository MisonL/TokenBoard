import { describe, expect, test } from 'vitest'
import { D1DevicePairingRepository } from './repository'

function createRecordingDb(firstResult: unknown = null) {
  const sqlStatements: string[] = []
  const bindings: unknown[][] = []
  const batches: unknown[][] = []
  const db = {
    prepare(sql: string) {
      sqlStatements.push(sql)
      return {
        bind(...values: unknown[]) {
          bindings.push(values)
          return {
            async first() {
              return firstResult
            },
            async run() {
              return { meta: { changes: 1 } }
            }
          }
        }
      }
    },
    async batch(statements: unknown[]) {
      batches.push(statements)
      return statements.map(() => ({ success: true }))
    }
  } as unknown as D1Database

  return { db, sqlStatements, bindings, batches }
}

describe('D1DevicePairingRepository', () => {
  test('stores pairing code type and target device metadata', async () => {
    const { db, sqlStatements, bindings, batches } = createRecordingDb()
    const repository = new D1DevicePairingRepository(db)

    await repository.createPairingCode({
      pairingCodeId: 'pair_1',
      userId: 'user_1',
      codeHash: 'hash:pair',
      pairingType: 'reconnect_device',
      targetDeviceId: 'dev_old',
      metadata: '{"reason":"reconnect"}',
      expiresAt: '2026-06-30T10:30:00.000Z',
      createdAt: '2026-06-30T10:00:00.000Z'
    })

    expect(sqlStatements[0]).toContain('INSERT INTO pairing_codes')
    expect(sqlStatements[0]).toContain('pairing_type')
    expect(sqlStatements[0]).toContain('target_device_id')
    expect(bindings[0]).toEqual([
      'pair_1',
      'user_1',
      'hash:pair',
      'reconnect_device',
      'dev_old',
      '{"reason":"reconnect"}',
      '2026-06-30T10:30:00.000Z',
      '2026-06-30T10:00:00.000Z'
    ])
  })

  test('creates a logical device, installation, and upload token for new pairing', async () => {
    const { db, sqlStatements, bindings, batches } = createRecordingDb()
    const repository = new D1DevicePairingRepository(db)

    await repository.createUploadTokenAndDevice({
      uploadTokenId: 'ut_1',
      uploadTokenHash: 'hash:upload',
      deviceId: 'dev_1',
      installationId: 'inst_1',
      installClaimHash: 'hash:claim',
      userId: 'user_1',
      deviceName: 'Workstation',
      platform: 'darwin',
      createdAt: '2026-06-30T10:00:00.000Z'
    })

    expect(sqlStatements[0]).toContain('INSERT INTO devices')
    expect(sqlStatements[1]).toContain('INSERT INTO device_installations')
    expect(sqlStatements[1]).toContain('install_claim_hash')
    expect(sqlStatements[2]).toContain('INSERT INTO upload_tokens')
    expect(sqlStatements[2]).toContain('installation_id')
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(3)
    expect(bindings[0]).toEqual([
      'dev_1',
      'user_1',
      'Workstation',
      'darwin',
      '2026-06-30T10:00:00.000Z',
      '2026-06-30T10:00:00.000Z'
    ])
    expect(bindings[1]).toEqual([
      'inst_1',
      'user_1',
      'dev_1',
      'darwin',
      'Workstation',
      'hash:claim',
      '2026-06-30T10:00:00.000Z',
      '2026-06-30T10:00:00.000Z',
      '2026-06-30T10:00:00.000Z',
      '2026-06-30T10:00:00.000Z'
    ])
  })

  test('creates only a new installation and token for reconnect pairing', async () => {
    const { db, sqlStatements, batches } = createRecordingDb()
    const repository = new D1DevicePairingRepository(db)

    await repository.createUploadTokenAndInstallation({
      uploadTokenId: 'ut_1',
      uploadTokenHash: 'hash:upload',
      deviceId: 'dev_old',
      installationId: 'inst_1',
      installClaimHash: 'hash:claim',
      userId: 'user_1',
      deviceName: 'Reinstalled',
      platform: 'linux',
      createdAt: '2026-06-30T10:00:00.000Z'
    })

    expect(sqlStatements.some((sql) => sql.includes('INSERT INTO devices'))).toBe(false)
    expect(sqlStatements[0]).toContain('INSERT INTO device_installations')
    expect(sqlStatements[1]).toContain('INSERT INTO upload_tokens')
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(2)
  })

  test('records device pairing audit logs', async () => {
    const { db, sqlStatements, bindings } = createRecordingDb()
    const repository = new D1DevicePairingRepository(db)

    await repository.createAuditLog({
      auditLogId: 'audit_1',
      userId: 'user_1',
      actorType: 'user',
      action: 'device.reconnect',
      targetType: 'device',
      targetId: 'dev_old',
      metadata: '{"installationId":"inst_1"}',
      createdAt: '2026-06-30T10:00:00.000Z'
    })

    expect(sqlStatements[0]).toContain('INSERT INTO audit_logs')
    expect(bindings[0]).toEqual([
      'audit_1',
      'user_1',
      'user',
      'device.reconnect',
      'device',
      'dev_old',
      '{"installationId":"inst_1"}',
      '2026-06-30T10:00:00.000Z'
    ])
  })
})
