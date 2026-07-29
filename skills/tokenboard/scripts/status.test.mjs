import assert from 'node:assert/strict'
import test from 'node:test'
import { buildStatus } from './status.mjs'

test('status reports health without exposing local configuration identities or paths', () => {
  const status = buildStatus({
    configPath: '/home/user/.tokenboard/config.json',
    config: {
      activeServer: 'https://tokenboard.example',
      endpoint: 'https://tokenboard.example/api/v1/ingest',
      deviceId: 'dev_123',
      installationId: 'inst_123',
      timezone: 'Asia/Shanghai',
      source: 'all',
      packageManager: 'bun',
      collectorDir: '/home/user/.tokenboard/TokenBoard',
      scheduleTimes: ['06:00', '09:00']
    },
    hooks: {
      notifyPath: '/home/user/.tokenboard/bin/notify.cjs',
      notifyHandler: 'installed',
      codex: 'installed',
      claudeCode: 'not-installed',
      antigravityCli: 'installed',
      antigravityIde: 'installed-local-history',
      antigravity: 'installed-local-history',
      diagnostic: { privateValue: 'secret' }
    },
    deviceLink: {
      path: '/home/user/.tokenboard/device-link.json',
      present: true
    }
  })

  assert.deepEqual(status, {
    configured: true,
    activeServerConfigured: true,
    collectorConfigured: true,
    deviceIdentityConfigured: true,
    deviceLinkPresent: true,
    timezone: 'Asia/Shanghai',
    source: 'all',
    packageManager: 'bun',
    scheduleTimes: ['06:00', '09:00'],
    hooks: {
      notifyHandler: 'installed',
      codex: 'installed',
      claudeCode: 'not-installed',
      antigravityCli: 'installed',
      antigravityIde: 'installed-local-history',
      antigravity: 'installed-local-history'
    }
  })
  const serialized = JSON.stringify(status)
  for (const privateValue of [
    'https://tokenboard.example',
    'dev_123',
    'inst_123',
    '/home/user/.tokenboard',
    'secret'
  ]) {
    assert.equal(serialized.includes(privateValue), false)
  }
})

test('status exposes scheduled retry progress without the private error detail', () => {
  const status = buildStatus({
    configPath: '/home/user/.tokenboard/config.json',
    config: {},
    hooks: {},
    deviceLink: {},
    scheduledRetry: {
      status: 'deferred',
      retryAttempt: 2,
      maxAttempts: 5,
      updatedAt: '2026-07-29T09:00:00.000Z',
      nextRetryAt: '2026-07-29T09:01:00.000Z',
      error: 'Timed out waiting for TokenBoard sync lock: /home/user/.tokenboard/sync.lock'
    }
  })

  assert.deepEqual(status.scheduledRetry, {
    status: 'deferred',
    retryAttempt: 2,
    maxAttempts: 5,
    updatedAt: '2026-07-29T09:00:00.000Z',
    nextRetryAt: '2026-07-29T09:01:00.000Z'
  })
  assert.equal(JSON.stringify(status).includes('/home/user/.tokenboard'), false)
})
