import { describe, expect, test } from 'vitest'
import { ApiError } from '../../lib/errors'
import {
  createPairingCode,
  createReconnectPairingCodeFromClaim,
  listDeviceAuditLogs,
  listUserDevices,
  parseDeviceNameForm,
  pairDevice,
  renameDevice,
  revokeDevice,
  revokeInstallation,
  revokeUploadToken,
  rotateUploadToken,
  type DevicePairingRepository
} from './service'

function createRepository(overrides: Partial<DevicePairingRepository> = {}) {
  const calls: string[] = []
  const repository: DevicePairingRepository = {
    async findUsablePairingCode(codeHash, now) {
      calls.push(`find:${codeHash}:${now}`)
      return {
        id: 'pair_1',
        userId: 'seed-user',
        pairingType: 'new_device',
        targetDeviceId: null,
        expiresAt: '2026-04-28T10:10:00.000Z',
        consumedAt: null
      }
    },
    async createPairingCode(input) {
      calls.push(
        `pair:${input.userId}:${input.codeHash}:${input.pairingType}:${input.targetDeviceId ?? 'none'}:${input.expiresAt}`
      )
    },
    async ensureDeviceOwnedByUser(userId, deviceId) {
      calls.push(`own:${userId}:${deviceId}`)
      return true
    },
    async findInstallationByClaim(input) {
      calls.push(`claim:${input.deviceId}:${input.installationId}:${input.installClaimHash}`)
      return {
        id: input.installationId,
        userId: 'seed-user',
        deviceId: input.deviceId,
        revokedAt: null
      }
    },
    async rotateInstallationClaim(input) {
      calls.push(
        `rotate-claim:${input.userId}:${input.deviceId}:${input.installationId}:${input.previousInstallClaimHash}:${input.nextInstallClaimHash}`
      )
      return true
    },
    async createUploadTokenAndDevice(input) {
      calls.push(
        `create:${input.userId}:${input.deviceId}:${input.installationId}:${input.installClaimHash}:${input.deviceName}:${input.uploadTokenHash}`
      )
    },
    async createUploadTokenAndInstallation(input) {
      calls.push(
        `install:${input.userId}:${input.deviceId}:${input.installationId}:${input.installClaimHash}:${input.deviceName}:${input.uploadTokenHash}`
      )
    },
    async createAuditLog(input) {
      calls.push(`audit:${input.action}:${input.targetId}`)
    },
    async consumePairingCode(pairingCodeId, consumedAt) {
      calls.push(`consume:${pairingCodeId}:${consumedAt}`)
      return true
    },
    ...overrides
  }

  return { repository, calls }
}

function createTokenSequence(values: string[]) {
  let index = 0
  return () => {
    const value = values[index]
    index += 1
    if (!value) throw new Error('token sequence exhausted')
    return value
  }
}

