import assert from 'node:assert/strict'
import test from 'node:test'
import { buildInitialSyncArgs } from './setup-options.mjs'

test('initial setup sync uses a full history scan by default', () => {
  assert.deepEqual(
    buildInitialSyncArgs({ flags: {} }),
    ['--mode', 'sync', '--source', 'all', '--since', 'all']
  )
})

test('initial setup sync forwards an explicit since value', () => {
  assert.deepEqual(
    buildInitialSyncArgs({ flags: { since: '20260501' } }),
    ['--mode', 'sync', '--source', 'all', '--since', '20260501']
  )
})
