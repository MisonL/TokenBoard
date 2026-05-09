import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDefaultSince, readSince } from './sync-options.mjs'

test('buildDefaultSince returns compact local date for the lookback window', () => {
  assert.equal(
    buildDefaultSince({
      now: new Date('2026-05-09T08:00:00.000Z'),
      timezone: 'Asia/Shanghai',
      lookbackDays: 7
    }),
    '20260502'
  )
})

test('readSince prefers CLI flag then environment then config then default', () => {
  assert.equal(
    readSince({
      flags: { since: '20260509' },
      env: { TOKENBOARD_SINCE: '20260508' },
      config: { since: '20260507', timezone: 'Asia/Shanghai' },
      now: new Date('2026-05-09T08:00:00.000Z')
    }),
    '20260509'
  )

  assert.equal(
    readSince({
      flags: {},
      env: { TOKENBOARD_SINCE: '20260508' },
      config: { since: '20260507', timezone: 'Asia/Shanghai' },
      now: new Date('2026-05-09T08:00:00.000Z')
    }),
    '20260508'
  )

  assert.equal(
    readSince({
      flags: {},
      env: {},
      config: { since: '20260507', timezone: 'Asia/Shanghai' },
      now: new Date('2026-05-09T08:00:00.000Z')
    }),
    '20260507'
  )

  assert.equal(
    readSince({
      flags: {},
      env: {},
      config: { timezone: 'Asia/Shanghai' },
      now: new Date('2026-05-09T08:00:00.000Z')
    }),
    '20260502'
  )
})

test('readSince keeps explicit all sentinel', () => {
  assert.equal(
    readSince({
      flags: { since: 'all' },
      env: {},
      config: { timezone: 'Asia/Shanghai' },
      now: new Date('2026-05-09T08:00:00.000Z')
    }),
    'all'
  )
})
