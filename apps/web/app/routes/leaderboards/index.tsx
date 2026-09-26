import { createRoute } from 'honox/factory'
import { AppNav } from '../../components/app-nav'
import { getOptionalUser } from '../../features/auth/middleware'
import { LeaderboardPanel } from '../../features/leaderboards/components/leaderboard-panel'
import { leaderboardMetricSchema, leaderboardPeriodSchema } from '../../features/leaderboards/schema'
import { getLeaderboard } from '../../features/leaderboards/service'
import { leaderboardDocumentTitle } from '../../features/leaderboards/title'
import { resolveViewerTimezone } from '../../features/leaderboards/viewer-timezone'

export default createRoute(async (c) => {
  const user = await getOptionalUser(c)
  const period = leaderboardPeriodSchema.catch('daily').parse(c.req.query('period'))
  const metric = leaderboardMetricSchema.catch('tokens').parse(c.req.query('metric'))
  // The board is public, so an anonymous viewer has no profile: their browser's own zone is
  // what their "today" means, and it is already in the cookie the client sets. Resolved through
  // the shared helper so this route and the fragment it swaps in cannot disagree about the day.
  const timezone = await resolveViewerTimezone({
    db: c.env.DB,
    userId: user?.id ?? null,
    cookieHeader: c.req.header('cookie')
  })
  const view = await getLeaderboard(c.env.DB, { period, metric }, new Date(), c.env, timezone)

  return c.render(
    <main class="min-h-screen bg-[var(--app-bg)] px-4 py-4 text-[var(--app-text)] sm:px-5 sm:py-6">
      <title>{leaderboardDocumentTitle({ period, metric })}</title>
      <AppNav active="leaderboards" email={user?.email} isAuthenticated={Boolean(user)} />
      <LeaderboardPanel
        entries={view.entries}
        period={view.period}
        metric={view.metric}
        rangeLabel={view.rangeLabel}
        timezone={view.timezone}
        timezoneLabel={view.timezoneLabel}
      />
    </main>
  )
})
