import assert from 'node:assert/strict'
import test from 'node:test'
import { applyRotatedToken } from './rotate-token.mjs'

test('applies a rotated token to the matching server profile only', () => {
  const writes = []
  const deviceLinks = []
  const nextConfig = applyRotatedToken({
    currentConfig: {
      activeServer: 'https://prod.example.com',
      servers: {
        'https://prod.example.com': {
          endpoint: 'https://prod.example.com/api/v1/ingest',
          uploadToken: 'prod-old',
          deviceId: 'dev_prod',
          installationId: 'inst_prod',
          timezone: 'UTC'
        },
        'https://private.example.com': {
          endpoint: 'https://private.example.com/api/v1/ingest',
          uploadToken: 'private-token',
          deviceId: 'dev_private',
          installationId: 'inst_private',
          timezone: 'Asia/Shanghai'
        }
      }
    },
    serverOrigin: 'https://prod.example.com',
    uploadToken: 'prod-new',
    deviceId: 'dev_prod',
    installationId: 'inst_prod',
    installClaim: 'claim-new',
    writeConfigFn: (config) => writes.push(config),
    writeDeviceLinkFn: (link) => deviceLinks.push(link)
  })

  assert.equal(nextConfig.uploadToken, 'prod-new')
  assert.equal(nextConfig.servers['https://prod.example.com'].uploadToken, 'prod-new')
  assert.equal(nextConfig.servers['https://prod.example.com'].installClaim, 'claim-new')
  assert.equal(nextConfig.servers['https://private.example.com'].uploadToken, 'private-token')
  assert.equal(writes.length, 1)
  assert.deepEqual(deviceLinks, [
    {
      serverOrigin: 'https://prod.example.com',
      deviceId: 'dev_prod',
      installationId: 'inst_prod',
      installClaim: 'claim-new'
    }
  ])
})

test('keeps the active server when rotating a saved inactive profile', () => {
  const writes = []
  const nextConfig = applyRotatedToken({
    currentConfig: {
      activeServer: 'https://prod.example.com',
      endpoint: 'https://prod.example.com/api/v1/ingest',
      uploadToken: 'prod-old',
      deviceId: 'dev_prod',
      installationId: 'inst_prod',
      timezone: 'UTC',
      servers: {
        'https://prod.example.com': {
          endpoint: 'https://prod.example.com/api/v1/ingest',
          uploadToken: 'prod-old',
          deviceId: 'dev_prod',
          installationId: 'inst_prod',
          timezone: 'UTC'
        },
        'https://private.example.com': {
          endpoint: 'https://private.example.com/api/v1/ingest',
          uploadToken: 'private-old',
          deviceId: 'dev_private',
          installationId: 'inst_private',
          timezone: 'Asia/Shanghai'
        }
      }
    },
    serverOrigin: 'https://private.example.com',
    uploadToken: 'private-new',
    deviceId: 'dev_private',
    installationId: 'inst_private',
    installClaim: null,
    writeConfigFn: (config) => writes.push(config),
    writeDeviceLinkFn: () => {}
  })

  assert.equal(nextConfig.activeServer, 'https://prod.example.com')
  assert.equal(nextConfig.endpoint, 'https://prod.example.com/api/v1/ingest')
  assert.equal(nextConfig.uploadToken, 'prod-old')
  assert.equal(nextConfig.deviceId, 'dev_prod')
  assert.equal(nextConfig.installationId, 'inst_prod')
  assert.equal(nextConfig.servers['https://private.example.com'].uploadToken, 'private-new')
  assert.equal(nextConfig.servers['https://prod.example.com'].uploadToken, 'prod-old')
  assert.deepEqual(writes, [nextConfig])
})

test('rejects a server origin that is not present in config', () => {
  assert.throws(
    () =>
      applyRotatedToken({
        currentConfig: {
          activeServer: 'https://prod.example.com',
          servers: {
            'https://prod.example.com': {
              endpoint: 'https://prod.example.com/api/v1/ingest',
              uploadToken: 'prod-old',
              deviceId: 'dev_prod',
              installationId: 'inst_prod'
            }
          }
        },
        serverOrigin: 'https://private.example.com',
        uploadToken: 'private-new',
        deviceId: 'dev_private',
        installationId: 'inst_private',
        installClaim: 'claim-new',
        writeConfigFn: () => {},
        writeDeviceLinkFn: () => {}
      }),
    /does not contain this server profile/
  )
})

test('updates legacy active config when profiles are not present', () => {
  const writes = []
  const nextConfig = applyRotatedToken({
    currentConfig: {
      activeServer: 'https://prod.example.com',
      endpoint: 'https://prod.example.com/api/v1/ingest',
      uploadToken: 'prod-old',
      deviceId: 'dev_prod',
      installationId: 'inst_prod',
      timezone: 'UTC'
    },
    serverOrigin: 'https://prod.example.com',
    uploadToken: 'prod-new',
    deviceId: 'dev_prod',
    installationId: 'inst_prod',
    installClaim: null,
    writeConfigFn: (config) => writes.push(config),
    writeDeviceLinkFn: () => {
      throw new Error('device link should not be written without install claim')
    }
  })

  assert.equal(nextConfig.uploadToken, 'prod-new')
  assert.equal(nextConfig.servers['https://prod.example.com'].uploadToken, 'prod-new')
  assert.equal(writes.length, 1)
})

test('updates legacy config by endpoint origin when active server is absent', () => {
  const nextConfig = applyRotatedToken({
    currentConfig: {
      endpoint: 'https://prod.example.com/api/v1/ingest',
      uploadToken: 'prod-old',
      deviceId: 'dev_prod',
      installationId: 'inst_prod',
      timezone: 'UTC'
    },
    serverOrigin: 'https://prod.example.com',
    uploadToken: 'prod-new',
    deviceId: 'dev_prod',
    installationId: 'inst_prod',
    installClaim: null,
    writeConfigFn: () => {},
    writeDeviceLinkFn: () => {
      throw new Error('device link should not be written without install claim')
    }
  })

  assert.equal(nextConfig.activeServer, 'https://prod.example.com')
  assert.equal(nextConfig.uploadToken, 'prod-new')
  assert.equal(nextConfig.servers['https://prod.example.com'].uploadToken, 'prod-new')
})
