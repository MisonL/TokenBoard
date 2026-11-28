import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultReleaseRepo } from './client-binary.mjs'
import { parseArgs } from './config.mjs'
import { resolveReleaseFeed } from './release-feed.mjs'

// The feed a binary install records has to outlive the install: every later
// `self-update` resolves it from the config. `mergeConfig` preserves fields a patch
// does not mention, so an explicit switch back to the default must *clear* the stored
// override — recording nothing would silently keep resolving the old feed.

test('nothing explicit resolves the default and touches nothing', () => {
  assert.deepEqual(resolveReleaseFeed({ flags: {}, env: {}, saved: {} }), {
    repo: defaultReleaseRepo,
    baseUrl: undefined,
    patch: {},
    remove: []
  })
})

test('nothing explicit keeps a recorded override', () => {
  assert.deepEqual(
    resolveReleaseFeed({
      flags: {},
      env: {},
      saved: { releaseRepo: 'other/TokenBoard', releaseBaseUrl: 'https://github.example' }
    }),
    {
      repo: 'other/TokenBoard',
      baseUrl: 'https://github.example',
      patch: {},
      remove: []
    }
  )
})

test('an explicit custom feed is resolved and recorded', () => {
  assert.deepEqual(
    resolveReleaseFeed({
      flags: { 'release-repo': 'other/TokenBoard', 'release-base-url': 'https://github.example' },
      env: {},
      saved: {}
    }),
    {
      repo: 'other/TokenBoard',
      baseUrl: 'https://github.example',
      patch: { releaseRepo: 'other/TokenBoard', releaseBaseUrl: 'https://github.example' },
      remove: []
    }
  )
})

// Switching back: the default repository must be usable *and* the override removed,
// or the next self-update resolves the previous mirror again.
test('an explicit default repository switches back and clears the override', () => {
  assert.deepEqual(
    resolveReleaseFeed({
      flags: { 'release-repo': defaultReleaseRepo },
      env: {},
      saved: { releaseRepo: 'other/TokenBoard' }
    }),
    {
      repo: defaultReleaseRepo,
      baseUrl: undefined,
      patch: {},
      remove: ['releaseRepo']
    }
  )
})

test('an explicit empty base URL clears the recorded override', () => {
  assert.deepEqual(
    resolveReleaseFeed({
      flags: { 'release-base-url': '' },
      env: {},
      saved: { releaseRepo: 'other/TokenBoard', releaseBaseUrl: 'https://github.example' }
    }),
    {
      repo: 'other/TokenBoard',
      baseUrl: undefined,
      patch: {},
      remove: ['releaseBaseUrl']
    }
  )
})

// The CLI spelling for a clear is the inline empty value: a two-token
// `--release-base-url ''` parses as a bare flag (the empty next token is falsy), which is
// a usage error, and a bare flag must never silently mean "clear".
test('the inline --release-base-url= spelling reaches the clear path through parseArgs', () => {
  const flags = parseArgs(['--release-base-url='])
  assert.deepEqual(flags, { 'release-base-url': '' })
  const feed = resolveReleaseFeed({ flags, env: {}, saved: { releaseBaseUrl: 'https://github.example' } })
  assert.equal(feed.baseUrl, undefined)
  assert.deepEqual(feed.remove, ['releaseBaseUrl'])
})

// A bare flag is rejected rather than treated as a clear, whichever way it was spelled.
test('the two-token empty spelling is a usage error, not a clear', () => {
  const flags = parseArgs(['--release-base-url', ''])
  assert.deepEqual(flags, { 'release-base-url': true })
  assert.throws(() => resolveReleaseFeed({ flags, env: {}, saved: {} }), /requires a value/)
})

test('environment values count as explicit and are recorded', () => {
  assert.deepEqual(
    resolveReleaseFeed({
      flags: {},
      env: { TOKENBOARD_RELEASE_REPO: 'other/TokenBoard', TOKENBOARD_RELEASE_BASE_URL: 'https://github.example' },
      saved: {}
    }),
    {
      repo: 'other/TokenBoard',
      baseUrl: 'https://github.example',
      patch: { releaseRepo: 'other/TokenBoard', releaseBaseUrl: 'https://github.example' },
      remove: []
    }
  )
})

test('a flag wins over the environment', () => {
  const feed = resolveReleaseFeed({
    flags: { 'release-repo': 'flag/TokenBoard' },
    env: { TOKENBOARD_RELEASE_REPO: 'env/TokenBoard' },
    saved: {}
  })
  assert.equal(feed.repo, 'flag/TokenBoard')
  assert.deepEqual(feed.patch, { releaseRepo: 'flag/TokenBoard' })
})

// A bare `--release-repo` with no value parses as `true`; treating that as "clear"
// would let a typo reset a custom mirror silently.
test('a valueless flag is a usage error, not a silent clear', () => {
  assert.throws(() => resolveReleaseFeed({ flags: { 'release-repo': true }, env: {}, saved: {} }), /requires a value/)
  assert.throws(
    () => resolveReleaseFeed({ flags: { 'release-base-url': true }, env: {}, saved: {} }),
    /requires a value/
  )
})
