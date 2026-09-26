import { ApiError } from '../../lib/errors'
import { getCanonicalPublicOrigin } from '../settings/service'
import { getPublicUsageCard, getPublicUsageJson } from './service'
import { isReservedPublicSlug } from './service/slug'

export type PublicUsageRoute = {
  slug: string
  format: 'json' | 'svg'
}

export const PUBLIC_API_CLIENT_CACHE_CONTROL = 'public, max-age=0, must-revalidate'
export const PUBLIC_API_WORKER_CACHE_CONTROL = 'public, max-age=300'

export function parsePublicUsagePath(pathname: string) {
  const match = pathname.match(/^\/api\/public\/([^/]+)$/)
  if (!match) return null
  return parsePublicUsageSegment(match[1])
}

export function parsePublicUsageSegment(value: string): PublicUsageRoute {
  const rawSlug = decodePathSegment(value)
  let slug = rawSlug
  let format: PublicUsageRoute['format'] = 'json'

  if (rawSlug.endsWith('.svg')) {
    slug = rawSlug.slice(0, -4)
    format = 'svg'
  } else if (rawSlug.endsWith('.json')) {
    slug = rawSlug.slice(0, -5)
  }

  if (slug.includes('.')) {
    throw new ApiError('NOT_FOUND', 'Public route not found', 404)
  }

  if (isReservedPublicSlug(slug)) {
    throw new ApiError('NOT_FOUND', 'Public route not found', 404)
  }
  return { slug, format }
}

export async function createPublicUsageResponse(input: {
  db: D1Database
  route: PublicUsageRoute
  configuredOrigin?: string
  requestOrigin: string
  now?: Date
  summaryStrict?: boolean
}) {
  if (input.route.format === 'svg') {
    const origin = getCanonicalPublicOrigin({
      configuredOrigin: input.configuredOrigin,
      requestOrigin: input.requestOrigin
    })
    const svg = await getPublicUsageCard(
      input.db,
      input.route.slug,
      input.now ?? new Date(),
      origin,
      input.summaryStrict
    )
    return new Response(svg, {
      status: 200,
      headers: {
        'content-type': 'image/svg+xml; charset=utf-8',
        'cache-control': PUBLIC_API_CLIENT_CACHE_CONTROL
      }
    })
  }

  const data = await getPublicUsageJson(input.db, input.route.slug, input.now ?? new Date(), input.summaryStrict)
  return Response.json(data, {
    status: 200,
    headers: { 'cache-control': PUBLIC_API_CLIENT_CACHE_CONTROL }
  })
}

// Errors carry `no-store`, matching `model-pricing/http.ts`. Two reasons: a failure is not a
// representation of the resource, so nothing should hold on to it, and without a directive a
// browser may cache the 404 heuristically — which would keep serving "not found" for a slug
// after its owner made the profile public. A route that already set its own policy keeps it.
export function publicApiErrorResponse(error: unknown) {
  if (error instanceof ApiError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status, headers: { 'cache-control': 'no-store', ...error.headers } }
    )
  }

  return Response.json(
    { error: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' } },
    { status: 500, headers: { 'cache-control': 'no-store' } }
  )
}

function decodePathSegment(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new ApiError('NOT_FOUND', 'Public route not found', 404)
  }
}
