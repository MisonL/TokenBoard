import { showRoutes } from 'hono/dev'
import { createApp } from 'honox/server'
import { runDueWebhookNotifications } from './features/notifications/service'
import type { Bindings } from './lib/db'

const app = createApp()

showRoutes(app)

export default {
  fetch: app.fetch,
  scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduledNotifications(env, new Date(controller.scheduledTime)))
  }
} satisfies ExportedHandler<Bindings>

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
