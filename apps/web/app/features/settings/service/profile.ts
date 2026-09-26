import { ApiError } from '../../../lib/errors'
import { defaultTimezone, normalizeTimezone } from '../../../lib/timezone'
import { parsePublicCardConfig, stringifyPublicCardConfig } from '../../public-card/config'
import { isReservedPublicSlug } from '../../public-card/service/slug'
import { publicProfileSchema, type PublicProfileInput } from '../schema'
import {
  profileTimezoneSource,
  type ProfileDisplayNameRow,
  type ProfilePageInput,
  type ProfileRow,
  type ProfileSettings,
  type ProfileTimezoneRow,
  type ProfileTimezoneSettings
} from './types'

export async function getProfileSettings(db: D1Database, userId: string, origin: string): Promise<ProfileSettings> {
  const row = await db
    .prepare(
      `
        SELECT
          user_id as userId,
          slug,
          display_name as displayName,
          timezone,
          COALESCE(timezone_source, 'default') as timezoneSource,
          public_card_config as publicCardConfig,
          is_public as isPublic,
          participates_in_leaderboards as participatesInLeaderboards,
          created_at as createdAt,
          updated_at as updatedAt
        FROM profiles
        WHERE user_id = ?
        LIMIT 1
      `
    )
    .bind(userId)
    .first<ProfileRow>()

  if (!row) {
    throw new ApiError('NOT_FOUND', 'Profile not found', 404)
  }

  return toProfileSettings(row, origin)
}

export async function getProfileTimezoneSettings(db: D1Database, userId: string): Promise<ProfileTimezoneSettings> {
  const row = await db
    .prepare(
      `
        SELECT
          user_id as userId,
          timezone,
          COALESCE(timezone_source, 'default') as timezoneSource
        FROM profiles
        WHERE user_id = ?
        LIMIT 1
      `
    )
    .bind(userId)
    .first<ProfileTimezoneRow>()

  if (!row) {
    throw new ApiError('NOT_FOUND', 'Profile not found', 404)
  }

  return toProfileTimezoneSettings(row)
}

export async function getProfileDisplayName(db: D1Database, userId: string, fallback?: string | null) {
  const row = await db
    .prepare('SELECT display_name as displayName FROM profiles WHERE user_id = ? LIMIT 1')
    .bind(userId)
    .first<ProfileDisplayNameRow>()

  const displayName = row?.displayName?.trim()
  return displayName || fallback || undefined
}

export async function updateProfileSettings(
  db: D1Database,
  userId: string,
  input: PublicProfileInput,
  now = new Date().toISOString()
) {
  await assertSlugAvailable(db, input.slug, userId)

  const isPublic = input.isPublic || input.participatesInLeaderboards

  const written = db
    .prepare(
      `
        UPDATE profiles
        SET
          slug = ?,
          display_name = ?,
          timezone = ?,
          timezone_source = 'user',
          is_public = ?,
          participates_in_leaderboards = ?,
          updated_at = ?
        WHERE user_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM profiles AS conflict
            WHERE conflict.slug = ? AND conflict.user_id <> ?
          )
      `
    )
    .bind(
      input.slug,
      input.displayName,
      input.timezone,
      isPublic ? 1 : 0,
      input.participatesInLeaderboards ? 1 : 0,
      now,
      userId,
      input.slug,
      userId
    )

  await runSlugUpdate(db, written, userId, input.slug)
}

export async function updateProfilePageSettings(
  db: D1Database,
  userId: string,
  input: ProfilePageInput,
  now = new Date().toISOString()
) {
  await assertSlugAvailable(db, input.profile.slug, userId)

  const isPublic = input.profile.isPublic || input.profile.participatesInLeaderboards
  const cardConfig = input.publicCardConfig ? stringifyPublicCardConfig(input.publicCardConfig) : null

  const written = db
    .prepare(
      `
        UPDATE profiles
        SET
          slug = ?,
          display_name = ?,
          timezone = ?,
          timezone_source = 'user',
          public_card_config = ?,
          is_public = ?,
          participates_in_leaderboards = ?,
          updated_at = ?
        WHERE user_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM profiles AS conflict
            WHERE conflict.slug = ? AND conflict.user_id <> ?
          )
      `
    )
    .bind(
      input.profile.slug,
      input.profile.displayName,
      input.profile.timezone,
      cardConfig,
      isPublic ? 1 : 0,
      input.profile.participatesInLeaderboards ? 1 : 0,
      now,
      userId,
      input.profile.slug,
      userId
    )

  await runSlugUpdate(db, written, userId, input.profile.slug)
}

