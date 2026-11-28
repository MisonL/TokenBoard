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

// A tag is never recorded — it pins one install — so the only decisions are "use this
// tag" and "use the latest release". An explicit empty value means latest; a bare flag
// or whitespace would silently mean the same thing, so those are usage errors.
export function resolveReleaseTag({ flags = {}, env = process.env } = {}) {
  const raw = flags['release-tag'] !== undefined ? flags['release-tag'] : env.TOKENBOARD_RELEASE_TAG
  if (raw === undefined) return undefined
  if (typeof raw !== 'string') throw new Error('--release-tag requires a value')
  const tag = raw.trim()
  if (!tag && raw !== '') throw new Error('--release-tag value is blank')
  return tag || undefined
}

// A pre-flight for callers that must refuse bad feed input before doing anything with
// side effects (setup pairs a device — which consumes the pairing code — before the
// installer runs). It validates the spellings and the client they belong to, and returns
// nothing: the real resolution happens where the install is recorded.
export function assertReleaseInputs({ flags = {}, clientType, env = process.env } = {}) {
  const present = ['release-repo', 'release-tag', 'release-base-url'].filter((name) => flags[name] !== undefined)
  if (present.length > 0 && clientType !== 'binary') {
    throw new Error(
      `Release feed flags apply only to the binary client: ${present.map((name) => `--${name}`).join(', ')}. ` +
        'Pass --client binary to install the released client.'
    )
  }
  resolveReleaseFeed({ flags, env, saved: {} })
  resolveReleaseTag({ flags, env })
}

// A bare `--release-repo` with no value parses as `true`. Treating that as "clear the
// feed" would let a typo reset a custom mirror silently, so it is a usage error. A
// whitespace-only value gets the same treatment: only the exact empty string (the
// inline `--name=` spelling) expresses "clear".
function feedValue(value, flagName) {
  if (value === undefined) return ''
  if (typeof value !== 'string') throw new Error(`${flagName} requires a value`)
  const trimmed = value.trim()
  if (!trimmed && value !== '') throw new Error(`${flagName} value is blank`)
  return trimmed
}
