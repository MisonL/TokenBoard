import type { WebhookProvider, WebhookSubscriptionSummary } from './schema'

export type WebhookSubscriptionSecretRow = WebhookSubscriptionSummary & {
  userId: string
  displayName: string
  webhookUrlEncrypted: string
  signingSecretEncrypted: string | null
}

export type DueWebhookSubscription = WebhookSubscriptionSecretRow

export async function listWebhookSubscriptions(
  db: D1Database,
  userId: string
): Promise<WebhookSubscriptionSummary[]> {
  const rows = await db
    .prepare(
      `
        SELECT
          id,
          name,
          provider,
          webhook_url_host as webhookUrlHost,
          webhook_url_masked as webhookUrlMasked,
          timezone,
          schedule_time_local as scheduleTimeLocal,
          send_empty_report as sendEmptyReport,
          enabled,
          next_run_at as nextRunAt,
          pending_report_date as pendingReportDate,
          failure_count as failureCount,
          last_success_at as lastSuccessAt,
          last_failure_at as lastFailureAt,
          last_error as lastError,
          created_at as createdAt,
          updated_at as updatedAt
        FROM webhook_subscriptions
        WHERE user_id = ?
        ORDER BY created_at DESC
      `
    )
    .bind(userId)
    .all<WebhookSubscriptionSummary>()

  return (rows.results ?? []).map(normalizeSubscriptionSummary)
}

export async function getWebhookSubscriptionForUser(
  db: D1Database,
  userId: string,
  subscriptionId: string
) {
  const row = await db
    .prepare(
      `
        SELECT
          webhook_subscriptions.id,
          webhook_subscriptions.user_id as userId,
          profiles.display_name as displayName,
          webhook_subscriptions.name,
          webhook_subscriptions.provider,
          webhook_subscriptions.webhook_url_encrypted as webhookUrlEncrypted,
          webhook_subscriptions.webhook_url_host as webhookUrlHost,
          webhook_subscriptions.webhook_url_masked as webhookUrlMasked,
          webhook_subscriptions.signing_secret_encrypted as signingSecretEncrypted,
          webhook_subscriptions.timezone,
          webhook_subscriptions.schedule_time_local as scheduleTimeLocal,
          webhook_subscriptions.send_empty_report as sendEmptyReport,
          webhook_subscriptions.enabled,
          webhook_subscriptions.next_run_at as nextRunAt,
          webhook_subscriptions.pending_report_date as pendingReportDate,
          webhook_subscriptions.failure_count as failureCount,
          webhook_subscriptions.last_success_at as lastSuccessAt,
          webhook_subscriptions.last_failure_at as lastFailureAt,
          webhook_subscriptions.last_error as lastError,
          webhook_subscriptions.created_at as createdAt,
          webhook_subscriptions.updated_at as updatedAt
        FROM webhook_subscriptions
        JOIN profiles ON profiles.user_id = webhook_subscriptions.user_id
        WHERE webhook_subscriptions.user_id = ?
          AND webhook_subscriptions.id = ?
        LIMIT 1
      `
    )
    .bind(userId, subscriptionId)
    .first<WebhookSubscriptionSecretRow>()

  return row ? normalizeSecretRow(row) : null
}

export async function listDueWebhookSubscriptions(
  db: D1Database,
  nowIso: string,
  limit: number
): Promise<DueWebhookSubscription[]> {
  const rows = await db
    .prepare(
      `
        SELECT
          webhook_subscriptions.id,
          webhook_subscriptions.user_id as userId,
          profiles.display_name as displayName,
          webhook_subscriptions.name,
          webhook_subscriptions.provider,
          webhook_subscriptions.webhook_url_encrypted as webhookUrlEncrypted,
          webhook_subscriptions.webhook_url_host as webhookUrlHost,
          webhook_subscriptions.webhook_url_masked as webhookUrlMasked,
          webhook_subscriptions.signing_secret_encrypted as signingSecretEncrypted,
          webhook_subscriptions.timezone,
          webhook_subscriptions.schedule_time_local as scheduleTimeLocal,
          webhook_subscriptions.send_empty_report as sendEmptyReport,
          webhook_subscriptions.enabled,
          webhook_subscriptions.next_run_at as nextRunAt,
          webhook_subscriptions.pending_report_date as pendingReportDate,
          webhook_subscriptions.failure_count as failureCount,
          webhook_subscriptions.last_success_at as lastSuccessAt,
          webhook_subscriptions.last_failure_at as lastFailureAt,
          webhook_subscriptions.last_error as lastError,
          webhook_subscriptions.created_at as createdAt,
          webhook_subscriptions.updated_at as updatedAt
        FROM webhook_subscriptions
        JOIN profiles ON profiles.user_id = webhook_subscriptions.user_id
        WHERE webhook_subscriptions.enabled = 1
          AND webhook_subscriptions.next_run_at <= ?
          AND (
            webhook_subscriptions.locked_until IS NULL
            OR webhook_subscriptions.locked_until <= ?
          )
        ORDER BY webhook_subscriptions.next_run_at ASC
        LIMIT ?
      `
    )
    .bind(nowIso, nowIso, limit)
    .all<DueWebhookSubscription>()

  return (rows.results ?? []).map(normalizeSecretRow)
}

