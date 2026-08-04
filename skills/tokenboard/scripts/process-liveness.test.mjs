import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { currentProcessStartIdentity, probeProcessStartIdentity } from './process-liveness.mjs'

function linuxStat(startTicks) {
  const fields = Array.from({ length: 19 }, (_, index) => index === 18 ? String(startTicks) : String(index + 1))
  return `123 (node) S ${fields.join(' ')}\n`
}

test('Linux process identity includes the system boot ID', () => {
  const files = new Map([
    ['/proc/123/stat', linuxStat(456789)],
    ['/proc/sys/kernel/random/boot_id', '01234567-89ab-cdef-0123-456789abcdef\n']
  ])

  assert.deepEqual(
    probeProcessStartIdentity(123, {
      platform: 'linux',
      readFile: (path) => files.get(path)
    }),
    { status: 'known', value: 'linux:01234567-89ab-cdef-0123-456789abcdef:456789' }
  )
})

test('Linux process identity is unknown when the boot ID cannot be read', () => {
  assert.deepEqual(
    probeProcessStartIdentity(123, {
      platform: 'linux',
      readFile: (path) => path === '/proc/123/stat' ? linuxStat(456789) : (() => {
        const error = new Error('boot id unavailable')
        error.code = 'EACCES'
        throw error
      })()
    }),
    { status: 'unknown' }
  )
})

test('unknown process identity is not converted into a comparable fallback marker', () => {
  assert.equal(
    currentProcessStartIdentity({
      pid: 123,
      readProcessStartIdentity: () => ({ status: 'unknown' })
    }),
    undefined
  )
})

test('external process identity probes use a non-catchable timeout signal', () => {
  const calls = []
  const runProcessIdentity = (command, args, options) => {
    calls.push({ command, args, options })
    return { status: 1, stdout: '', stderr: '' }
  }

  assert.deepEqual(
    probeProcessStartIdentity(123, { platform: 'darwin', runProcessIdentity }),
    { status: 'dead' }
  )
  assert.deepEqual(
    probeProcessStartIdentity(456, { platform: 'win32', runProcessIdentity }),
    { status: 'unknown' }
  )
  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.equal(call.options.timeout, 2_000)
    assert.equal(call.options.killSignal, 'SIGKILL')
  }
})

test('process identity probe returns when the helper ignores termination', { skip: process.platform === 'win32' }, () => {
  const startedAt = Date.now()
  const result = probeProcessStartIdentity(123, {
    platform: 'darwin',
    runProcessIdentity: (_command, _args, options) => spawnSync(
      process.execPath,
      ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
      options
    )
  })

  assert.deepEqual(result, { status: 'unknown' })
  assert.ok(Date.now() - startedAt < 3_500)
})
