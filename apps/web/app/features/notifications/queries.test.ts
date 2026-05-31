import { describe, expect, test } from 'vitest'
import { claimWebhookSubscription, listDueWebhookSubscriptions } from './queries'

describe('notification queries', () => {
  test('filters out active delivery locks when listing due subscriptions', async () => {
    const statements: string[] = []
    const bindings: unknown[][] = []
    const db = {
      prepare(sql: string) {
        statements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async all() {
                return { results: [] }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await listDueWebhookSubscriptions(db, '2026-04-29T01:31:00.000Z', 50)

    expect(statements[0]).toContain('webhook_subscriptions.locked_until IS NULL')
    expect(statements[0]).toContain('webhook_subscriptions.locked_until <= ?')
    expect(bindings[0]).toEqual(['2026-04-29T01:31:00.000Z', '2026-04-29T01:31:00.000Z', 50])
  })

  test('claims only due enabled subscriptions with an expired lock', async () => {
    const statements: string[] = []
    const bindings: unknown[][] = []
    const db = {
      prepare(sql: string) {
        statements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async run() {
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const claimed = await claimWebhookSubscription({
      db,
      subscriptionId: 'sub_1',
      nowIso: '2026-04-29T01:31:00.000Z',
      lockedUntilIso: '2026-04-29T01:41:00.000Z'
    })

    expect(claimed).toBe(true)
    expect(statements[0]).toContain('enabled = 1')
    expect(statements[0]).toContain('next_run_at <= ?')
    expect(statements[0]).toContain('locked_until <= ?')
    expect(bindings[0]).toEqual([
      '2026-04-29T01:41:00.000Z',
      '2026-04-29T01:31:00.000Z',
      '2026-04-29T01:31:00.000Z',
      'sub_1',
      '2026-04-29T01:31:00.000Z',
      '2026-04-29T01:31:00.000Z'
    ])
  })
})
