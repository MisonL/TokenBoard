import assert from 'node:assert/strict'
import test from 'node:test'
import { buildStatus } from './status.mjs'

test('status includes configured schedule times', () => {
  assert.deepEqual(
    buildStatus({
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
      hooks: { notifyHandler: 'installed', codex: 'installed', claudeCode: 'not-installed' },
      deviceLink: {
        path: '/home/user/.tokenboard/device-link.json',
        present: true
      }
    }),
    {
      configured: true,
      configPath: '/home/user/.tokenboard/config.json',
      activeServer: 'https://tokenboard.example',
      endpoint: 'https://tokenboard.example/api/v1/ingest',
      deviceId: 'dev_123',
      installationId: 'inst_123',
      timezone: 'Asia/Shanghai',
      source: 'all',
      packageManager: 'bun',
      collectorDir: '/home/user/.tokenboard/TokenBoard',
      scheduleTimes: ['06:00', '09:00'],
      deviceLink: {
        path: '/home/user/.tokenboard/device-link.json',
        present: true
      },
      hooks: {
        notifyHandler: 'installed',
        codex: 'installed',
        claudeCode: 'not-installed'
      }
    }
  )
})