describe('pairDevice', () => {
  test('creates a short-lived pairing code without storing the plaintext code', async () => {
    const { repository, calls } = createRepository()

    const result = await createPairingCode(repository, 'seed-user', {
      now: () => new Date('2026-04-28T10:00:00.000Z'),
      randomId: () => 'pair_123',
      randomToken: () => 'pairing-token-fixture',
      hash: async (value) => `hash:${value}`
    })

    expect(result).toEqual({
      pairingCode: 'pairing-token-fixture',
      expiresAt: '2026-04-28T10:30:00.000Z'
    })
    expect(calls).toEqual([
      'pair:seed-user:hash:pairing-token-fixture:new_device:none:2026-04-28T10:30:00.000Z'
    ])
  })

  test('creates a reconnect pairing code for an owned device', async () => {
    const { repository, calls } = createRepository()

    const result = await createPairingCode(
      repository,
      'seed-user',
      {
        now: () => new Date('2026-04-28T10:00:00.000Z'),
        randomId: () => 'pair_123',
        randomToken: () => 'pairing-token-fixture',
        hash: async (value) => `hash:${value}`
      },
      10,
      { pairingType: 'reconnect_device', targetDeviceId: 'dev_old' }
    )

    expect(result.expiresAt).toBe('2026-04-28T10:10:00.000Z')
    expect(calls).toEqual([
      'own:seed-user:dev_old',
      'pair:seed-user:hash:pairing-token-fixture:reconnect_device:dev_old:2026-04-28T10:10:00.000Z'
    ])
  })

  test('creates a reconnect pairing code from a valid install claim', async () => {
    const { repository, calls } = createRepository()

    const result = await createReconnectPairingCodeFromClaim(
      repository,
      {
        deviceId: 'dev_old',
        installationId: 'inst_old',
        installClaim: 'claim-fixture'
      },
      {
        now: () => new Date('2026-04-28T10:00:00.000Z'),
        randomId: createTokenSequence(['pair_123', 'audit_123']),
        randomToken: createTokenSequence(['claim-rotated-fixture', 'pairing-token-fixture']),
        hash: async (value) => `hash:${value}`
      },
      10
    )

    expect(result).toEqual({
      pairingCode: 'pairing-token-fixture',
      expiresAt: '2026-04-28T10:10:00.000Z'
    })
    expect(calls).toEqual([
      'claim:dev_old:inst_old:hash:claim-fixture',
      'rotate-claim:seed-user:dev_old:inst_old:hash:claim-fixture:hash:claim-rotated-fixture',
      'own:seed-user:dev_old',
      'pair:seed-user:hash:pairing-token-fixture:reconnect_device:dev_old:2026-04-28T10:10:00.000Z',
      'audit:device.reconnect.claim:dev_old'
    ])
  })

  test('rejects an invalid install claim before creating pairing code', async () => {
    const { repository, calls } = createRepository({
      async findInstallationByClaim(input) {
        calls.push(`claim:${input.deviceId}:${input.installationId}:${input.installClaimHash}`)
        return null
      }
    })

    await expect(
      createReconnectPairingCodeFromClaim(
        repository,
        {
          deviceId: 'dev_old',
          installationId: 'inst_old',
          installClaim: 'claim-fixture'
        },
        {
          now: () => new Date('2026-04-28T10:00:00.000Z'),
          randomId: () => 'pair_123',
          randomToken: () => 'pairing-token-fixture',
          hash: async (value) => `hash:${value}`
        }
      )
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(calls).toEqual(['claim:dev_old:inst_old:hash:claim-fixture'])
  })

  test('rejects replayed install claim before creating pairing code', async () => {
    const { repository, calls } = createRepository({
      async rotateInstallationClaim(input) {
        calls.push(
          `rotate-claim:${input.userId}:${input.deviceId}:${input.installationId}:${input.previousInstallClaimHash}:${input.nextInstallClaimHash}`
        )
        return false
      }
    })

    await expect(
      createReconnectPairingCodeFromClaim(
        repository,
        {
          deviceId: 'dev_old',
          installationId: 'inst_old',
          installClaim: 'claim-fixture'
        },
        {
          now: () => new Date('2026-04-28T10:00:00.000Z'),
          randomId: () => 'pair_123',
          randomToken: () => 'claim-rotated-fixture',
          hash: async (value) => `hash:${value}`
        }
      )
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(calls).toEqual([
      'claim:dev_old:inst_old:hash:claim-fixture',
      'rotate-claim:seed-user:dev_old:inst_old:hash:claim-fixture:hash:claim-rotated-fixture'
    ])
  })

  test('exchanges a pairing code for a one-time upload token and device config', async () => {
    const { repository, calls } = createRepository()

    const result = await pairDevice(
      repository,
      {
        pairingCode: 'dev-pairing-code',
        deviceName: 'Codex Desktop',
        platform: 'windows',
        timezone: 'Asia/Shanghai'
      },
      {
        now: () => '2026-04-28T10:00:00.000Z',
        endpoint: 'https://tokenboard.example.com/api/v1/ingest',
        randomId: () => 'device-fixture',
        randomToken: createTokenSequence(['upload-token-fixture', 'install-claim-fixture']),
        hash: async (value) => `hash:${value}`
      }
    )

    expect(result).toEqual({
      endpoint: 'https://tokenboard.example.com/api/v1/ingest',
      uploadToken: 'upload-token-fixture',
      deviceId: 'dev_device-fixture',
      installationId: 'inst_device-fixture',
      installClaim: 'install-claim-fixture',
      timezone: 'Asia/Shanghai'
    })
    expect(calls).toEqual([
      'find:hash:dev-pairing-code:2026-04-28T10:00:00.000Z',
      'consume:pair_1:2026-04-28T10:00:00.000Z',
      'create:seed-user:dev_device-fixture:inst_device-fixture:hash:install-claim-fixture:Codex Desktop:hash:upload-token-fixture',
      'audit:device.pair:dev_device-fixture'
    ])
  })

  test('exchanges a reconnect pairing code for a new installation on an old device', async () => {
    const { repository, calls } = createRepository({
      async findUsablePairingCode(codeHash, now) {
        calls.push(`find:${codeHash}:${now}`)
        return {
          id: 'pair_1',
          userId: 'seed-user',
          pairingType: 'reconnect_device',
          targetDeviceId: 'dev_old',
          expiresAt: '2026-04-28T10:10:00.000Z',
          consumedAt: null
        }
      }
    })

    const result = await pairDevice(
      repository,
      {
        pairingCode: 'dev-pairing-code',
        deviceName: 'Reinstalled Desktop',
        platform: 'linux',
        timezone: 'Asia/Shanghai'
      },
      {
        now: () => '2026-04-28T10:00:00.000Z',
        endpoint: 'https://tokenboard.example.com/api/v1/ingest',
        randomId: () => 'install-fixture',
        randomToken: createTokenSequence(['upload-token-fixture', 'install-claim-fixture']),
        hash: async (value) => `hash:${value}`
      }
    )

    expect(result).toEqual({
      endpoint: 'https://tokenboard.example.com/api/v1/ingest',
      uploadToken: 'upload-token-fixture',
      deviceId: 'dev_old',
      installationId: 'inst_install-fixture',
      installClaim: 'install-claim-fixture',
      timezone: 'Asia/Shanghai'
    })
    expect(calls).toEqual([
      'find:hash:dev-pairing-code:2026-04-28T10:00:00.000Z',
      'consume:pair_1:2026-04-28T10:00:00.000Z',
      'install:seed-user:dev_old:inst_install-fixture:hash:install-claim-fixture:Reinstalled Desktop:hash:upload-token-fixture',
      'audit:device.reconnect:dev_old'
    ])
  })

  test('rejects an invalid or expired pairing code', async () => {
    const { repository } = createRepository({
      async findUsablePairingCode() {
        return null
      }
    })

    await expect(
      pairDevice(
        repository,
        { pairingCode: 'bad-code' },
        {
          now: () => '2026-04-28T10:00:00.000Z',
          endpoint: 'https://tokenboard.example.com/api/v1/ingest',
          randomId: () => 'device-fixture',
          randomToken: () => 'upload-token-fixture',
          hash: async (value) => `hash:${value}`
        }
      )
    ).rejects.toBeInstanceOf(ApiError)
  })

  test('rejects invalid device timezones before pairing', async () => {
    const { repository } = createRepository({
      async findUsablePairingCode() {
        throw new Error('pairing should not be queried')
      }
    })

    await expect(
      pairDevice(
        repository,
        { pairingCode: 'dev-pairing-code', timezone: 'Mars/Base' },
        {
          now: () => '2026-04-28T10:00:00.000Z',
          endpoint: 'https://tokenboard.example.com/api/v1/ingest',
          randomId: () => 'device-fixture',
          randomToken: () => 'upload-token-fixture',
          hash: async (value) => `hash:${value}`
        }
      )
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  test('rejects a pairing code that was consumed by another request', async () => {
    const { repository } = createRepository({
      async consumePairingCode() {
        return false
      }
    })

    await expect(
      pairDevice(
        repository,
        { pairingCode: 'dev-pairing-code' },
        {
          now: () => '2026-04-28T10:00:00.000Z',
          endpoint: 'https://tokenboard.example.com/api/v1/ingest',
          randomId: () => 'device-fixture',
          randomToken: () => 'upload-token-fixture',
          hash: async (value) => `hash:${value}`
        }
      )
    ).rejects.toBeInstanceOf(ApiError)
  })
})

describe('device management', () => {
  test('lists devices with active token state for one user', async () => {
    const sqlStatements: string[] = []
    const bindings: unknown[][] = []
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        const statementIndex = sqlStatements.length
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
              return {
                async all() {
                  if (statementIndex === 2) {
                    return {
                      results: [
                        {
                          id: 'inst_1',
                          deviceId: 'dev_1',
                          platform: 'windows',
                          hostname: 'Office PC',
                          clientVersion: '0.1.0',
                          firstSeenAt: '2026-04-28T08:00:00.000Z',
                          lastSeenAt: '2026-04-29T08:00:00.000Z',
                          revokedAt: null,
                          activeTokenCount: 1
                        }
                      ]
                    }
                  }
                  if (statementIndex === 3) {
                    return {
                      results: [
                        {
                          id: 'ut_1',
                          deviceId: 'dev_1',
                          installationId: 'inst_1',
                          name: 'Office PC',
                          lastUsedAt: '2026-04-29T08:00:00.000Z',
                          createdAt: '2026-04-28T08:00:00.000Z',
                          revokedAt: null
                        }
                      ]
                    }
                  }
                  return {
                    results: [
                      {
                        id: 'dev_1',
                        name: 'Office PC',
                        platform: 'windows',
                        lastSyncedAt: '2026-04-29T08:00:00.000Z',
                        createdAt: '2026-04-28T08:00:00.000Z',
                        activeTokenCount: 1
                      }
                    ]
                  }
                }
              }
          }
        }
      }
    } as unknown as D1Database

    await expect(listUserDevices(db, 'user_1')).resolves.toEqual([
      {
        id: 'dev_1',
        name: 'Office PC',
        platform: 'windows',
        lastSyncedAt: '2026-04-29T08:00:00.000Z',
        createdAt: '2026-04-28T08:00:00.000Z',
        activeTokenCount: 1,
        installations: [
          {
            id: 'inst_1',
            deviceId: 'dev_1',
            platform: 'windows',
            hostname: 'Office PC',
            clientVersion: '0.1.0',
            firstSeenAt: '2026-04-28T08:00:00.000Z',
            lastSeenAt: '2026-04-29T08:00:00.000Z',
            revokedAt: null,
            activeTokenCount: 1
          }
        ],
        uploadTokens: [
          {
            id: 'ut_1',
            deviceId: 'dev_1',
            installationId: 'inst_1',
            name: 'Office PC',
            lastUsedAt: '2026-04-29T08:00:00.000Z',
            createdAt: '2026-04-28T08:00:00.000Z',
            revokedAt: null
          }
        ]
      }
    ])
    expect(sqlStatements[0]).toContain('LEFT JOIN upload_tokens')
    expect(sqlStatements[0]).toContain('revoked_at IS NULL')
    expect(sqlStatements[1]).toContain('FROM device_installations')
    expect(sqlStatements[2]).toContain('FROM upload_tokens')
    expect(sqlStatements[2]).not.toContain('token_hash')
    expect(bindings[0]).toEqual(['user_1'])
    expect(bindings[1]).toEqual(['user_1'])
    expect(bindings[2]).toEqual(['user_1'])
  })

  test('lists recent audit logs for one device', async () => {
    const sqlStatements: string[] = []
    const bindings: unknown[][] = []
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async all() {
                return {
                  results: [
                    {
                      id: 'audit_1',
                      action: 'device.reconnect',
                      targetType: 'device',
                      targetId: 'dev_1',
                      metadata: '{"installationId":"inst_1"}',
                      createdAt: '2026-04-29T09:00:00.000Z'
                    }
                  ]
                }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await expect(
      listDeviceAuditLogs(db, {
        userId: 'user_1',
        deviceId: 'dev_1',
        limit: 5
      })
    ).resolves.toEqual([
      {
        id: 'audit_1',
        action: 'device.reconnect',
        targetType: 'device',
        targetId: 'dev_1',
        metadata: '{"installationId":"inst_1"}',
        createdAt: '2026-04-29T09:00:00.000Z'
      }
    ])
    expect(sqlStatements[0]).toContain('FROM audit_logs')
    expect(bindings[0]).toEqual(['user_1', 'dev_1', '%"deviceId":"dev_1"%', 5])
  })

  test('renames a device owned by the current user', async () => {
    const sqlStatements: string[] = []
    const bindings: unknown[][] = []
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async run() {
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await renameDevice(db, {
      userId: 'user_1',
      deviceId: 'dev_1',
      name: 'Laptop',
      now: '2026-04-29T09:00:00.000Z'
    })

    expect(sqlStatements[0]).toContain('UPDATE devices')
    expect(bindings[0]).toEqual(['Laptop', '2026-04-29T09:00:00.000Z', 'dev_1', 'user_1'])
    expect(sqlStatements[1]).toContain('INSERT INTO audit_logs')
    expect(bindings[1]?.slice(1)).toEqual([
      'user_1',
      'user',
      'device.rename',
      'device',
      'dev_1',
      '{"name":"Laptop"}',
      '2026-04-29T09:00:00.000Z'
    ])
  })

  test('revokes active upload tokens for a device owned by the current user', async () => {
    const sqlStatements: string[] = []
    const bindings: unknown[][] = []
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async run() {
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await revokeDevice(db, {
      userId: 'user_1',
      deviceId: 'dev_1',
      now: '2026-04-29T09:00:00.000Z'
    })

    expect(sqlStatements[0]).toContain('UPDATE upload_tokens')
    expect(sqlStatements[0]).toContain('revoked_at IS NULL')
    expect(sqlStatements[1]).toContain('UPDATE device_installations')
    expect(sqlStatements[2]).toContain('UPDATE devices')
    expect(sqlStatements[3]).toContain('INSERT INTO audit_logs')
    expect(bindings[0]).toEqual(['2026-04-29T09:00:00.000Z', 'user_1', 'dev_1'])
    expect(bindings[1]).toEqual([
      '2026-04-29T09:00:00.000Z',
      '2026-04-29T09:00:00.000Z',
      'user_1',
      'dev_1'
    ])
    expect(bindings[2]).toEqual(['2026-04-29T09:00:00.000Z', 'dev_1', 'user_1'])
    expect(bindings[3]?.slice(1)).toEqual([
      'user_1',
      'user',
      'device.revoke',
      'device',
      'dev_1',
      '{"deviceId":"dev_1"}',
      '2026-04-29T09:00:00.000Z'
    ])
  })

  test('revokes active upload tokens for one installation', async () => {
    const sqlStatements: string[] = []
    const bindings: unknown[][] = []
    const db = createRunDb(sqlStatements, bindings, {
      firstResults: [{ deviceId: 'dev_1' }]
    })

    await revokeInstallation(db, {
      userId: 'user_1',
      installationId: 'inst_1',
      now: '2026-04-29T09:00:00.000Z'
    })

    expect(sqlStatements[0]).toContain('FROM device_installations')
    expect(sqlStatements[1]).toContain('UPDATE upload_tokens')
    expect(sqlStatements[1]).toContain('installation_id = ?')
    expect(sqlStatements[2]).toContain('UPDATE device_installations')
    expect(sqlStatements[3]).toContain('INSERT INTO audit_logs')
    expect(bindings[0]).toEqual(['inst_1', 'user_1'])
    expect(bindings[1]).toEqual(['2026-04-29T09:00:00.000Z', 'user_1', 'inst_1'])
    expect(bindings[2]).toEqual([
      '2026-04-29T09:00:00.000Z',
      '2026-04-29T09:00:00.000Z',
      'inst_1',
      'user_1'
    ])
    expect(bindings[3]?.slice(1)).toEqual([
      'user_1',
      'user',
      'installation.revoke',
      'device_installation',
      'inst_1',
      '{"deviceId":"dev_1"}',
      '2026-04-29T09:00:00.000Z'
    ])
  })

  test('revokes one upload token without touching its device', async () => {
    const sqlStatements: string[] = []
    const bindings: unknown[][] = []
    const db = createRunDb(sqlStatements, bindings, {
      firstResults: [{ deviceId: 'dev_1', installationId: 'inst_1' }]
    })

    await revokeUploadToken(db, {
      userId: 'user_1',
      uploadTokenId: 'ut_1',
      now: '2026-04-29T09:00:00.000Z'
    })

    expect(sqlStatements).toHaveLength(3)
    expect(sqlStatements[0]).toContain('FROM upload_tokens')
    expect(sqlStatements[1]).toContain('UPDATE upload_tokens')
    expect(sqlStatements[1]).toContain('AND id = ?')
    expect(sqlStatements[2]).toContain('INSERT INTO audit_logs')
    expect(bindings[0]).toEqual(['ut_1', 'user_1'])
    expect(bindings[1]).toEqual(['2026-04-29T09:00:00.000Z', 'user_1', 'ut_1'])
    expect(bindings[2]?.slice(1)).toEqual([
      'user_1',
      'user',
      'token.revoke',
      'upload_token',
      'ut_1',
      '{"deviceId":"dev_1","installationId":"inst_1"}',
      '2026-04-29T09:00:00.000Z'
    ])
  })

  test('rotates one upload token and returns the new token once', async () => {
    const sqlStatements: string[] = []
    const bindings: unknown[][] = []
    const batchStatements: unknown[] = []
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async first() {
                return {
                  name: 'Office PC',
                  deviceId: 'dev_1',
                  installationId: 'inst_1',
                  revokedAt: null
                }
              }
            }
          }
        }
      },
      async batch(statements: unknown[]) {
        batchStatements.push(...statements)
        return statements.map(() => ({ meta: { changes: 1 } }))
      }
    } as unknown as D1Database

    await expect(
      rotateUploadToken(
        db,
        {
          userId: 'user_1',
          uploadTokenId: 'ut_old'
        },
        {
          now: () => '2026-04-29T09:00:00.000Z',
          randomTokenId: () => 'ut_new',
          randomAuditId: () => 'audit_1',
          randomToken: () => 'tb_upload_new',
          randomInstallClaim: () => 'tb_install_new',
          hash: async (value) => `hash:${value}`
        }
      )
    ).resolves.toEqual({
      uploadTokenId: 'ut_new',
      uploadToken: 'tb_upload_new',
      deviceId: 'dev_1',
      installationId: 'inst_1',
      installClaim: 'tb_install_new'
    })

    expect(sqlStatements).toHaveLength(5)
    expect(sqlStatements[0]).toContain('FROM upload_tokens')
    expect(sqlStatements[1]).toContain('INSERT INTO upload_tokens')
    expect(sqlStatements[1]).toContain('supersedes_token_id')
    expect(sqlStatements[2]).toContain('UPDATE upload_tokens')
    expect(sqlStatements[3]).toContain('UPDATE device_installations')
    expect(sqlStatements[3]).toContain('install_claim_hash')
    expect(sqlStatements[4]).toContain('INSERT INTO audit_logs')
    expect(batchStatements).toHaveLength(4)
    expect(bindings[0]).toEqual(['ut_old', 'user_1'])
    expect(bindings[1]).toEqual([
      'ut_new',
      'user_1',
      'Office PC',
      'hash:tb_upload_new',
      'dev_1',
      'inst_1',
      'ut_old',
      '2026-04-29T09:00:00.000Z'
    ])
    expect(bindings[2]).toEqual(['2026-04-29T09:00:00.000Z', 'user_1', 'ut_old'])
    expect(bindings[3]).toEqual([
      'hash:tb_install_new',
      '2026-04-29T09:00:00.000Z',
      'user_1',
      'inst_1'
    ])
    expect(bindings[4]).toEqual([
      'audit_1',
      'user_1',
      'user',
      'token.rotate',
      'upload_token',
      'ut_new',
      '{"previousTokenId":"ut_old","deviceId":"dev_1","installationId":"inst_1"}',
      '2026-04-29T09:00:00.000Z'
    ])
  })

  test('fails token rotation when the old token update no longer matches', async () => {
    const db = createRotateTokenDb({
      batchResults: [
        { meta: { changes: 1 } },
        { meta: { changes: 0 } },
        { meta: { changes: 1 } },
        { meta: { changes: 1 } }
      ]
    })

    await expect(
      rotateUploadToken(db, { userId: 'user_1', uploadTokenId: 'ut_old' }, rotateDeps())
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Upload token is no longer current'
    })
  })

  test('fails token rotation when the installation claim update no longer matches', async () => {
    const db = createRotateTokenDb({
      batchResults: [
        { meta: { changes: 1 } },
        { meta: { changes: 1 } },
        { meta: { changes: 0 } },
        { meta: { changes: 1 } }
      ]
    })

    await expect(
      rotateUploadToken(db, { userId: 'user_1', uploadTokenId: 'ut_old' }, rotateDeps())
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Installation is no longer current'
    })
  })

  test('rejects blank device names from forms', () => {
    expect(() => parseDeviceNameForm({ name: '   ' })).toThrow()
    expect(parseDeviceNameForm({ name: '  Laptop  ' })).toBe('Laptop')
  })
})

