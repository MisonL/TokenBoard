import assert from 'node:assert/strict'
import test from 'node:test'
import { deviceLinkPath, deviceLinkStatus, readDeviceLink, writeDeviceLink } from './device-link.mjs'

test('writes device-link.json with private file mode', () => {
  const writes = []
  const mkdirs = []
  const files = new Map()
  const fs = {
    mkdirSync(path, options) {
      mkdirs.push({ path, options })
    },
    writeFileSync(path, value, options) {
      writes.push({ path, value, options })
      files.set(path, value)
    },
    existsSync(path) {
      return files.has(path)
    },
    readFileSync(path) {
      return files.get(path)
    }
  }

  const path = writeDeviceLink(
    {
      serverOrigin: 'https://tokenboard.example',
      deviceId: 'dev_1',
      installationId: 'inst_1',
      installClaim: 'claim-secret'
    },
    { configDir: '/home/user/.tokenboard', fs }
  )

  assert.equal(path, '/home/user/.tokenboard/device-link.json')
  assert.deepEqual(mkdirs, [{ path: '/home/user/.tokenboard', options: { recursive: true } }])
  assert.equal(writes[0].options.mode, 0o600)
  assert.deepEqual(readDeviceLink({ path, fs }), {
    version: 1,
    serverOrigin: 'https://tokenboard.example',
    deviceId: 'dev_1',
    installationId: 'inst_1',
    installClaim: 'claim-secret'
  })
})

test('reports only device link presence and path', () => {
  assert.deepEqual(
    deviceLinkStatus({
      path: '/home/user/.tokenboard/device-link.json',
      fs: { existsSync: () => true }
    }),
    {
      path: '/home/user/.tokenboard/device-link.json',
      present: true
    }
  )
})

test('builds device link path under config directory', () => {
  assert.equal(deviceLinkPath('/tmp/tokenboard'), '/tmp/tokenboard/device-link.json')
})