export async function claimWebhookSubscription(input: {
  db: D1Database
  subscriptionId: string
  nowIso: string
  lockedUntilIso: string
}) {
  const result = await input.db
    .prepare(
      `
        UPDATE webhook_subscriptions
        SET
          locked_until = ?,
          locked_at = ?,
          updated_at = ?
        WHERE id = ?
          AND enabled = 1
          AND next_run_at <= ?
          AND (
            locked_until IS NULL
            OR locked_until <= ?
          )
      `
    )
    .bind(
      input.lockedUntilIso,
      input.nowIso,
      input.nowIso,
      input.subscriptionId,
      input.nowIso,
      input.nowIso
    )
    .run()

  return Number(result.meta?.changes ?? 0) > 0
}

export async function hasSuccessfulDailyDelivery(input: {
  db: D1Database
  subscriptionId: string
  reportDate: string
}) {
  const row = await input.db
    .prepare(
      `
        SELECT id
        FROM webhook_delivery_logs
        WHERE subscription_id = ?
          AND report_date = ?
          AND kind = 'daily'
          AND status = 'success'
        LIMIT 1
      `
    )
    .bind(input.subscriptionId, input.reportDate)
    .first<{ id: string }>()

  return Boolean(row)
}

export async function insertDeliveryLog(input: {
  db: D1Database
  id: string
  subscriptionId: string
  userId: string
  reportDate: string
  kind: 'daily' | 'test'
  status: 'success' | 'failure' | 'skipped'
  httpStatus?: number | null
  attempt: number
  error?: string | null
  durationMs: number
  createdAt: string
  ignoreDuplicateDailySuccess?: boolean
}) {
  await input.db
    .prepare(
      `
        INSERT INTO webhook_delivery_logs (
          id,
          subscription_id,
          user_id,
          report_date,
          kind,
          status,
          http_status,
          attempt,
          error,
          duration_ms,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ${input.ignoreDuplicateDailySuccess ? "ON CONFLICT(subscription_id, report_date, kind) WHERE status = 'success' AND kind = 'daily' DO NOTHING" : ''}
      `
    )
    .bind(
      input.id,
      input.subscriptionId,
      input.userId,
      input.reportDate,
      input.kind,
      input.status,
      input.httpStatus ?? null,
      input.attempt,
      input.error ?? null,
      input.durationMs,
      input.createdAt
    )
    .run()
}

function normalizeSecretRow(row: WebhookSubscriptionSecretRow): WebhookSubscriptionSecretRow {
  return {
    ...normalizeSubscriptionSummary(row),
    userId: row.userId,
    displayName: row.displayName,
    webhookUrlEncrypted: row.webhookUrlEncrypted,
    signingSecretEncrypted: row.signingSecretEncrypted ?? null
  }
}

function normalizeSubscriptionSummary(row: WebhookSubscriptionSummary): WebhookSubscriptionSummary {
  return {
    ...row,
    provider: row.provider as WebhookProvider,
    sendEmptyReport: Boolean(row.sendEmptyReport),
    enabled: Boolean(row.enabled),
    pendingReportDate: row.pendingReportDate ?? null,
    failureCount: Number(row.failureCount ?? 0),
    lastSuccessAt: row.lastSuccessAt ?? null,
    lastFailureAt: row.lastFailureAt ?? null,
    lastError: row.lastError ?? null
  }
}
