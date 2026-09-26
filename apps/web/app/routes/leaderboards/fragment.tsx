import { createRoute } from 'honox/factory'
import { LeaderboardPanel } from '../../features/leaderboards/components/leaderboard-panel'
import { leaderboardMetricSchema, leaderboardPeriodSchema } from '../../features/leaderboards/schema'
import { getLeaderboard } from '../../features/leaderboards/service'
import { resolveViewerTimezone } from '../../features/leaderboards/viewer-timezone'
import { getOptionalUser } from '../../features/auth/middleware'
import { jsonError } from '../../lib/http'

export const GET = createRoute(async (c) => {
  try {
    const period = leaderboardPeriodSchema.catch('daily').parse(c.req.query('period'))
    const metric = leaderboardMetricSchema.catch('tokens').parse(c.req.query('metric'))
    // The fetch carries the session cookie when there is one, so this route resolves the zone
    // exactly as the full page does. Reading only the browser cookie here made a user who had
    // set their zone by hand see one day's board on load and another's after clicking a tab.
    const user = await getOptionalUser(c)
    const timezone = await resolveViewerTimezone({
      db: c.env.DB,
      userId: user?.id ?? null,
      cookieHeader: c.req.header('cookie')
    })
    const view = await getLeaderboard(c.env.DB, { period, metric }, new Date(), c.env, timezone)

    return c.html(
      <LeaderboardPanel
        entries={view.entries}
        period={view.period}
        metric={view.metric}
        rangeLabel={view.rangeLabel}
        timezone={view.timezone}
        timezoneLabel={view.timezoneLabel}
      />
    )
  } catch (error) {
    return jsonError(c, error)
  }
})
