import assert from 'node:assert/strict'
import test from 'node:test'
import { assertSupportedNodeVersion, isSupportedNodeVersion, minimumNodeRange } from './node-version.mjs'

// The floor is the security floor, not the functional one: `node:sqlite` and
// `zstdDecompress` only need 22.15, but Node 22 below 22.23.4 and Node 24 below
// 24.22.1 carry the Brotli out-of-bounds write (CVE-2026-111497) and the TLS
// hostname-verification bypasses, and the collector sends the upload token over
// TLS. Node 23 and 25 are EOL and are excluded by the range rather than by a
// separate list.
test('accepts the first patched release of each supported line and anything newer', () => {
  for (const version of ['22.23.4', '22.24.0', '24.22.1', '24.99.0', '26.12.1', '26.13.0', '27.0.0']) {
    assert.equal(isSupportedNodeVersion(version), true, `${version} should be supported`)
  }
})

test('rejects unpatched and end-of-life lines', () => {
  for (const version of ['20.20.2', '22.18.0', '22.23.3', '23.11.1', '24.22.0', '25.9.0', '26.12.0']) {
    assert.equal(isSupportedNodeVersion(version), false, `${version} should be rejected`)
  }
})

test('rejects input that is not a Node version', () => {
  for (const version of ['', 'v', 'latest', '22', '22.23', '22.23.4-rc.1', undefined, null]) {
    assert.equal(isSupportedNodeVersion(version), false, `${String(version)} should be rejected`)
  }
})

test('accepts the process.versions.node shape that Node itself reports', () => {
  // process.versions.node never carries the `v` prefix, but `node --version` does.
  assert.equal(isSupportedNodeVersion('v24.22.1'), true)
  assert.equal(isSupportedNodeVersion('v22.18.0'), false)
})

test('the refusal names the current version, the requirement, and the fix', () => {
  assert.throws(
    () => assertSupportedNodeVersion('22.18.0'),
    (error) => {
      assert.match(error.message, /22\.18\.0/, 'the message must name the version actually running')
      assert.match(error.message, /\^22\.23\.4/, 'the message must state the requirement')
      assert.match(error.message, /upgrade Node/i)
      return true
    }
  )
})

test('the supported floor is stated once so every caller and the docs agree', () => {
  assert.equal(minimumNodeRange, '^22.23.4 || ^24.22.1 || >=26.12.1')
  assert.doesNotThrow(() => assertSupportedNodeVersion('24.22.1'))
})
