import { createRoute } from 'honox/factory'
import { requireSessionUser } from '../../../../features/auth/middleware'
import { parsePublicCardConfig } from '../../../../features/public-card/config'
import { renderUsageCardSvg } from '../../../../features/public-card/svg'
import { ApiError } from '../../../../lib/errors'
import { jsonError } from '../../../../lib/http'

export const POST = createRoute(async (c) => {
  try {
    await requireSessionUser(c)
    // `c.req.json()` returns `null` for a literal `null` body and throws on malformed JSON.
    // Dereferencing a null body would raise a TypeError that lands on the 500 path; the client
    // sent a bad request, so reject it as one.
    const body = await c.req.json<Record<string, unknown> | null>()
    if (body === null || typeof body !== 'object') {
      throw new ApiError('BAD_REQUEST', 'Invalid request body')
    }
    const config = parsePublicCardConfig(body.config)
    const displayName = String(body.displayName || 'TokenBoard').slice(0, 80)
    const publicUrl = String(body.publicUrl || 'Private preview').slice(0, 160)

    const svg = renderUsageCardSvg(
      {
        displayName,
        publicUrl,
        totalTokens: 1234567,
        totalTokensWithoutCacheRead: 345678,
        totalCostUsd: 42.5,
        monthTokens: 89012,
        monthTokensWithoutCacheRead: 45678,
        monthCostUsd: 6.78,
        todayTokens: 1200,
        todayTokensWithoutCacheRead: 860,
        todayCostUsd: 0.2
      },
      config
    )

    return new Response(svg, {
      headers: {
        'content-type': 'image/svg+xml; charset=utf-8',
        'cache-control': 'no-store'
      }
    })
  } catch (error) {
    return jsonError(c, error)
  }
})
