import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeActiveServerConfig,
  packageManagerCommand,
  serverOriginFromEndpoint,
  stripUtf8Bom,
  withServerProfile
} from './config.mjs'

test('strips UTF-8 BOM before parsing config content', () => {
  const parsed = JSON.parse(stripUtf8Bom('\ufeff{"configured":true}'))

  assert.deepEqual(parsed, { configured: true })
})

test('leaves non-BOM config content unchanged', () => {
  const config = '{"configured":true}'

  assert.equal(stripUtf8Bom(config), config)
})

test('uses bun.exe on Windows package manager commands', () => {
  assert.equal(packageManagerCommand('bun', 'win32'), 'bun.exe')
})

test('uses executable package manager commands on Windows when available', () => {
  assert.equal(packageManagerCommand('pnpm', 'win32'), 'pnpm.exe')
  assert.equal(packageManagerCommand('npm', 'win32'), 'npm.cmd')
})

test('extracts server origin from ingest endpoint', () => {
  assert.equal(
    serverOriginFromEndpoint('https://tokenboard.example.com/api/v1/ingest'),
    'https://tokenboard.example.com'
  )
})

test('writes active server profile while preserving other server credentials', () => {
  const config = withServerProfile(
    {
      activeServer: 'https://prod.example.com',
      servers: {
        'https://prod.example.com': {
          endpoint: 'https://prod.example.com/api/v1/ingest',
          uploadToken: 'prod-token',
          deviceId: 'dev_prod',
          installationId: 'inst_prod',
          timezone: 'UTC'
        }
      }
    },
    'https://private.example.com',
    {
      endpoint: 'https://private.example.com/api/v1/ingest',
      uploadToken: 'private-token',
      deviceId: 'dev_private',
      installationId: 'inst_private',
      timezone: 'Asia/Shanghai'
    }
  )

  assert.equal(config.activeServer, 'https://private.example.com')
  assert.equal(config.uploadToken, 'private-token')
  assert.equal(config.installationId, 'inst_private')
  assert.equal(config.servers['https://prod.example.com'].uploadToken, 'prod-token')
})

test('normalizes config by mirroring the active server profile', () => {
  const config = normalizeActiveServerConfig({
    activeServer: 'https://prod.example.com',
    servers: {
      'https://prod.example.com': {
        endpoint: 'https://prod.example.com/api/v1/ingest',
        uploadToken: 'prod-token',
        deviceId: 'dev_prod',
        installationId: 'inst_prod',
        timezone: 'UTC'
      }
    },
    endpoint: 'https://stale.example.com/api/v1/ingest',
    uploadToken: 'stale-token'
  })

  assert.equal(config.endpoint, 'https://prod.example.com/api/v1/ingest')
  assert.equal(config.uploadToken, 'prod-token')
  assert.equal(config.installationId, 'inst_prod')
})
