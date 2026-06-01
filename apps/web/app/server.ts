import { showRoutes } from 'hono/dev'
import { createApp } from 'honox/server'
import { runDueWebhookNotifications } from './features/notifications/service'
import {
  createPublicUsageResponse,
  parsePublicUsagePath,
  publicApiErrorResponse
} from './features/public-card/http'
import type { Bindings } from './lib/db'

const app = createApp()

showRoutes(app)

export default {
  async fetch(request, env, ctx) {
    const publicResponse = await handlePublicApiRequest(request, env)
    if (publicResponse) return publicResponse

    const response = await app.fetch(request, env, ctx)
    if (response.status === 404 && shouldFetchStaticAsset(request)) {
      return env.ASSETS?.fetch(request) ?? response
    }
    return response
  },
  scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduledNotifications(env, new Date(controller.scheduledTime)))
  }
} satisfies ExportedHandler<Bindings>

async function handlePublicApiRequest(request: Request, env: Bindings) {
  if (request.method !== 'GET') return null

  try {
    const url = new URL(request.url)
    const route = parsePublicUsagePath(url.pathname)
    if (!route) return null

    return await createPublicUsageResponse({
      db: env.DB,
      route,
      configuredOrigin: env.BETTER_AUTH_URL,
      requestOrigin: url.origin
    })
  } catch (error) {
    return publicApiErrorResponse(error)
  }
}

function shouldFetchStaticAsset(request: Request) {
  const { pathname } = new URL(request.url)
  if (pathname.startsWith('/api/')) return false
  return pathname.startsWith('/static/')
    || /\.[a-z0-9][a-z0-9-]*$/i.test(pathname)
}

async function runScheduledNotifications(env: Bindings, now: Date) {
  try {
    await runDueWebhookNotifications({ env, now })
  } catch (error) {
    console.error(`TokenBoard scheduled notifications failed: ${errorMessage(error)}`)
    throw error
  }
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}
