import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultReleaseRepo } from './client-binary.mjs'
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
