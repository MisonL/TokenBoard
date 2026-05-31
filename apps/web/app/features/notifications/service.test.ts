import { describe, expect, test, vi } from 'vitest'
import { encryptSecret } from './crypto'
import {
  createWebhookSubscription,
  runDueWebhookNotifications,
  sendWebhookTest,
  setWebhookSubscriptionEnabled
} from './service'
import type { DueWebhookSubscription } from './queries'

const testEncryptionKey = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY='

describe('notification service', () => {
  test('creates a subscription with encrypted URL and a masked display value', async () => {
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
                return {}
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await createWebhookSubscription({
      env: {
        DB: db,
        WEBHOOK_ENCRYPTION_KEY: testEncryptionKey
      },
      userId: 'user_1',
      form: {
        name: '日报',
        provider: 'wecom',
        webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef',
        timezone: 'Asia/Shanghai',
        scheduleTimeLocal: '09:30',
        sendEmptyReport: false,
        enabled: true
      },
      now: new Date('2026-04-29T00:00:00.000Z')
    })

    expect(statements[0]).toContain('INSERT INTO webhook_subscriptions')
    expect(bindings[0][4]).not.toContain('abcdef')
    expect(bindings[0][5]).toBe('qyapi.weixin.qq.com')
    expect(bindings[0][6]).toBe('qyapi.weixin.qq.com/...')
    expect(bindings[0][12]).toBe('2026-04-29T01:30:00.000Z')
  })

  test('rejects unsupported webhook hosts before storing secrets', async () => {
    const db = {
      prepare() {
        throw new Error('should not write')
      }
    } as unknown as D1Database

    await expect(createWebhookSubscription({
      env: {
        DB: db,
        WEBHOOK_ENCRYPTION_KEY: testEncryptionKey
      },
      userId: 'user_1',
      form: {
        name: 'bad',
        provider: 'wecom',
        webhookUrl: 'https://example.com/webhook',
        timezone: 'UTC',
        scheduleTimeLocal: '09:30',
        sendEmptyReport: false,
        enabled: true
      }
    })).rejects.toThrow('Webhook URL host or path is not supported')
  })

  test('returns failure for failed test sends', async () => {
    const secret = testEncryptionKey
    const encryptedUrl = await encryptSecret('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef', secret)
    const statements: string[] = []
    const bindings: unknown[][] = []
    const db = {
      prepare(sql: string) {
        statements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async first() {
                if (sql.includes('FROM webhook_subscriptions')) return dueSubscriptionRow(encryptedUrl)
                if (sql.includes('SUM(session_count)')) {
                  return {
                    totalTokens: 1200,
                    totalTokensWithoutCacheRead: 900,
                    costUsd: 1.23,
                    sessionCount: 4
                  }
                }
                return null
              },
              async all() {
                return { results: [] }
              },
              async run() {
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const result = await sendWebhookTest({
      env: {
        DB: db,
        WEBHOOK_ENCRYPTION_KEY: secret,
        BETTER_AUTH_URL: 'https://tokenboard.example.com'
      },
      userId: 'user_1',
      subscriptionId: 'sub_1',
      now: new Date('2026-04-29T01:31:00.000Z'),
      fetcher: async () => new Response('provider failed', { status: 500 })
    })

    expect(result).toEqual({ status: 'failure' })
    expect(statements.some((sql) => sql.includes('last_failure_at') && !sql.includes('pending_report_date'))).toBe(true)
    expect(bindings.flat()).toContain('Webhook returned 500: provider failed')
  })

  test('sends due daily report once and schedules the next local run', async () => {
    const secret = testEncryptionKey
    const encryptedUrl = await encryptSecret('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef', secret)
    const statements: string[] = []
    const bindings: unknown[][] = []
    const fetchCalls: Array<{ url: string; body: string; signal: unknown }> = []
    const db = {
      prepare(sql: string) {
        statements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async first() {
                if (sql.includes('FROM webhook_delivery_logs')) return null
                if (sql.includes('SUM(session_count)')) {
                  return {
                    totalTokens: 1200,
                    totalTokensWithoutCacheRead: 900,
                    costUsd: 1.23,
                    sessionCount: 4
                  }
                }
                return null
              },
              async all() {
                if (sql.includes('FROM webhook_subscriptions')) {
                  return {
                    results: [dueSubscriptionRow(encryptedUrl)]
                  }
                }
                if (sql.includes('GROUP BY source')) {
                  return {
                    results: [
                      { source: 'codex', totalTokens: 1200, totalTokensWithoutCacheRead: 900 }
                    ]
                  }
                }
                if (sql.includes('GROUP BY model')) {
                  return {
                    results: [
                      { model: 'gpt-5', totalTokens: 1200, totalTokensWithoutCacheRead: 900, costUsd: 1.23 }
                    ]
                  }
                }
                return { results: [] }
              },
              async run() {
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const result = await runDueWebhookNotifications({
      env: {
        DB: db,
        WEBHOOK_ENCRYPTION_KEY: secret,
        BETTER_AUTH_URL: 'https://tokenboard.example.com'
      },
      now: new Date('2026-04-29T01:31:00.000Z'),
      fetcher: async (url, init) => {
        fetchCalls.push({ url: String(url), body: String(init?.body), signal: init?.signal })
        return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 })
      }
    })

    expect(result).toEqual({ checked: 1, sent: 1, failed: 0, skipped: 0 })
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].url).toBe('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef')
    expect(fetchCalls[0].body).toContain('Example token 日报 2026-04-29')
    expect(fetchCalls[0].body).toContain('缓存率 25%')
    expect(fetchCalls[0].signal).toBeInstanceOf(AbortSignal)
    expect(statements.some((sql) => sql.includes('INSERT INTO webhook_delivery_logs'))).toBe(true)
    expect(statements.some((sql) => sql.includes('last_success_at'))).toBe(true)
    expect(statements.some((sql) => sql.includes('locked_until = ?'))).toBe(true)
    expect(statements.some((sql) => sql.includes('last_success_at') && sql.includes('locked_at = ?'))).toBe(true)
    expect(bindings.some((values) => values.includes('sub_1') && values.includes('2026-04-29T01:31:00.000Z'))).toBe(true)
    expect(bindings.flat()).toContain('2026-04-30T01:30:00.000Z')
  })

  test.each([
    ['success log write', 'log'],
    ['success state update', 'state']
  ])('does not schedule retry when provider succeeded but %s fails', async (_label, failAt) => {
    const secret = testEncryptionKey
    const encryptedUrl = await encryptSecret('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef', secret)
    const deliveryStatuses: string[] = []
    const fetchCalls: string[] = []
    let failureUpdateSeen = false
    let successUpdateSeen = false
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              async first() {
                if (sql.includes('FROM webhook_delivery_logs')) return null
                if (sql.includes('SUM(session_count)')) {
                  return {
                    totalTokens: 1200,
                    totalTokensWithoutCacheRead: 900,
                    costUsd: 1.23,
                    sessionCount: 4
                  }
                }
                return null
              },
              async all() {
                if (sql.includes('FROM webhook_subscriptions')) {
                  return {
                    results: [dueSubscriptionRow(encryptedUrl)]
                  }
                }
                return { results: [] }
              },
              async run() {
                if (sql.includes('INSERT INTO webhook_delivery_logs')) {
                  const status = String(values[5])
                  deliveryStatuses.push(status)
                  if (status === 'success' && failAt === 'log') {
                    throw new Error('success log failed')
                  }
                }
                if (sql.includes('UPDATE webhook_subscriptions') && sql.includes('last_success_at')) {
                  successUpdateSeen = true
                  if (failAt === 'state') throw new Error('success state failed')
                }
                if (sql.includes('UPDATE webhook_subscriptions') && sql.includes('last_failure_at')) {
                  failureUpdateSeen = true
                }
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    try {
      const result = await runDueWebhookNotifications({
        env: {
          DB: db,
          WEBHOOK_ENCRYPTION_KEY: secret,
          BETTER_AUTH_URL: 'https://tokenboard.example.com'
        },
        now: new Date('2026-04-29T01:31:00.000Z'),
        fetcher: async (url) => {
          fetchCalls.push(String(url))
          return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 })
        }
      })

      expect(result).toEqual({ checked: 1, sent: 1, failed: 0, skipped: 0 })
      expect(fetchCalls).toHaveLength(1)
      expect(deliveryStatuses).toContain('success')
      expect(deliveryStatuses).not.toContain('failure')
      expect(failureUpdateSeen).toBe(false)
      if (failAt === 'log') expect(successUpdateSeen).toBe(true)
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('success'))
    } finally {
      consoleError.mockRestore()
    }
  })

  test.each([
    ['success log write', 'log'],
    ['success state update', 'state']
  ])('retries success persistence when %s fails once', async (_label, failAt) => {
    const secret = testEncryptionKey
    const encryptedUrl = await encryptSecret('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef', secret)
    let successLogAttempts = 0
    let successStateAttempts = 0
    let failureUpdateSeen = false
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              async first() {
                if (sql.includes('FROM webhook_delivery_logs')) return null
                if (sql.includes('SUM(session_count)')) {
                  return {
                    totalTokens: 1200,
                    totalTokensWithoutCacheRead: 900,
                    costUsd: 1.23,
                    sessionCount: 4
                  }
                }
                return null
              },
              async all() {
                if (sql.includes('FROM webhook_subscriptions')) {
                  return {
                    results: [dueSubscriptionRow(encryptedUrl)]
                  }
                }
                return { results: [] }
              },
              async run() {
                if (sql.includes('INSERT INTO webhook_delivery_logs') && values[5] === 'success') {
                  successLogAttempts += 1
                  if (failAt === 'log' && successLogAttempts === 1) {
                    throw new Error('success log failed once')
                  }
                }
                if (sql.includes('UPDATE webhook_subscriptions') && sql.includes('last_success_at')) {
                  successStateAttempts += 1
                  if (failAt === 'state' && successStateAttempts === 1) {
                    throw new Error('success state failed once')
                  }
                }
                if (sql.includes('UPDATE webhook_subscriptions') && sql.includes('last_failure_at')) {
                  failureUpdateSeen = true
                }
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const result = await runDueWebhookNotifications({
      env: {
        DB: db,
        WEBHOOK_ENCRYPTION_KEY: secret,
        BETTER_AUTH_URL: 'https://tokenboard.example.com'
      },
      now: new Date('2026-04-29T01:31:00.000Z'),
      fetcher: async () => new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 })
    })

    expect(result).toEqual({ checked: 1, sent: 1, failed: 0, skipped: 0 })
    expect(successLogAttempts).toBe(failAt === 'log' ? 2 : 1)
    expect(successStateAttempts).toBe(failAt === 'state' ? 2 : 1)
    expect(failureUpdateSeen).toBe(false)
  })

  test('reports a cron failure when provider succeeded but success persistence never completes', async () => {
    const secret = testEncryptionKey
    const encryptedUrl = await encryptSecret('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef', secret)
    const deliveryStatuses: string[] = []
    const fetchCalls: string[] = []
    let failureUpdateSeen = false
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              async first() {
                if (sql.includes('FROM webhook_delivery_logs')) return null
                if (sql.includes('SUM(session_count)')) {
                  return {
                    totalTokens: 1200,
                    totalTokensWithoutCacheRead: 900,
                    costUsd: 1.23,
                    sessionCount: 4
                  }
                }
                return null
              },
              async all() {
                if (sql.includes('FROM webhook_subscriptions')) {
                  return {
                    results: [dueSubscriptionRow(encryptedUrl)]
                  }
                }
                return { results: [] }
              },
              async run() {
                if (sql.includes('INSERT INTO webhook_delivery_logs')) {
                  deliveryStatuses.push(String(values[5]))
                  if (values[5] === 'success') throw new Error('success log unavailable')
                }
                if (sql.includes('UPDATE webhook_subscriptions') && sql.includes('last_success_at')) {
                  throw new Error('success state unavailable')
                }
                if (sql.includes('UPDATE webhook_subscriptions') && sql.includes('last_failure_at')) {
                  failureUpdateSeen = true
                }
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    try {
      const result = await runDueWebhookNotifications({
        env: {
          DB: db,
          WEBHOOK_ENCRYPTION_KEY: secret,
          BETTER_AUTH_URL: 'https://tokenboard.example.com'
        },
        now: new Date('2026-04-29T01:31:00.000Z'),
        fetcher: async (url) => {
          fetchCalls.push(String(url))
          return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 })
        }
      })

      expect(result).toEqual({ checked: 1, sent: 0, failed: 1, skipped: 0 })
      expect(fetchCalls).toHaveLength(1)
      expect(deliveryStatuses).toEqual(['success', 'success', 'success'])
      expect(deliveryStatuses).not.toContain('failure')
      expect(failureUpdateSeen).toBe(false)
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('success persistence failed'))
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('cron failed'))
    } finally {
      consoleError.mockRestore()
    }
  })

  test('uses the due schedule date when cron runs after local midnight', async () => {
    const secret = testEncryptionKey
    const encryptedUrl = await encryptSecret('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef', secret)
    const reportDateBindings: unknown[][] = []
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            if (sql.includes('usage_date = ?')) reportDateBindings.push(values)
            return {
              async first() {
                if (sql.includes('FROM webhook_delivery_logs')) return null
                if (sql.includes('SUM(session_count)')) {
                  return {
                    totalTokens: 1200,
                    totalTokensWithoutCacheRead: 900,
                    costUsd: 1.23,
                    sessionCount: 4
                  }
                }
                return null
              },
              async all() {
                if (sql.includes('FROM webhook_subscriptions')) {
                  return {
                    results: [dueSubscriptionRow(encryptedUrl, {
                      nextRunAt: '2026-04-29T15:50:00.000Z',
                      scheduleTimeLocal: '23:50'
                    })]
                  }
                }
                return { results: [] }
              },
              async run() {
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const result = await runDueWebhookNotifications({
      env: {
        DB: db,
        WEBHOOK_ENCRYPTION_KEY: secret,
        BETTER_AUTH_URL: 'https://tokenboard.example.com'
      },
      now: new Date('2026-04-29T16:01:00.000Z'),
      fetcher: async () => new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 })
    })

    expect(result).toEqual({ checked: 1, sent: 1, failed: 0, skipped: 0 })
    expect(reportDateBindings).toEqual([
      ['user_1', '2026-04-29'],
      ['user_1', '2026-04-29'],
      ['user_1', '2026-04-29']
    ])
  })

  test('does not send when another cron worker already claimed the subscription', async () => {
    const secret = testEncryptionKey
    const encryptedUrl = await encryptSecret('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef', secret)
    const db = {
      prepare(sql: string) {
        return {
          bind() {
            return {
              async all() {
                if (sql.includes('FROM webhook_subscriptions')) {
                  return {
                    results: [dueSubscriptionRow(encryptedUrl)]
                  }
                }
                return { results: [] }
              },
              async run() {
                return { meta: { changes: 0 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database
    const fetchCalls: string[] = []

    const result = await runDueWebhookNotifications({
      env: {
        DB: db,
        WEBHOOK_ENCRYPTION_KEY: secret,
        BETTER_AUTH_URL: 'https://tokenboard.example.com'
      },
      now: new Date('2026-04-29T01:31:00.000Z'),
      fetcher: async (url) => {
        fetchCalls.push(String(url))
        return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 })
      }
    })

    expect(result).toEqual({ checked: 1, sent: 0, failed: 0, skipped: 1 })
    expect(fetchCalls).toHaveLength(0)
  })

  test('continues processing due subscriptions after one subscription throws', async () => {
    const secret = testEncryptionKey
    const badEncryptedUrl = await encryptSecret('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=bad', secret)
    const goodEncryptedUrl = await encryptSecret('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=good', secret)
    const fetchCalls: Array<{ url: string; body: string; signal: unknown }> = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              async first() {
                if (sql.includes('FROM webhook_delivery_logs')) return null
                if (sql.includes('SUM(session_count)')) {
                  return {
                    totalTokens: 1200,
                    totalTokensWithoutCacheRead: 900,
                    costUsd: 1.23,
                    sessionCount: 4
                  }
                }
                return null
              },
              async all() {
                if (sql.includes('FROM webhook_subscriptions')) {
                  return {
                    results: [
                      dueSubscriptionRow(badEncryptedUrl, { id: 'sub_bad' }),
                      dueSubscriptionRow(goodEncryptedUrl, { id: 'sub_good' })
                    ]
                  }
                }
                return { results: [] }
              },
              async run() {
                if (sql.includes('UPDATE webhook_subscriptions') && values.includes('sub_bad')) {
                  throw new Error('claim failed')
                }
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    try {
      const result = await runDueWebhookNotifications({
        env: {
          DB: db,
          WEBHOOK_ENCRYPTION_KEY: secret,
          BETTER_AUTH_URL: 'https://tokenboard.example.com'
        },
        now: new Date('2026-04-29T01:31:00.000Z'),
        fetcher: async (url, init) => {
          fetchCalls.push({ url: String(url), body: String(init?.body), signal: init?.signal })
          return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 })
        }
      })

      expect(result).toEqual({ checked: 2, sent: 1, failed: 1, skipped: 0 })
      expect(fetchCalls).toHaveLength(1)
      expect(fetchCalls[0].url).toBe('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=good')
      expect(fetchCalls[0].body).toContain('Example token 日报 2026-04-29')
      expect(fetchCalls[0].signal).toBeInstanceOf(AbortSignal)
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('sub_bad'))
    } finally {
      consoleError.mockRestore()
    }
  })

  test('recomputes next run and clears stale state when re-enabling a subscription', async () => {
    const statements: string[] = []
    const bindings: unknown[][] = []
    const db = {
      prepare(sql: string) {
        statements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async first() {
                if (sql.includes('FROM webhook_subscriptions')) {
                  return dueSubscriptionRow('encrypted-url', {
                    enabled: false,
                    nextRunAt: '2026-04-29T01:30:00.000Z',
                    pendingReportDate: '2026-04-29',
                    failureCount: 2,
                    lastError: 'stale failure'
                  })
                }
                return null
              },
              async run() {
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await setWebhookSubscriptionEnabled({
      db,
      userId: 'user_1',
      subscriptionId: 'sub_1',
      enabled: true,
      now: new Date('2026-04-30T02:00:00.000Z')
    })

    const updateSql = statements.find((sql) => sql.includes('UPDATE webhook_subscriptions')) ?? ''
    expect(updateSql).toContain('pending_report_date = NULL')
    expect(updateSql).toContain('failure_count = CASE')
    expect(updateSql).toContain('last_error = CASE')
    expect(bindings.at(-1)).toEqual([
      1,
      1,
      '2026-05-01T01:30:00.000Z',
      1,
      1,
      '2026-04-30T02:00:00.000Z',
      'user_1',
      'sub_1'
    ])
  })

  test('skips empty daily reports without changing the last success timestamp', async () => {
    const secret = testEncryptionKey
    const encryptedUrl = await encryptSecret('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef', secret)
    const statements: string[] = []
    const bindings: unknown[][] = []
    const db = {
      prepare(sql: string) {
        statements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async first() {
                if (sql.includes('FROM webhook_delivery_logs')) return null
                if (sql.includes('SUM(session_count)')) {
                  return {
                    totalTokens: 0,
                    totalTokensWithoutCacheRead: 0,
                    costUsd: 0,
                    sessionCount: 0
                  }
                }
                return null
              },
              async all() {
                if (sql.includes('FROM webhook_subscriptions')) {
                  return {
                    results: [dueSubscriptionRow(encryptedUrl)]
                  }
                }
                return { results: [] }
              },
              async run() {
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database
    const fetchCalls: string[] = []

    const result = await runDueWebhookNotifications({
      env: {
        DB: db,
        WEBHOOK_ENCRYPTION_KEY: secret,
        BETTER_AUTH_URL: 'https://tokenboard.example.com'
      },
      now: new Date('2026-04-29T01:31:00.000Z'),
      fetcher: async (url) => {
        fetchCalls.push(String(url))
        return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 })
      }
    })

    const updateStatements = statements.filter((sql) => sql.includes('UPDATE webhook_subscriptions'))
    expect(result).toEqual({ checked: 1, sent: 0, failed: 0, skipped: 1 })
    expect(fetchCalls).toHaveLength(0)
    expect(bindings.flat()).toContain('skipped')
    expect(updateStatements.some((sql) => sql.includes('last_success_at'))).toBe(false)
    expect(updateStatements.some((sql) => sql.includes('locked_at = ?'))).toBe(true)
    expect(bindings.some((values) => values.includes('sub_1') && values.includes('2026-04-29T01:31:00.000Z'))).toBe(true)
  })

  test('does not record webhook failure when skipped delivery state fails', async () => {
    const secret = testEncryptionKey
    const encryptedUrl = await encryptSecret('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef', secret)
    const deliveryStatuses: string[] = []
    let failureUpdateSeen = false
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              async first() {
                if (sql.includes('FROM webhook_delivery_logs')) return null
                if (sql.includes('SUM(session_count)')) {
                  return {
                    totalTokens: 0,
                    totalTokensWithoutCacheRead: 0,
                    costUsd: 0,
                    sessionCount: 0
                  }
                }
                return null
              },
              async all() {
                if (sql.includes('FROM webhook_subscriptions')) {
                  return {
                    results: [dueSubscriptionRow(encryptedUrl)]
                  }
                }
                return { results: [] }
              },
              async run() {
                if (sql.includes('INSERT INTO webhook_delivery_logs')) {
                  deliveryStatuses.push(String(values[5]))
                  if (values[5] === 'skipped') throw new Error('skipped log failed')
                }
                if (sql.includes('UPDATE webhook_subscriptions') && sql.includes('last_failure_at')) {
                  failureUpdateSeen = true
                }
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    try {
      const result = await runDueWebhookNotifications({
        env: {
          DB: db,
          WEBHOOK_ENCRYPTION_KEY: secret,
          BETTER_AUTH_URL: 'https://tokenboard.example.com'
        },
        now: new Date('2026-04-29T01:31:00.000Z'),
        fetcher: async () => new Response('should not send', { status: 200 })
      })

      expect(result).toEqual({ checked: 1, sent: 0, failed: 1, skipped: 0 })
      expect(deliveryStatuses).toEqual(['skipped'])
      expect(deliveryStatuses).not.toContain('failure')
      expect(failureUpdateSeen).toBe(false)
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('cron failed'))
    } finally {
      consoleError.mockRestore()
    }
  })
})

function dueSubscriptionRow(
  encryptedUrl: string,
  overrides: Partial<DueWebhookSubscription> = {}
): DueWebhookSubscription {
  return {
    id: 'sub_1',
    userId: 'user_1',
    displayName: 'Example',
    name: '日报',
    provider: 'wecom',
    webhookUrlEncrypted: encryptedUrl,
    webhookUrlHost: 'qyapi.weixin.qq.com',
    webhookUrlMasked: 'qyapi.weixin.qq.com/...',
    signingSecretEncrypted: null,
    timezone: 'Asia/Shanghai',
    scheduleTimeLocal: '09:30',
    sendEmptyReport: false,
    enabled: true,
    nextRunAt: '2026-04-29T01:30:00.000Z',
    pendingReportDate: null,
    lockedAt: null,
    failureCount: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
    createdAt: '2026-04-28T00:00:00.000Z',
    updatedAt: '2026-04-28T00:00:00.000Z',
    ...overrides
  }
}
