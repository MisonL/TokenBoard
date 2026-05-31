import { decryptSecret } from './crypto'
import { buildWebhookPayload } from './adapters'
import type { WebhookEnv } from './config'
import { requireEncryptionKey } from './config'
import { getDailyTokenReport } from './report-queries'
import type { DueWebhookSubscription } from './queries'

type Fetcher = typeof fetch
const webhookRequestTimeoutMs = 10_000

export async function sendWebhookRequest(input: {
  env: WebhookEnv
  subscription: DueWebhookSubscription
  report: Awaited<ReturnType<typeof getDailyTokenReport>>
  now: Date
  fetcher: Fetcher
}) {
  const encryptionKey = requireEncryptionKey(input.env)
  const payload = await buildWebhookPayload({
    provider: input.subscription.provider,
    webhookUrl: await decryptSecret(input.subscription.webhookUrlEncrypted, encryptionKey),
    signingSecret: input.subscription.signingSecretEncrypted
      ? await decryptSecret(input.subscription.signingSecretEncrypted, encryptionKey)
      : null,
    report: input.report,
    now: input.now
  })
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), webhookRequestTimeoutMs)
  try {
    const response = await input.fetcher(payload.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload.body),
      signal: controller.signal
    })
    const responseText = await safeResponseText(response)
    if (!response.ok) throw new WebhookHttpError(response.status, responseText)
    assertWebhookBusinessResponse(responseText)
    return response
  } finally {
    clearTimeout(timeoutId)
  }
}

export function deliveryHttpStatus(error: unknown) {
  return error instanceof WebhookHttpError ? error.status : null
}

function assertWebhookBusinessResponse(text: string) {
  if (!text.trim()) return
  try {
    const data = JSON.parse(text) as {
      errcode?: number
      code?: number
      StatusCode?: number
      statusCode?: number
      errmsg?: string
      msg?: string
      StatusMessage?: string
      statusMessage?: string
    }
    const code = firstNumber(data.errcode, data.code, data.StatusCode, data.statusCode)
    if (code !== null && code !== 0) {
      throw new Error(`Webhook returned application code ${code}: ${data.errmsg ?? data.msg ?? data.StatusMessage ?? data.statusMessage ?? 'unknown error'}`)
    }
  } catch (error) {
    if (error instanceof SyntaxError) return
    throw error
  }
}

function firstNumber(...values: Array<unknown>) {
  for (const value of values) {
    if (typeof value === 'number') return value
  }
  return null
}

async function safeResponseText(response: Response) {
  try {
    return await response.text()
  } catch (_) {
    return ''
  }
}

class WebhookHttpError extends Error {
  constructor(readonly status: number, body: string) {
    super(`Webhook returned ${status}${body ? `: ${body}` : ''}`)
  }
}
