import { showRoutes } from 'hono/dev'
import { createApp } from 'honox/server'
import { backfillUsageSummaryCache, usageSummaryBackfillLimit } from './features/ingest/repository'
import { runDueWebhookNotifications } from './features/notifications/service'
import {
  createPublicUsageResponse,
  parsePublicUsagePath,
  publicApiErrorResponse,
  PUBLIC_API_CLIENT_CACHE_CONTROL,
  PUBLIC_API_WORKER_CACHE_CONTROL
} from './features/public-card/http'
import { assertPublicUsageVisible } from './features/public-card/service'
import { usageSummaryStrictMode } from './features/usage/deduped-daily-usage'
import type { Bindings } from './lib/db'

const app = createApp()

showRoutes(app)

export default {
  async fetch(request, env, ctx) {
    const publicResponse = await handlePublicApiRequest(request, env, ctx)
    if (publicResponse) return publicResponse

    const response = await app.fetch(request, env, ctx)
    if (response.status === 404 && shouldFetchStaticAsset(request)) {
      return env.ASSETS?.fetch(request) ?? response
    }
    return response
  },
  scheduled(controller, env, ctx) {
    const now = new Date(controller.scheduledTime)
    ctx.waitUntil(runScheduledTasks(env, now))
  }
} satisfies ExportedHandler<Bindings>

async function handlePublicApiRequest(request: Request, env: Bindings, ctx: ExecutionContext) {
  if (request.method !== 'GET') return null

  try {
    const url = new URL(request.url)
    const route = parsePublicUsagePath(url.pathname)
    if (!route) return null

    const summaryStrict = usageSummaryStrictMode(env)
    const cache = publicApiCache()
    const cacheKey = cache
      ? await publicApiCacheKey(url, route, await assertPublicUsageVisible(env.DB, route.slug), summaryStrict)
      : null
    if (cache && cacheKey) {
      const cached = await cache.match(cacheKey)
      if (cached) return publicApiClientCacheResponse(cached)
    }

    const response = await createPublicUsageResponse({
      db: env.DB,
      route,
      configuredOrigin: env.BETTER_AUTH_URL,
      requestOrigin: url.origin,
      summaryStrict
    })
    if (cache && cacheKey && response.ok) {
      ctx.waitUntil(cache.put(cacheKey, publicApiWorkerCacheResponse(response)))
    }
    return response
  } catch (error) {
    return publicApiErrorResponse(error)
  }
}

async function publicApiCacheKey(
  url: URL,
  route: { slug: string; format: 'json' | 'svg' },
  subject: { userId: string; updatedAt: string; usageUpdatedAt: string; summaryUpdatedAt: string },
  summaryStrict: boolean
) {
  const cacheUrl = new URL(`${url.origin}/api/public/${encodeURIComponent(route.slug)}.${route.format}`)
  cacheUrl.searchParams.set(
    '__tokenboard_public_subject',
    await sha256Hex(
      `${subject.userId}:${subject.updatedAt}:${subject.usageUpdatedAt}:${subject.summaryUpdatedAt}:${summaryStrict ? 'strict' : 'fallback'}`
    )
  )
  return new Request(cacheUrl.toString())
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function publicApiCache() {
  const workerCaches = typeof caches === 'undefined'
    ? null
    : caches as unknown as { default?: Cache }
  return workerCaches?.default ?? null
}

function publicApiWorkerCacheResponse(response: Response) {
  return publicApiCacheControlResponse(response.clone(), PUBLIC_API_WORKER_CACHE_CONTROL)
}

function publicApiClientCacheResponse(response: Response) {
  return publicApiCacheControlResponse(response, PUBLIC_API_CLIENT_CACHE_CONTROL)
}

function publicApiCacheControlResponse(response: Response, cacheControl: string) {
  const headers = new Headers(response.headers)
  headers.set('cache-control', cacheControl)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  })
}

function shouldFetchStaticAsset(request: Request) {
  const { pathname } = new URL(request.url)
  if (pathname.startsWith('/api/')) return false
  return pathname.startsWith('/static/')
    || /\.[a-z0-9][a-z0-9-]*$/i.test(pathname)
}

async function runScheduledTasks(env: Bindings, now: Date) {
  await Promise.all([
    runUsageSummaryBackfill(env),
    runScheduledNotifications(env, now)
  ])
}

async function runScheduledNotifications(env: Bindings, now: Date) {
  try {
    await runDueWebhookNotifications({ env, now })
  } catch (error) {
    console.error(`TokenBoard scheduled notifications failed: ${errorMessage(error)}`)
    throw error
  }
}

async function runUsageSummaryBackfill(env: Bindings) {
  try {
    await backfillUsageSummaryCache({
      db: env.DB,
      limit: usageSummaryBackfillLimit(env)
    })
  } catch (error) {
    console.error(`TokenBoard usage summary backfill failed: ${errorMessage(error)}`)
    throw error
  }
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}
