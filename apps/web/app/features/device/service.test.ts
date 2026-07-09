import { describe, expect, test, vi } from 'vitest'
import { ApiError } from '../../lib/errors'
import {
  createPairDeviceDeps,
  createPairingCode,
  createReconnectPairingCodeFromClaim,
  listDeviceAuditLogs,
  listLatestDeviceAuditLogs,
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
        metadata: null,
        expiresAt: '2026-04-28T10:10:00.000Z',
        consumedAt: null
      }
    },
    async createPairingCode(input) {
      calls.push(
        `pair:${input.userId}:${input.codeHash}:${input.pairingType}:${input.targetDeviceId ?? 'none'}:${input.expiresAt}`
      )
    },
    async createReconnectPairingCodeExchange(input) {
      calls.push(
        `exchange:${input.userId}:${input.deviceId}:${input.installationId}:${input.previousInstallClaimHash}:${input.codeHash}:${input.expiresAt}:${input.pairingCodeId}:${input.pairingMetadata}:${input.auditLogId}:${input.auditMetadata}`
      )
    },
    async ensureDeviceOwnedByUser(userId, deviceId) {
      calls.push(`own:${userId}:${deviceId}`)
      return true
    },
    async hasActiveInstallationForDevice(userId, deviceId) {
      calls.push(`active:${userId}:${deviceId}`)
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
    async createUploadTokenAndDevice(input) {
      calls.push(
        `create:${input.userId}:${input.deviceId}:${input.installationId}:${input.installClaimHash}:${input.deviceName}:${input.uploadTokenHash}:${input.auditLogId}:${input.auditAction}:${input.auditMetadata}`
      )
    },
    async createUploadTokenAndInstallation(input) {
      calls.push(
        `install:${input.userId}:${input.deviceId}:${input.installationId}:${input.installClaimHash}:${input.deviceName}:${input.uploadTokenHash}:${input.auditLogId}:${input.auditAction}:${input.auditMetadata}:${input.sourceInstallationId ?? 'none'}:${input.sourceInstallClaimHash ?? 'none'}:${input.consumedInstallClaimHash ?? 'none'}`
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
  test('uses separate credential domains for upload tokens and install claims', () => {
    const deps = createPairDeviceDeps('https://tokenboard.example.com/api/v1/ingest')

    expect(deps.randomToken()).toMatch(/^tb_upload_/)
    expect(deps.randomInstallClaim()).toMatch(/^tb_install_/)
  })

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
      'active:seed-user:dev_old',
      'pair:seed-user:hash:pairing-token-fixture:reconnect_device:dev_old:2026-04-28T10:10:00.000Z'
    ])
  })

  test('rejects a reconnect pairing code for a device without active installations', async () => {
    const { repository, calls } = createRepository({
      async hasActiveInstallationForDevice(userId, deviceId) {
        calls.push(`active:${userId}:${deviceId}`)
        return false
      }
    })

    await expect(
      createPairingCode(
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
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(calls).toEqual([
      'own:seed-user:dev_old',
      'active:seed-user:dev_old'
    ])
  })

  test('rejects a reconnect pairing code when the active installation is revoked during creation', async () => {
    const { repository, calls } = createRepository({
      async createPairingCode(input) {
        calls.push(
          `pair:${input.userId}:${input.codeHash}:${input.pairingType}:${input.targetDeviceId ?? 'none'}:${input.expiresAt}`
        )
        throw new Error('Device has no active installation')
      }
    })

    await expect(
      createPairingCode(
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
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(calls).toEqual([
      'own:seed-user:dev_old',
      'active:seed-user:dev_old',
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
        randomToken: createTokenSequence(['pairing-token-fixture']),
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
      'exchange:seed-user:dev_old:inst_old:hash:claim-fixture:hash:pairing-token-fixture:2026-04-28T10:10:00.000Z:pair_123:{"method":"device-link","installationId":"inst_old","installClaimHash":"hash:claim-fixture"}:audit_123:{"installationId":"inst_old"}'
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
      async createReconnectPairingCodeExchange(input) {
        calls.push(
          `exchange:${input.userId}:${input.deviceId}:${input.installationId}:${input.previousInstallClaimHash}:${input.codeHash}:${input.expiresAt}:${input.pairingCodeId}:${input.pairingMetadata}:${input.auditLogId}:${input.auditMetadata}`
        )
        throw new Error('Invalid device link claim')
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
          randomId: createTokenSequence(['pair_123', 'audit_123']),
          randomToken: createTokenSequence(['pairing-token-fixture']),
          hash: async (value) => `hash:${value}`
        }
      )
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(calls).toEqual([
      'claim:dev_old:inst_old:hash:claim-fixture',
      'exchange:seed-user:dev_old:inst_old:hash:claim-fixture:hash:pairing-token-fixture:2026-04-28T10:30:00.000Z:pair_123:{"method":"device-link","installationId":"inst_old","installClaimHash":"hash:claim-fixture"}:audit_123:{"installationId":"inst_old"}'
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
        randomToken: () => 'upload-token-fixture',
        randomInstallClaim: () => 'install-claim-fixture',
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
      'create:seed-user:dev_device-fixture:inst_device-fixture:hash:install-claim-fixture:Codex Desktop:hash:upload-token-fixture:audit_device-fixture:device.pair:{"installationId":"inst_device-fixture","platform":"windows"}'
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
          metadata: null,
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
        randomToken: () => 'upload-token-fixture',
        randomInstallClaim: () => 'install-claim-fixture',
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
      'install:seed-user:dev_old:inst_install-fixture:hash:install-claim-fixture:Reinstalled Desktop:hash:upload-token-fixture:audit_install-fixture:device.reconnect:{"installationId":"inst_install-fixture","platform":"linux"}:none:none:none'
    ])
  })

  test('passes source claim metadata when exchanging a device-link reconnect pairing code', async () => {
    const { repository, calls } = createRepository({
      async findUsablePairingCode(codeHash, now) {
        calls.push(`find:${codeHash}:${now}`)
        return {
          id: 'pair_1',
          userId: 'seed-user',
          pairingType: 'reconnect_device',
          targetDeviceId: 'dev_old',
          metadata: '{"installationId":"inst_old","installClaimHash":"hash:old-claim"}',
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
        randomToken: () => 'upload-token-fixture',
        randomInstallClaim: createTokenSequence(['install-claim-fixture', 'source-claim-consumed']),
        hash: async (value) => `hash:${value}`
      }
    )

    expect(result.installClaim).toBe('install-claim-fixture')
    expect(calls).toEqual([
      'find:hash:dev-pairing-code:2026-04-28T10:00:00.000Z',
      'consume:pair_1:2026-04-28T10:00:00.000Z',
      'install:seed-user:dev_old:inst_install-fixture:hash:install-claim-fixture:Reinstalled Desktop:hash:upload-token-fixture:audit_install-fixture:device.reconnect:{"installationId":"inst_install-fixture","platform":"linux"}:inst_old:hash:old-claim:hash:source-claim-consumed'
    ])
  })

  test('rejects legacy device-link reconnect metadata without a source claim hash', async () => {
    const { repository, calls } = createRepository({
      async findUsablePairingCode(codeHash, now) {
        calls.push(`find:${codeHash}:${now}`)
        return {
          id: 'pair_1',
          userId: 'seed-user',
          pairingType: 'reconnect_device',
          targetDeviceId: 'dev_old',
          metadata: '{"method":"device-link","installationId":"inst_old"}',
          expiresAt: '2026-04-28T10:10:00.000Z',
          consumedAt: null
        }
      }
    })

    await expect(
      pairDevice(
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
          randomToken: () => 'upload-token-fixture',
          randomInstallClaim: () => 'install-claim-fixture',
          hash: async (value) => `hash:${value}`
        }
      )
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'Invalid or expired pairing code'
    })
    expect(calls).toEqual([
      'find:hash:dev-pairing-code:2026-04-28T10:00:00.000Z'
    ])
  })

  test('maps inactive reconnect targets during pairing to an API error', async () => {
    const { repository, calls } = createRepository({
      async findUsablePairingCode(codeHash, now) {
        calls.push(`find:${codeHash}:${now}`)
        return {
          id: 'pair_1',
          userId: 'seed-user',
          pairingType: 'reconnect_device',
          targetDeviceId: 'dev_old',
          metadata: null,
          expiresAt: '2026-04-28T10:10:00.000Z',
          consumedAt: null
        }
      },
      async createUploadTokenAndInstallation(input) {
        calls.push(`install:${input.userId}:${input.deviceId}:${input.installationId}`)
        throw new Error('Reconnect target is no longer active')
      }
    })

    await expect(
      pairDevice(
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
          randomToken: () => 'upload-token-fixture',
          randomInstallClaim: () => 'install-claim-fixture',
          hash: async (value) => `hash:${value}`
        }
      )
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Device has no active installation'
    })
    expect(calls).toEqual([
      'find:hash:dev-pairing-code:2026-04-28T10:00:00.000Z',
      'consume:pair_1:2026-04-28T10:00:00.000Z',
      'install:seed-user:dev_old:inst_install-fixture'
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
          randomInstallClaim: () => 'install-claim-fixture',
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
          randomInstallClaim: () => 'install-claim-fixture',
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
          randomInstallClaim: () => 'install-claim-fixture',
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
    expect(sqlStatements[0]).toContain('CASE')
    expect(sqlStatements[0]).toContain('json_valid(metadata)')
    expect(sqlStatements[0]).toContain("json_extract(metadata, '$.deviceId')")
    expect(bindings[0]).toEqual(['user_1', 'dev_1', 'dev_1', 5])
  })

  test('lists latest audit logs for many devices with one query', async () => {
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
                      deviceId: 'dev_1',
                      id: 'audit_1',
                      action: 'device.reconnect',
                      targetType: 'device',
                      targetId: 'dev_1',
                      metadata: '{"installationId":"inst_1"}',
                      createdAt: '2026-04-29T09:00:00.000Z'
                    },
                    {
                      deviceId: 'dev_2',
                      id: 'audit_2',
                      action: 'token.rotate',
                      targetType: 'upload_token',
                      targetId: 'ut_2',
                      metadata: '{"deviceId":"dev_2"}',
                      createdAt: '2026-04-29T10:00:00.000Z'
                    }
                  ]
                }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const logsByDevice = await listLatestDeviceAuditLogs(db, {
      userId: 'user_1',
      deviceIds: ['dev_1', 'dev_2', 'dev_1', '']
    })

    expect(sqlStatements).toHaveLength(1)
    expect(sqlStatements[0]).toContain('WITH requested(device_id) AS')
    expect(sqlStatements[0]).toContain('ROW_NUMBER() OVER')
    expect(sqlStatements[0]).toContain("json_extract(metadata, '$.deviceId')")
    expect(bindings[0]).toEqual(['dev_1', 'dev_2', 'user_1'])
    expect(logsByDevice.get('dev_1')).toEqual([
      {
        id: 'audit_1',
        action: 'device.reconnect',
        targetType: 'device',
        targetId: 'dev_1',
        metadata: '{"installationId":"inst_1"}',
        createdAt: '2026-04-29T09:00:00.000Z'
      }
    ])
    expect(logsByDevice.get('dev_2')).toEqual([
      {
        id: 'audit_2',
        action: 'token.rotate',
        targetType: 'upload_token',
        targetId: 'ut_2',
        metadata: '{"deviceId":"dev_2"}',
        createdAt: '2026-04-29T10:00:00.000Z'
      }
    ])
  })

  test('chunks latest audit log queries under the D1 bind limit', async () => {
    const d1BindLimit = 100
    const deviceCount = d1BindLimit + 1
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
                return { results: [] }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await listLatestDeviceAuditLogs(db, {
      userId: 'user_1',
      deviceIds: Array.from({ length: deviceCount }, (_, index) => `dev_${index + 1}`)
    })

    const firstBindings = bindings[0]
    const secondBindings = bindings[1]
    expect(sqlStatements).toHaveLength(2)
    expect(bindings.every((values) => values.length <= d1BindLimit)).toBe(true)
    expect(bindings.map((values) => values.length)).toEqual([d1BindLimit, 3])
    expect(firstBindings[firstBindings.length - 1]).toBe('user_1')
    expect(secondBindings[secondBindings.length - 1]).toBe('user_1')
    expect(firstBindings.slice(0, 3)).toEqual(['dev_1', 'dev_2', 'dev_3'])
    expect(secondBindings.slice(0, -1)).toEqual(['dev_100', 'dev_101'])
  })

  test('skips latest audit log query when device list is empty', async () => {
    const db = {
      prepare() {
        throw new Error('unexpected query')
      }
    } as unknown as D1Database

    await expect(
      listLatestDeviceAuditLogs(db, {
        userId: 'user_1',
        deviceIds: []
      })
    ).resolves.toEqual(new Map())
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
                  installClaimHash: 'hash:tb_install_old',
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
    expect(sqlStatements[1]).toContain('INSERT OR IGNORE INTO upload_tokens')
    expect(sqlStatements[1]).toContain('supersedes_token_id')
    expect(sqlStatements[1]).toContain('SELECT')
    expect(sqlStatements[1]).toContain('source.revoked_at IS NULL')
    expect(sqlStatements[1]).toContain('NOT EXISTS')
    expect(sqlStatements[2]).toContain('UPDATE upload_tokens')
    expect(sqlStatements[2]).toContain('replacement.id = ?')
    expect(sqlStatements[3]).toContain('UPDATE device_installations')
    expect(sqlStatements[3]).toContain('install_claim_hash')
    expect(sqlStatements[3]).toContain('OR install_claim_hash = ?')
    expect(sqlStatements[3]).toContain('previous.revoked_at = ?')
    expect(sqlStatements[4]).toContain('INSERT INTO audit_logs')
    expect(sqlStatements[4]).toContain('WHERE EXISTS')
    expect(batchStatements).toHaveLength(4)
    expect(bindings[0]).toEqual(['ut_old', 'user_1'])
    expect(bindings[1]).toEqual([
      'ut_new',
      'hash:tb_upload_new',
      '2026-04-29T09:00:00.000Z',
      'user_1',
      'ut_old'
    ])
    expect(bindings[2]).toEqual(['2026-04-29T09:00:00.000Z', 'user_1', 'ut_old', 'ut_new'])
    expect(bindings[3]).toEqual([
      'hash:tb_install_new',
      '2026-04-29T09:00:00.000Z',
      'user_1',
      'inst_1',
      'hash:tb_install_old',
      'hash:tb_install_old',
      'ut_new',
      'ut_old',
      '2026-04-29T09:00:00.000Z'
    ])
    expect(bindings[4]).toEqual([
      'audit_1',
      'user_1',
      'user',
      'token.rotate',
      'upload_token',
      'ut_new',
      '{"previousTokenId":"ut_old","deviceId":"dev_1","installationId":"inst_1"}',
      '2026-04-29T09:00:00.000Z',
      'user_1',
      'ut_new',
      'ut_old',
      '2026-04-29T09:00:00.000Z',
      'hash:tb_install_new',
      'hash:tb_install_new'
    ])
  })

  test('fails token rotation before revoking the old token when replacement insert no longer matches', async () => {
    const db = createRotateTokenDb({
      batchResults: [
        { meta: { changes: 0 } },
        { meta: { changes: 1 } },
        { meta: { changes: 1 } },
        { meta: { changes: 1 } }
      ]
    })

    await expect(
      rotateUploadToken(db, { userId: 'user_1', uploadTokenId: 'ut_old' }, rotateDeps())
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Upload token already has an active successor'
    })
    expect(db.cleanupBindings).toEqual([])
  })

  test('revokes a failed replacement token when the old token update no longer matches', async () => {
    const db = createRotateTokenDb({
      batchResults: [
        { meta: { changes: 1 } },
        { meta: { changes: 0 } },
        { meta: { changes: 0 } },
        { meta: { changes: 0 } }
      ]
    })

    await expect(
      rotateUploadToken(db, { userId: 'user_1', uploadTokenId: 'ut_old' }, rotateDeps())
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Previous upload token is no longer current'
    })
    expect(db.cleanupBindings).toEqual([
      ['2026-04-29T09:00:00.000Z', 'user_1', 'ut_new', 'ut_old'],
      [
        'hash:tb_install_old',
        '2026-04-29T09:00:00.000Z',
        'user_1',
        'inst_1',
        'hash:tb_install_new',
        'ut_new',
        'ut_old'
      ],
      ['user_1', 'ut_old', '2026-04-29T09:00:00.000Z', 'ut_new', '2026-04-29T09:00:00.000Z'],
      ['audit_1', 'user_1', 'token.rotate', 'upload_token', 'ut_new', '2026-04-29T09:00:00.000Z']
    ])
    expect(db.cleanupBatchSizes).toEqual([4])
  })

  test('revokes a failed replacement token when the installation claim update no longer matches', async () => {
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
    expect(db.cleanupBindings).toEqual([
      ['2026-04-29T09:00:00.000Z', 'user_1', 'ut_new', 'ut_old'],
      [
        'hash:tb_install_old',
        '2026-04-29T09:00:00.000Z',
        'user_1',
        'inst_1',
        'hash:tb_install_new',
        'ut_new',
        'ut_old'
      ],
      ['user_1', 'ut_old', '2026-04-29T09:00:00.000Z', 'ut_new', '2026-04-29T09:00:00.000Z'],
      ['audit_1', 'user_1', 'token.rotate', 'upload_token', 'ut_new', '2026-04-29T09:00:00.000Z']
    ])
  })

  test('fails visibly and cleans up when token rotation changes are not reported', async () => {
    const db = createRotateTokenDb({
      batchResults: [
        { meta: {} },
        { meta: { changes: 1 } },
        { meta: { changes: 1 } },
        { meta: { changes: 1 } }
      ]
    })

    await expect(
      rotateUploadToken(db, { userId: 'user_1', uploadTokenId: 'ut_old' }, rotateDeps())
    ).rejects.toThrow('D1 batch statement did not report changes: Upload token already has an active successor')
    expect(db.cleanupBindings).toEqual([
      ['2026-04-29T09:00:00.000Z', 'user_1', 'ut_new', 'ut_old'],
      [
        'hash:tb_install_old',
        '2026-04-29T09:00:00.000Z',
        'user_1',
        'inst_1',
        'hash:tb_install_new',
        'ut_new',
        'ut_old'
      ],
      ['user_1', 'ut_old', '2026-04-29T09:00:00.000Z', 'ut_new', '2026-04-29T09:00:00.000Z'],
      ['audit_1', 'user_1', 'token.rotate', 'upload_token', 'ut_new', '2026-04-29T09:00:00.000Z']
    ])
  })

  test('preserves the original token rotation error when cleanup fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = createRotateTokenDb({
      batchResults: [
        { meta: { changes: 1 } },
        { meta: { changes: 0 } },
        { meta: { changes: 0 } },
        { meta: { changes: 0 } }
      ],
      failCleanupRun: true
    })

    try {
      await expect(
        rotateUploadToken(db, { userId: 'user_1', uploadTokenId: 'ut_old' }, rotateDeps())
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: 'Previous upload token is no longer current'
      })
      expect(consoleError).toHaveBeenCalledWith('TokenBoard token rotation cleanup failed: cleanup failed')
    } finally {
      consoleError.mockRestore()
    }
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

