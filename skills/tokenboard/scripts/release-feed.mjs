import { defaultReleaseRepo } from './client-binary.mjs'

// resolveReleaseFeed decides which release feed an install uses and what the config
// should record for later `self-update` runs.
//
// A feed supplied explicitly — by flag or environment — wins over the stored override
// and is persisted exactly. Switching back to the default repository is an explicit
// action too: it removes the stored override rather than recording nothing, because a
// config that keeps the old override would silently resolve the previous feed forever
// (`mergeConfig` preserves fields a patch does not mention). An empty value means
// "use the default", which for the base URL means "clear it" — the default feed is
// addressed by the repository alone.
//
// With nothing explicit, the stored override (or the default) is used and the config
// is left untouched, so a plain re-install keeps the current feed.
export function resolveReleaseFeed({ flags = {}, env = process.env, saved = {} } = {}) {
  const repoInput = flags['release-repo'] !== undefined ? flags['release-repo'] : env.TOKENBOARD_RELEASE_REPO
  const baseInput =
    flags['release-base-url'] !== undefined ? flags['release-base-url'] : env.TOKENBOARD_RELEASE_BASE_URL
  const explicitRepo = repoInput !== undefined
  const explicitBase = baseInput !== undefined
  const requestedRepo = feedValue(repoInput, '--release-repo')
  const requestedBase = feedValue(baseInput, '--release-base-url')

  const repo = explicitRepo ? requestedRepo || defaultReleaseRepo : saved.releaseRepo || defaultReleaseRepo
  const baseUrl = explicitBase ? requestedBase || undefined : saved.releaseBaseUrl || undefined

  const patch = {}
  const remove = []
  if (explicitRepo) {
    if (requestedRepo && requestedRepo !== defaultReleaseRepo) patch.releaseRepo = requestedRepo
    else remove.push('releaseRepo')
  }
  if (explicitBase) {
    if (requestedBase) patch.releaseBaseUrl = requestedBase
    else remove.push('releaseBaseUrl')
  }
  return { repo, baseUrl, patch, remove }
}

// A bare `--release-repo` with no value parses as `true`. Treating that as "clear the
// feed" would let a typo reset a custom mirror silently, so it is a usage error.
function feedValue(value, flagName) {
  if (value === undefined) return ''
  if (typeof value !== 'string') throw new Error(`${flagName} requires a value`)
  return value.trim()
}
