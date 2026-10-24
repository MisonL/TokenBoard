import { createRoute } from 'honox/factory'
import { requireUser } from '../../features/auth/middleware'
import { getProfileTimezoneSettings } from '../../features/settings/service'
import { getUsageDetails } from '../../features/usage/queries'
import { parseUsageDetailsFilters, usageDetailsToCsv } from '../../features/usage/service'

export const GET = createRoute(async (c) => {
  const user = await requireUser(c)
  // The default window is the user's own day, matching the dashboard and the export.
  const { timezone } = await getProfileTimezoneSettings(c.env.DB, user.id)
  const filters = parseUsageDetailsFilters(
    {
      source: c.req.query('source'),
      startDate: c.req.query('startDate'),
      endDate: c.req.query('endDate'),
      device: c.req.query('device'),
      model: c.req.query('model')
    },
    new Date(),
    timezone
  )
  const details = await getUsageDetails(c.env.DB, {
    userId: user.id,
    ...filters
  })
  const filename = `tokenboard-${filters.startDate}-to-${filters.endDate}.csv`

  return c.body(usageDetailsToCsv(details), 200, {
    'content-type': 'text/csv; charset=utf-8',
    // `.csv` is on Cloudflare's default cache-by-extension list, and a response with no
    // Cache-Control can still be cached from it. Two users on the same day with the same
    // default filters produce byte-identical URLs, so the response is per-user data that
    // must never be reused. `private` keeps shared caches out and `no-store` keeps the
    // browser from writing this download to disk.
    'cache-control': 'private, no-store',
    'content-disposition': `attachment; filename="${filename}"`
  })
})
