import { renderToString } from 'hono/jsx/dom/server'
import { describe, expect, test } from 'vitest'
import { DevicesPage } from './devices'

describe('DevicesPage layout', () => {
  test('renders adaptive device cards on mobile and the table on desktop', async () => {
    const html = await renderToString(
      <DevicesPage
        email="user@example.com"
        saved={false}
        revoked={null}
        devices={[
          {
            id: 'device_1',
            name: 'MacBook Pro With A Long Local Collector Name',
            platform: 'darwin',
            lastSyncedAt: '2026-05-29T01:27:47.279Z',
            createdAt: '2026-04-29T10:03:36.232Z',
            activeTokenCount: 1,
            installations: [
              {
                id: 'inst_1',
                deviceId: 'device_1',
                platform: 'darwin',
                hostname: 'MacBook Pro',
                clientVersion: '0.2.0',
                firstSeenAt: '2026-04-29T10:03:36.232Z',
                lastSeenAt: '2026-05-29T01:27:47.279Z',
                revokedAt: null,
                activeTokenCount: 1
              }
            ],
            auditLogs: [
              {
                id: 'audit_1',
                action: 'device.reconnect',
                targetType: 'device',
                targetId: 'device_1',
                metadata: '{"installationId":"inst_1"}',
                createdAt: '2026-05-29T01:30:00.000Z'
              }
            ]
          }
        ]}
      />
    )

    expect(html).toContain('data-devices-mobile-list="true"')
    expect(html).toContain('data-devices-desktop-table="true"')
    expect(html).toContain('app-surface-raised rounded-xl')
    expect(html).toContain('md:hidden')
    expect(html).toContain('hidden overflow-x-auto md:block')
    expect(html).toContain('MacBook Pro With A Long Local Collector Name')
    expect(html).toContain('w-full sm:w-auto')
    expect(html).toContain('name="name"')
    expect(html).toContain('autocomplete="off"')
    expect(html).toContain('data-submit-feedback="true"')
    expect(html).toContain('data-submitting-label="正在保存..."')
    expect(html).toContain('重新连接')
    expect(html).toContain('action="/settings/install"')
    expect(html).toContain('name="targetDeviceId"')
    expect(html).toContain('data-submitting-label="正在生成..."')
    expect(html).toContain('安装实例')
    expect(html).toContain('MacBook Pro')
    expect(html).toContain('name="installationId"')
    expect(html).toContain('value="revoke-installation"')
    expect(html).toContain('停用此安装')
    expect(html).toContain('最近操作')
    expect(html).toContain('旧设备重连')
    expect(html).toContain('data-submitting-label="正在停用..."')
    expect(html).toContain('data-submitting-tone="danger"')
    expect(html).toContain('data-link-button="true"')
  })
})