function createRunDb(
  sqlStatements: string[],
  bindings: unknown[][],
  options: { firstResults?: unknown[] } = {}
) {
  let firstCallCount = 0
  return {
    prepare(sql: string) {
      sqlStatements.push(sql)
      return {
        bind(...values: unknown[]) {
          bindings.push(values)
          return {
            async run() {
              return { meta: { changes: 1 } }
            },
            async first() {
              const result = options.firstResults?.[firstCallCount] ?? null
              firstCallCount += 1
              return result
            }
          }
        }
      }
    }
  } as unknown as D1Database
}

function rotateDeps() {
  return {
    now: () => '2026-04-29T09:00:00.000Z',
    randomTokenId: () => 'ut_new',
    randomAuditId: () => 'audit_1',
    randomToken: () => 'tb_upload_new',
    randomInstallClaim: () => 'tb_install_new',
    hash: async (value: string) => `hash:${value}`
  }
}

function createRotateTokenDb(options: { batchResults: Array<{ meta: { changes: number } }> }) {
  return {
    prepare() {
      return {
        bind() {
          return {
            async first() {
              return {
                name: 'Office PC',
                deviceId: 'dev_1',
                installationId: 'inst_1',
                revokedAt: null
              }
            }
          }
        }
      }
    },
    async batch() {
      return options.batchResults
    }
  } as unknown as D1Database
}
