import { z } from 'zod'
import { isValidTimezone } from '../../lib/timezone'

export const webhookProviderSchema = z.enum(['wecom', 'dingtalk', 'feishu'])

export const webhookScheduleTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

export const webhookSubscriptionFormSchema = z.object({
  name: z.string().trim().min(1).max(80),
  provider: webhookProviderSchema,
  webhookUrl: z.string().trim().url().max(2048),
  signingSecret: z.string().trim().max(256).optional(),
  timezone: z.string().trim().min(1).max(80).refine(isValidTimezone, 'Invalid timezone'),
  scheduleTimeLocal: webhookScheduleTimeSchema,
  sendEmptyReport: z.boolean(),
  enabled: z.boolean()
})

export type WebhookProvider = z.infer<typeof webhookProviderSchema>
export type WebhookSubscriptionForm = z.infer<typeof webhookSubscriptionFormSchema>

export type WebhookSubscriptionSummary = {
  id: string
  name: string
  provider: WebhookProvider
  webhookUrlHost: string
  webhookUrlMasked: string
  timezone: string
  scheduleTimeLocal: string
  sendEmptyReport: boolean
  enabled: boolean
  nextRunAt: string
  pendingReportDate: string | null
  failureCount: number
  lastSuccessAt: string | null
  lastFailureAt: string | null
  lastError: string | null
  createdAt: string
  updatedAt: string
}

export type ClaimedWebhookSubscription = WebhookSubscriptionSummary & {
  lockedAt: string | null
}

export function parseWebhookSubscriptionForm(form: Record<string, unknown>): WebhookSubscriptionForm {
  return webhookSubscriptionFormSchema.parse({
    name: String(form.name ?? ''),
    provider: String(form.provider ?? ''),
    webhookUrl: String(form.webhookUrl ?? ''),
    signingSecret: String(form.signingSecret ?? '').trim() || undefined,
    timezone: String(form.timezone ?? 'UTC'),
    scheduleTimeLocal: String(form.scheduleTimeLocal ?? '09:00'),
    sendEmptyReport: form.sendEmptyReport === 'on',
    enabled: form.enabled === 'on'
  })
}
