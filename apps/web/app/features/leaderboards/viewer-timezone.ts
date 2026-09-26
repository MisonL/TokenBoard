import { getProfileTimezoneSettings } from '../settings/service'
import { ApiError } from '../../lib/errors'
import { defaultTimezone, readTimezoneCookie } from '../../lib/timezone'

/**
 * The zone a leaderboard's day boundary is measured in.
 *
 * The board spans users, so it has no owner zone to attribute by; the boundary follows the
 * *viewer*. Both routes that render a board — the full page and the fragment it swaps in — must
 * answer this identically, because a viewer can reach the same board either way and the two used
 * to disagree: the page read the signed-in user's profile zone while the fragment always read
 * the browser cookie. A user who had set their zone by hand therefore got one day's ranking on
 * load and a different day's the moment they clicked a tab.
 *
 * A signed-in user's stored zone wins, because that is the zone their own dashboard and public
 * card already report in. An anonymous viewer has no profile, and their browser's zone — which
 * the client already writes to a cookie — is what "today" means to them.
 */
export async function resolveViewerTimezone(input: {
  db: D1Database
  userId: string | null
  cookieHeader: string | null | undefined
}): Promise<string> {
  const cookieTimezone = readTimezoneCookie(input.cookieHeader) ?? defaultTimezone
  if (!input.userId) return cookieTimezone

  // `getOptionalUser` does not create a profile, so a signed-in visitor can legitimately have no
  // row yet — only `requireUser` ensures one. That lookup throws NOT_FOUND, which surfaced as a
  // 404 on a public page. The cookie zone is a correct answer for that visitor, not a degraded
  // one: it is the zone their dashboard would be created with. Only that absence is absorbed: a
  // database failure is not an absence, and swallowing it would rank the board in a zone nobody
  // chose while the real fault stayed invisible.
  const profile = await getProfileTimezoneSettings(input.db, input.userId).catch((error) => {
    if (error instanceof ApiError && error.code === 'NOT_FOUND') return null
    throw error
  })
  return profile?.timezone ?? cookieTimezone
}
