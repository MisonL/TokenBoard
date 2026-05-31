import { renderToString } from 'hono/jsx/dom/server'
import { describe, expect, test } from 'vitest'
import { NotificationsPage } from './notifications'

describe('NotificationsPage', () => {
  test('renders configured webhook rows without full webhook URLs', async () => {
    const html = await renderToString(
      <NotificationsPage
        email="user@example.com"
        timezone="Asia/Shanghai"
        saved={false}
        tested={false}
        testFailed={false}
        encryptionConfigured={true}
        subscriptions={[
          {
            id: 'sub_1',
            name: '日报',
            provider: 'wecom',
            webhookUrlHost: 'qyapi.weixin.qq.com',
            webhookUrlMasked: 'qyapi.weixin.qq.com/...abcdef',
            timezone: 'Asia/Shanghai',
            scheduleTimeLocal: '09:30',
            sendEmptyReport: false,
            enabled: true,
            nextRunAt: '2026-04-30T01:30:00.000Z',
            pendingReportDate: null,
            failureCount: 0,
            lastSuccessAt: null,
            lastFailureAt: null,
            lastError: null,
            createdAt: '2026-04-29T01:30:00.000Z',
            updatedAt: '2026-04-29T01:30:00.000Z'
          }
        ]}
      />
    )

    expect(html).toContain('通知 Webhook')
    expect(html).toContain('qyapi.weixin.qq.com/...abcdef')
    expect(html).not.toContain('key=')
    expect(html).toContain('data-custom-select="true"')
    expect(html).toContain('测试发送')
  })

  test('shows encryption configuration warning', async () => {
    const html = await renderToString(
      <NotificationsPage
        email="user@example.com"
        timezone="UTC"
        saved={false}
        tested={false}
        testFailed={false}
        encryptionConfigured={false}
        subscriptions={[]}
      />
    )

    expect(html).toContain('WEBHOOK_ENCRYPTION_KEY')
    expect(html).toContain('disabled')
  })

  test('shows failed test send feedback separately from success feedback', async () => {
    const html = await renderToString(
      <NotificationsPage
        email="user@example.com"
        timezone="UTC"
        saved={false}
        tested={false}
        testFailed={true}
        encryptionConfigured={true}
        subscriptions={[]}
      />
    )

    expect(html).toContain('测试预览通知发送失败')
    expect(html).not.toContain('测试预览通知已发送')
  })
})
