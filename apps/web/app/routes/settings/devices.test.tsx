import { renderToString } from 'hono/jsx/dom/server'
import { describe, expect, test } from 'vitest'
import { DevicesPage } from './devices'

describe('DevicesPage layout', () => {
  test('renders the list view with search, summary, and actions', async () => {
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
            uploadTokens: [
              {
                id: 'ut_1',
                deviceId: 'device_1',
                installationId: 'inst_1',
                name: 'MacBook Pro upload token',
                lastUsedAt: '2026-05-29T01:27:47.279Z',
                createdAt: '2026-04-29T10:03:36.232Z',
                revokedAt: null
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
              },
              {
                id: 'audit_2',
                action: 'token.rotate',
                targetType: 'upload_token',
                targetId: 'ut_2',
                metadata: '{"previousTokenId":"ut_1"}',
                createdAt: '2026-05-29T01:40:00.000Z'
              }
            ]
          }
        ]}
      />
    )

    expect(html).toContain('data-devices-list="true"')
    expect(html).toContain('data-device-card-mode="list"')
    expect(html).toContain('data-devices-overview="true"')
    expect(html).toContain('aria-current="page"')
    expect(html).toContain('按设备名、平台、安装实例或 token 名搜索')
    expect(html).toContain('列表')
    expect(html).toContain('卡片')
    expect(html).toContain('连接新设备')
    expect(html).toContain('tabular-nums')
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
    expect(html).toContain('上传 token')
    expect(html).toContain('MacBook Pro upload token')
    expect(html).toContain('安装实例：inst_1')
    expect(html).toContain('name="uploadTokenId"')
    expect(html).toContain('value="revoke-token"')
    expect(html).toContain('停用此 token')
    expect(html).toContain('value="rotate-token"')
    expect(html).toContain('轮换 token')
    expect(html).toContain('确认轮换这个上传 token？旧 token 会立即停用，新 token 只显示一次。')
    expect(html).toContain('确认只停用这个上传 token？')
    expect(html).toContain('最近操作')
    expect(html).toContain('旧设备重连')
    expect(html).toContain('轮换 token')
    expect(html).toContain('data-submitting-label="正在停用..."')
    expect(html).toContain('data-submitting-tone="danger"')
    expect(html).toContain('data-link-button="true"')
    expect(html).not.toContain('data-devices-card-grid="true"')
    expect(html).not.toContain('data-device-card-mode="card"')
  })

  test('renders the card view and keeps the search state in controls', async () => {
    const html = await renderToString(
      <DevicesPage
        email="user@example.com"
        saved={false}
        revoked={null}
        view="cards"
        query="macbook"
        devices={[
          {
            id: 'device_1',
            name: 'MacBook Pro',
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
            uploadTokens: [
              {
                id: 'ut_1',
                deviceId: 'device_1',
                installationId: 'inst_1',
                name: 'MacBook Pro upload token',
                lastUsedAt: '2026-05-29T01:27:47.279Z',
                createdAt: '2026-04-29T10:03:36.232Z',
                revokedAt: null
              }
            ],
            auditLogs: []
          }
        ]}
      />
    )

    expect(html).toContain('data-devices-card-grid="true"')
    expect(html).toContain('data-device-card-mode="card"')
    expect(html).toContain('value="macbook"')
    expect(html).toContain('name="view" value="cards"')
    expect(html).toContain('name="query" value="macbook"')
    expect(html).toContain('aria-current="page"')
    expect(html).toContain('data-device-view-toggle="cards"')
    expect(html).toContain('href="/settings/devices?view=cards&amp;query=macbook"')
    expect(html).not.toContain('data-device-view-toggle="list" aria-current="page"')
  })

  test('renders the empty state when no device matches the search', async () => {
    const html = await renderToString(
      <DevicesPage
        email="user@example.com"
        saved={false}
        revoked={null}
        view="cards"
        query="missing"
        devices={[]}
      />
    )

    expect(html).toContain('data-devices-empty-state="true"')
    expect(html).toContain('没有找到匹配「missing」的设备。')
    expect(html).not.toContain('data-devices-list="true"')
    expect(html).not.toContain('data-devices-card-grid="true"')
  })

  test('renders token revoke flash separately from device and installation revoke', async () => {
    const html = await renderToString(
      <DevicesPage email="user@example.com" saved={false} revoked="token" devices={[]} />
    )

    expect(html).toContain('上传 token 已停用。')
  })

  test('renders a rotated upload token as one-time output', async () => {
    const html = await renderToString(
      <DevicesPage
        email="user@example.com"
        saved={false}
        revoked={null}
        rotatedCredentials={{
          uploadToken: 'tb_upload_new_secret',
          deviceId: 'dev_1',
          installationId: 'inst_1',
          installClaim: 'tb_install_new_secret'
        }}
        serverOrigin="https://tokenboard.example.com"
        devices={[]}
      />
    )

    expect(html).toContain('新的上传 token 只显示一次')
    expect(html).toContain('tb_upload_new_secret')
    expect(html).toContain('旧 install claim 已失效')
    expect(html).toContain('macOS / Linux / Git Bash')
    expect(html).toContain('Windows PowerShell')
    expect(html).toContain('rotate-token.mjs')
    expect(html).toContain('--server-origin &#39;https://tokenboard.example.com&#39;')
    expect(html).toContain('--upload-token &#39;tb_upload_new_secret&#39;')
    expect(html).toContain('--install-claim &#39;tb_install_new_secret&#39;')
    expect(html).toContain('Join-Path $HOME &quot;.tokenboard\\TokenBoard\\skills\\tokenboard\\scripts\\rotate-token.mjs&quot;')
    expect(html).toContain('--server-origin &quot;https://tokenboard.example.com&quot;')
    expect(html).toContain('--upload-token &quot;tb_upload_new_secret&quot;')
    expect(html).toContain('--install-claim &quot;tb_install_new_secret&quot;')
  })
})
