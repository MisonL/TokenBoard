import { randomId } from '../../lib/crypto'
import { insertDeliveryLog, type DueWebhookSubscription } from './queries'
import { nextScheduledRunAt } from './time'

type DeliveryKind = 'daily' | 'test'

const maxAttempts = 3
const retryDelayMinutes = [5, 30]
const successPersistenceAttempts = 3

export async function recordDeliverySuccess(input: {
  db: D1Database
  subscription: DueWebhookSubscription
  kind: DeliveryKind
  now: Date
  reportDate: string
  attempt: number
  httpStatus: number
  durationMs: number
}) {
  const stateRequired = input.kind === 'daily'
  let statePersisted = !stateRequired
  let logPersisted = false
  const errors: unknown[] = []

  for (let attempt = 1; attempt <= successPersistenceAttempts; attempt += 1) {
    if (!statePersisted) {
      try {
        await markSubscriptionSuccess(input.db, input.subscription, input.now)
        statePersisted = true
      } catch (error) {
        errors.push(error)
      }
    }

    if (!logPersisted) {
      try {
        await insertDeliveryLog({
          db: input.db,
          id: randomId('whl'),
          subscriptionId: input.subscription.id,
          userId: input.subscription.userId,
          reportDate: input.reportDate,
          kind: input.kind,
          status: 'success',
          httpStatus: input.httpStatus,
          attempt: input.attempt,
          durationMs: input.durationMs,
          createdAt: input.now.toISOString(),
          ignoreDuplicateDailySuccess: input.kind === 'daily'
        })
        logPersisted = true
      } catch (error) {
        errors.push(error)
      }
    }

    if (statePersisted && logPersisted) return { complete: true }
  }

  if (stateRequired && (statePersisted || logPersisted)) return { complete: false }

  if (errors.length === 1) throw errors[0]
  throw new AggregateError(errors, 'Failed to persist webhook delivery success')
}

export async function recordDeliveryFailure(input: {
  db: D1Database
  subscription: DueWebhookSubscription
  kind: DeliveryKind
  reportDate: string
  attempt: number
  error: string
  httpStatus: number | null
  durationMs: number
  now: Date
}) {
  await insertDeliveryLog({
    db: input.db,
    id: randomId('whl'),
    subscriptionId: input.subscription.id,
    userId: input.subscription.userId,
    reportDate: input.reportDate,
    kind: input.kind,
    status: 'failure',
    httpStatus: input.httpStatus,
    attempt: input.attempt,
    error: input.error,
    durationMs: input.durationMs,
    createdAt: input.now.toISOString()
  })

  if (input.kind === 'daily') {
    await markSubscriptionFailure(input)
  } else {
    await markSubscriptionTestFailure(input)
  }
}

export async function markSubscriptionSkipped(input: {
  db: D1Database
  subscription: DueWebhookSubscription
  now: Date
  reportDate: string
  reason: string
}) {
  await insertDeliveryLog({
    db: input.db,
    id: randomId('whl'),
    subscriptionId: input.subscription.id,
    userId: input.subscription.userId,
    reportDate: input.reportDate,
    kind: 'daily',
    status: 'skipped',
    attempt: input.subscription.failureCount + 1,
    error: input.reason,
    durationMs: 0,
    createdAt: input.now.toISOString()
  })
  await markSubscriptionSkippedState(input.db, input.subscription, input.now)
}

async function markSubscriptionFailure(input: {
  db: D1Database
  subscription: DueWebhookSubscription
  reportDate: string
  attempt: number
  error: string
  now: Date
}) {
  const shouldRetry = input.attempt < maxAttempts
  const result = await input.db
    .prepare(
      `
        UPDATE webhook_subscriptions
        SET
          next_run_at = ?,
          pending_report_date = ?,
          locked_until = NULL,
          locked_at = NULL,
          failure_count = ?,
          last_failure_at = ?,
          last_error = ?,
          updated_at = ?
        WHERE id = ?
          AND locked_at = ?
      `
    )
    .bind(
      nextRunAfterFailure(input, shouldRetry),
      shouldRetry ? input.reportDate : null,
      shouldRetry ? input.attempt : 0,
      input.now.toISOString(),
      input.error,
      input.now.toISOString(),
      input.subscription.id,
      input.subscription.lockedAt
    )
    .run()
  assertClaimedUpdate(result)
}

async function markSubscriptionSuccess(db: D1Database, subscription: DueWebhookSubscription, now: Date) {
  const result = await db
    .prepare(
      `
        UPDATE webhook_subscriptions
        SET
          next_run_at = ?,
          pending_report_date = NULL,
          locked_until = NULL,
          locked_at = NULL,
          failure_count = 0,
          last_success_at = ?,
          last_error = NULL,
          updated_at = ?
        WHERE id = ?
          AND locked_at = ?
      `
    )
    .bind(
      nextScheduledRunAt({
        now,
        timezone: subscription.timezone,
        scheduleTimeLocal: subscription.scheduleTimeLocal
      }),
      now.toISOString(),
      now.toISOString(),
      subscription.id,
      subscription.lockedAt
    )
    .run()
  assertClaimedUpdate(result)
}

async function markSubscriptionSkippedState(
  db: D1Database,
  subscription: DueWebhookSubscription,
  now: Date
) {
  const result = await db
    .prepare(
      `
        UPDATE webhook_subscriptions
        SET
          next_run_at = ?,
          pending_report_date = NULL,
          locked_until = NULL,
          locked_at = NULL,
          failure_count = 0,
          last_error = NULL,
          updated_at = ?
        WHERE id = ?
          AND locked_at = ?
      `
    )
    .bind(
      nextScheduledRunAt({
        now,
        timezone: subscription.timezone,
        scheduleTimeLocal: subscription.scheduleTimeLocal
      }),
      now.toISOString(),
      subscription.id,
      subscription.lockedAt
    )
    .run()
  assertClaimedUpdate(result)
}

async function markSubscriptionTestFailure(input: {
  db: D1Database
  subscription: DueWebhookSubscription
  error: string
  now: Date
}) {
  await input.db
    .prepare(
      `
        UPDATE webhook_subscriptions
        SET
          last_failure_at = ?,
          last_error = ?,
          updated_at = ?
        WHERE id = ?
      `
    )
    .bind(
      input.now.toISOString(),
      input.error,
      input.now.toISOString(),
      input.subscription.id
    )
    .run()
}

function nextRunAfterFailure(input: {
  subscription: DueWebhookSubscription
  attempt: number
  now: Date
}, shouldRetry: boolean) {
  if (shouldRetry) {
    return addMinutes(input.now, retryDelayMinutes[input.attempt - 1] ?? retryDelayMinutes.at(-1) ?? 30).toISOString()
  }
  return nextScheduledRunAt({
    now: input.now,
    timezone: input.subscription.timezone,
    scheduleTimeLocal: input.subscription.scheduleTimeLocal
  })
}

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60 * 1000)
}

function assertClaimedUpdate(result: D1Result<unknown>) {
  if (Number(result.meta?.changes ?? 0) <= 0) {
    throw new Error('Webhook subscription claim is no longer current')
  }
}