function createRotateTokenDb(options: {
  batchResults: Array<{ meta?: { changes?: number } }>
  failCleanupRun?: boolean
}): D1Database & { cleanupBindings: unknown[][], cleanupBatchSizes: number[] } {
  const cleanupBindings: unknown[][] = []
  const cleanupBatchSizes: number[] = []
  let batchCallCount = 0
  return {
    cleanupBindings,
    cleanupBatchSizes,
    prepare() {
      return {
        bind(...values: unknown[]) {
          return {
            bindings: values,
            async run() {
              cleanupBindings.push(values)
              if (options.failCleanupRun) {
                throw new Error('cleanup failed')
              }
              return { meta: { changes: 1 } }
            },
            async first() {
              return {
                name: 'Office PC',
                deviceId: 'dev_1',
                installationId: 'inst_1',
                installClaimHash: 'hash:tb_install_old',
                revokedAt: null
              }
            }
          }
        }
      }
    },
    async batch(statements: Array<{ bindings?: unknown[] }>) {
      batchCallCount += 1
      if (batchCallCount > 1) {
        cleanupBatchSizes.push(statements.length)
        for (const statement of statements) {
          cleanupBindings.push(statement.bindings ?? [])
        }
        if (options.failCleanupRun) {
          throw new Error('cleanup failed')
        }
        return statements.map(() => ({ meta: { changes: 1 } }))
      }
      return options.batchResults
    }
  } as unknown as D1Database & { cleanupBindings: unknown[][], cleanupBatchSizes: number[] }
}