// The pre-check above is a courtesy that produces a clean message in the common case.
// It cannot be the guarantee: two users can pass it simultaneously and both proceed to
// write. The UPDATE carries the same condition in its WHERE, so the loser changes no row
// — that zero-row result is the real conflict signal, and it must not be mistaken for a
// successful save. D1 serialises writes, so the loser's statement sees the winner's row
// and the UNIQUE index on `profiles.slug` should not fire; it is caught here anyway so
// that if it ever does, the caller gets the same conflict answer instead of a 500.
async function runSlugUpdate(
  db: D1Database,
  statement: { run(): Promise<{ meta?: { changes?: number } }> },
  userId: string,
  slug: string
) {
  let result: { meta?: { changes?: number } }
  try {
    result = await statement.run()
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      throw new ApiError('BAD_REQUEST', 'Slug is already taken', 400)
    }
    throw error
  }

  if ((result.meta?.changes ?? 0) > 0) return

  // Zero changed rows has two causes, and they call for different answers. Either another
  // user holds the slug (the `NOT EXISTS` guard excluded the row, or a concurrent writer
  // won the race), or there is no profile row for this user at all. Reporting the second
  // as a slug conflict sends the caller to edit a slug that was never the problem, so the
  // cause is looked up rather than assumed. A failed lookup must not turn a real conflict
  // into a 500, so it falls back to the conflict answer.
  const takenByAnother = await slugHeldByAnother(db, userId, slug)
  if (takenByAnother) {
    throw new ApiError('BAD_REQUEST', 'Slug is already taken', 400)
  }
  throw new ApiError('NOT_FOUND', 'Profile not found', 404)
}

async function slugHeldByAnother(db: D1Database, userId: string, slug: string) {
  try {
    const conflict = await db
      .prepare('SELECT user_id as userId FROM profiles WHERE slug = ? AND user_id <> ? LIMIT 1')
      .bind(slug, userId)
      .first<{ userId: string }>()
    return Boolean(conflict)
  } catch {
    return true
  }
}

function isUniqueConstraintViolation(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return /unique constraint|UNIQUE constraint failed/i.test(message)
}

async function assertSlugAvailable(db: D1Database, slug: string, userId: string) {
  if (isReservedPublicSlug(slug)) {
    throw new ApiError('BAD_REQUEST', 'Slug is reserved', 400)
  }

  const conflict = await db
    .prepare('SELECT user_id as userId FROM profiles WHERE slug = ? AND user_id <> ? LIMIT 1')
    .bind(slug, userId)
    .first<{ userId: string }>()

  if (conflict) {
    throw new ApiError('BAD_REQUEST', 'Slug is already taken', 400)
  }
}

function toProfileSettings(row: ProfileRow, origin: string): ProfileSettings {
  const { profile, needsRepair } = normalizePublicProfileRow(row)
  const publicSvgUrl = `${origin}/api/public/${profile.slug}.svg`

  return {
    ...profile,
    publicCardConfig: parsePublicCardConfig(row.publicCardConfig),
    shouldUseBrowserTimezoneDefault:
      profile.timezone === defaultTimezone &&
      (row.timezoneSource ?? profileTimezoneSource.default) === profileTimezoneSource.default,
    profileNeedsRepair: needsRepair,
    publicJsonUrl: `${origin}/api/public/${profile.slug}.json`,
    publicSvgUrl,
    publicMarkdown: `[![TokenBoard](${publicSvgUrl})](${origin})`
  }
}

function toProfileTimezoneSettings(row: ProfileTimezoneRow): ProfileTimezoneSettings {
  const timezone = normalizeTimezone(row.timezone)
  return {
    timezone,
    shouldUseBrowserTimezoneDefault:
      timezone === defaultTimezone &&
      (row.timezoneSource ?? profileTimezoneSource.default) === profileTimezoneSource.default,
    profileNeedsRepair: timezone !== row.timezone
  }
}

function normalizePublicProfileRow(row: ProfileRow) {
  const rawProfile = {
    slug: row.slug,
    displayName: row.displayName,
    timezone: row.timezone,
    isPublic: Boolean(row.isPublic),
    participatesInLeaderboards: Boolean(row.participatesInLeaderboards)
  }
  const normalizedProfile = {
    ...rawProfile,
    slug: normalizeStoredSlug(row.slug, row.displayName, row.userId),
    displayName: normalizeDisplayName(row.displayName),
    timezone: normalizeTimezone(row.timezone)
  }

  return {
    profile: publicProfileSchema.parse(normalizedProfile),
    needsRepair:
      !publicProfileSchema.safeParse(rawProfile).success ||
      rawProfile.slug !== normalizedProfile.slug ||
      rawProfile.displayName !== normalizedProfile.displayName ||
      rawProfile.timezone !== normalizedProfile.timezone
  }
}

function normalizeDisplayName(value: unknown) {
  const trimmed = String(value ?? '').trim()
  return (trimmed || 'TokenBoard User').slice(0, 80)
}

function normalizeStoredSlug(slug: unknown, displayName: unknown, userId: unknown) {
  const candidates = [slug, displayName, userId].map(slugCandidate)
  const userCandidate = candidates[2]

  return (
    candidates.find((candidate) => candidate.length >= 3 && !isReservedPublicSlug(candidate))?.slice(0, 32) ??
    (userCandidate ? `user-${userCandidate}`.slice(0, 32) : 'user-profile')
  )
}

function slugCandidate(value: unknown) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
