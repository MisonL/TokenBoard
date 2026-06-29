import { createRoute } from 'honox/factory'
import { AppNav } from '../../components/app-nav'
import { Button, LinkButton } from '../../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table'
import { requireUser } from '../../features/auth/middleware'
import {
  listDeviceAuditLogs,
  listUserDevices,
  parseDeviceNameForm,
  renameDevice,
  revokeDevice,
  revokeInstallation,
  revokeUploadToken,
  type UserDeviceAuditLog,
  type UserDevice
} from '../../features/device/service'
import { requireDeviceStepUp } from '../../features/device/step-up'
import { jsonError } from '../../lib/http'

export const GET = createRoute(async (c) => {
  const user = await requireUser(c)
  const devices = await listUserDevices(c.env.DB, user.id)
  const auditLogGroups = await Promise.all(
    devices.map((device) =>
      listDeviceAuditLogs(c.env.DB, {
        userId: user.id,
        deviceId: device.id,
        limit: 5
      })
    )
  )
  const devicesWithAudit = devices.map((device, index) => ({
    ...device,
    auditLogs: auditLogGroups[index] ?? []
  }))

  return c.render(
    <DevicesPage
      devices={devicesWithAudit}
      email={user.email}
      saved={c.req.query('saved') === '1'}
      revoked={c.req.query('revoked') ?? null}
    />
  )
})

export const POST = createRoute(async (c) => {
  try {
    const user = await requireUser(c)
    const form = await c.req.parseBody()
    const action = String(form.action ?? '')
    const deviceId = String(form.deviceId ?? '')

    if (action === 'rename') {
      await renameDevice(c.env.DB, {
        userId: user.id,
        deviceId,
        name: parseDeviceNameForm(form)
      })
      return c.redirect('/settings/devices?saved=1', 303)
    }

    if (action === 'revoke') {
      requireDeviceStepUp(c.env, 'device.revoke')
      await revokeDevice(c.env.DB, {
        userId: user.id,
        deviceId
      })
      return c.redirect('/settings/devices?revoked=1', 303)
    }

    if (action === 'revoke-installation') {
      requireDeviceStepUp(c.env, 'installation.revoke')
      await revokeInstallation(c.env.DB, {
        userId: user.id,
        installationId: String(form.installationId ?? '')
      })
      return c.redirect('/settings/devices?revoked=installation', 303)
    }

    if (action === 'revoke-token') {
      requireDeviceStepUp(c.env, 'token.revoke')
      await revokeUploadToken(c.env.DB, {
        userId: user.id,
        uploadTokenId: String(form.uploadTokenId ?? '')
      })
      return c.redirect('/settings/devices?revoked=token', 303)
    }

    return c.redirect('/settings/devices', 303)
  } catch (error) {
    return jsonError(c, error)
  }
})

export function DevicesPage(props: {
  devices: DeviceViewModel[]
  email: string
  saved: boolean
  revoked: string | null
}) {
  return (
    <main class="min-h-screen bg-[var(--app-bg)] px-4 py-4 text-[var(--app-text)] sm:px-5 sm:py-6">
      <title>设备管理 - TokenBoard</title>
      <AppNav active="devices" email={props.email} />

      <section class="mx-auto flex max-w-6xl flex-col gap-5">
        <DevicesHeader />
        <DevicePageFlash saved={props.saved} revoked={props.revoked} />
        <DevicesCard devices={props.devices} />
      </section>
    </main>
  )
}

type DeviceViewModel = UserDevice & {
  auditLogs?: UserDeviceAuditLog[]
}

function DevicesHeader() {
  return (
    <header class="app-surface-raised rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)] p-5">
      <div class="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p class="app-accent-text text-sm font-black uppercase tracking-[0.24em]">Devices</p>
          <h1 class="mt-3 text-3xl font-black tracking-tight sm:text-4xl">设备管理</h1>
          <p class="mt-2 text-sm text-[var(--app-muted)]">
            查看采集器设备、同步状态，并停用不再使用的上传 token。
          </p>
        </div>
        <LinkButton class="w-full md:w-auto" href="/settings/install">连接新设备</LinkButton>
      </div>
    </header>
  )
}

function DevicePageFlash(props: { saved: boolean; revoked: string | null }) {
  return (
    <>
      {props.saved ? (
        <p class="app-flash-success p-3 text-sm">设备名称已更新。</p>
      ) : null}
      {props.revoked ? <p class="app-flash-success p-3 text-sm">{formatRevokeFlash(props.revoked)}</p> : null}
    </>
  )
}

function formatRevokeFlash(revoked: string) {
  const messages: Record<string, string> = {
    installation: '安装实例已停用。',
    token: '上传 token 已停用。'
  }
  return messages[revoked] ?? '设备 token 已停用。'
}

function DevicesCard(props: { devices: DeviceViewModel[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>已连接设备</CardTitle>
        <CardDescription>停用设备只会阻止后续上传，历史用量会继续保留。</CardDescription>
      </CardHeader>
      <CardContent>
        {props.devices.length > 0 ? <DevicesTable devices={props.devices} /> : <DevicesEmptyState />}
      </CardContent>
    </Card>
  )
}

function DevicesTable(props: { devices: DeviceViewModel[] }) {
  return (
    <>
      <div class="grid gap-3 md:hidden" data-devices-mobile-list="true">
        {props.devices.map((device) => (
          <DeviceCard device={device} />
        ))}
      </div>
      <div class="hidden overflow-x-auto md:block" data-devices-desktop-table="true">
        <Table class="min-w-[1120px]">
          <DevicesTableHeader />
          <TableBody>
            {props.devices.map((device) => (
              <DeviceRow device={device} />
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  )
}

function DeviceCard(props: { device: DeviceViewModel }) {
  return (
    <article class="app-surface-raised rounded-xl border border-[var(--app-border)] bg-[var(--app-bg-soft)] p-4">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <p class="text-xs font-bold uppercase tracking-wide text-[var(--app-muted)]">设备</p>
          <h2 class="mt-1 truncate text-base font-black text-[var(--app-text)]">{props.device.name}</h2>
          <p class="mt-1 text-sm text-[var(--app-muted)]">{props.device.platform}</p>
        </div>
        <DeviceStatus device={props.device} />
      </div>
      <dl class="mt-4 grid gap-3 text-sm">
        <DeviceMeta label="最近同步" value={props.device.lastSyncedAt ?? '从未同步'} />
        <DeviceMeta label="创建时间" value={props.device.createdAt} />
      </dl>
      <DeviceInstallations device={props.device} />
      <DeviceUploadTokens device={props.device} />
      <DeviceAuditTrail auditLogs={props.device.auditLogs ?? []} />
      <div class="mt-4 grid gap-3">
        <DeviceRenameForm device={props.device} />
        <DeviceActionForms device={props.device} />
      </div>
    </article>
  )
}

function DeviceMeta(props: { label: string; value: string }) {
  return (
    <div>
      <dt class="text-xs font-bold uppercase tracking-wide text-[var(--app-muted)]">{props.label}</dt>
      <dd class="mt-1 break-all font-bold text-[var(--app-text)]">{props.value}</dd>
    </div>
  )
}

function DevicesTableHeader() {
  return (
    <TableHeader>
      <TableRow>
        <TableHead>设备</TableHead>
        <TableHead>Platform</TableHead>
        <TableHead>最近同步</TableHead>
        <TableHead>安装 / token</TableHead>
        <TableHead>创建时间</TableHead>
        <TableHead>状态</TableHead>
        <TableHead>操作</TableHead>
      </TableRow>
    </TableHeader>
  )
}

function DeviceRow(props: { device: DeviceViewModel }) {
  return (
    <TableRow>
      <TableCell class="min-w-64">
        <DeviceRenameForm device={props.device} />
      </TableCell>
      <TableCell>{props.device.platform}</TableCell>
      <TableCell>{props.device.lastSyncedAt ?? '从未同步'}</TableCell>
      <TableCell class="min-w-80">
        <DeviceInstallations device={props.device} compact />
        <DeviceUploadTokens device={props.device} compact />
        <DeviceAuditTrail auditLogs={props.device.auditLogs ?? []} compact />
      </TableCell>
      <TableCell>{props.device.createdAt}</TableCell>
      <TableCell>
        <DeviceStatus device={props.device} />
      </TableCell>
      <TableCell>
        <DeviceActionForms device={props.device} />
      </TableCell>
    </TableRow>
  )
}

function DeviceUploadTokens(props: { device: UserDevice; compact?: boolean }) {
  if (props.device.uploadTokens.length === 0) {
    return null
  }

  return (
    <section class={props.compact ? 'mt-3 grid gap-2' : 'mt-4 grid gap-2'}>
      <p class="text-xs font-black uppercase tracking-wide text-[var(--app-muted)]">上传 token</p>
      {props.device.uploadTokens.map((token) => (
        <div class="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-3">
          <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div class="min-w-0 text-sm">
              <p class="truncate font-black text-[var(--app-text)]">{token.name}</p>
              <p class="mt-1 break-all text-xs font-bold text-[var(--app-muted)]">
                {token.installationId ? `安装实例：${token.installationId}` : '未绑定安装实例'}
              </p>
              <p class="mt-1 text-xs text-[var(--app-muted)]">
                最近使用：{token.lastUsedAt ?? '从未使用'}
              </p>
            </div>
            <UploadTokenRevokeForm token={token} />
          </div>
        </div>
      ))}
    </section>
  )
}

function UploadTokenRevokeForm(props: { token: UserDevice['uploadTokens'][number] }) {
  const disabled = props.token.revokedAt !== null
  return (
    <form method="post" data-submit-feedback="true">
      <input type="hidden" name="action" value="revoke-token" />
      <input type="hidden" name="uploadTokenId" value={props.token.id} />
      <Button
        class="w-full sm:w-auto"
        type="submit"
        variant="secondary"
        size="sm"
        disabled={disabled}
        data-confirm="确认只停用这个上传 token？"
        data-submitting-label="正在停用..."
      >
        停用此 token
      </Button>
    </form>
  )
}

function DeviceRenameForm(props: { device: UserDevice }) {
  return (
    <form method="post" class="flex flex-col gap-2 sm:flex-row sm:items-center" data-submit-feedback="true">
      <input type="hidden" name="action" value="rename" />
      <input type="hidden" name="deviceId" value={props.device.id} />
      <Input
        class="mt-0 h-10 py-2"
        name="name"
        value={props.device.name}
        autocomplete="off"
        required
        minLength={1}
      />
      <Button class="w-full sm:w-auto" type="submit" variant="secondary" size="sm" data-submitting-label="正在保存...">保存</Button>
    </form>
  )
}

function DeviceActionForms(props: { device: UserDevice }) {
  return (
    <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
      <DeviceReconnectForm device={props.device} />
      <DeviceRevokeForm device={props.device} />
    </div>
  )
}

function DeviceReconnectForm(props: { device: UserDevice }) {
  return (
    <form method="post" action="/settings/install" data-submit-feedback="true">
      <input type="hidden" name="targetDeviceId" value={props.device.id} />
      <Button class="w-full sm:w-auto" type="submit" variant="secondary" size="sm" data-submitting-label="正在生成...">
        重新连接
      </Button>
    </form>
  )
}

function DeviceRevokeForm(props: { device: UserDevice }) {
  return (
    <form method="post" data-submit-feedback="true">
      <input type="hidden" name="action" value="revoke" />
      <input type="hidden" name="deviceId" value={props.device.id} />
      <Button
        class="w-full sm:w-auto"
        type="submit"
        variant="destructive"
        size="sm"
        disabled={props.device.activeTokenCount <= 0}
        data-confirm="确认停用这个设备的上传 token？"
        data-submitting-label="正在停用..."
        data-submitting-tone="danger"
      >
        停用
      </Button>
    </form>
  )
}

function DeviceInstallations(props: { device: UserDevice; compact?: boolean }) {
  if (props.device.installations.length === 0) {
    return (
      <div class="mt-4 rounded-lg border border-dashed border-[var(--app-border)] p-3 text-xs font-bold text-[var(--app-muted)]">
        暂无安装实例
      </div>
    )
  }

  return (
    <section class={props.compact ? 'grid gap-2' : 'mt-4 grid gap-2'}>
      <p class="text-xs font-black uppercase tracking-wide text-[var(--app-muted)]">安装实例</p>
      {props.device.installations.map((installation) => (
        <div class="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-3">
          <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div class="min-w-0 text-sm">
              <p class="truncate font-black text-[var(--app-text)]">
                {installation.hostname ?? installation.platform}
              </p>
              <p class="mt-1 break-all text-xs font-bold text-[var(--app-muted)]">
                {installation.platform} / {installation.clientVersion ?? '版本未知'}
              </p>
              <p class="mt-1 text-xs text-[var(--app-muted)]">
                最近同步：{installation.lastSeenAt ?? '从未同步'}
              </p>
              <p class="mt-1 text-xs text-[var(--app-muted)]">
                active token：{installation.activeTokenCount}
              </p>
            </div>
            <InstallationRevokeForm installation={installation} />
          </div>
        </div>
      ))}
    </section>
  )
}

function InstallationRevokeForm(props: { installation: UserDevice['installations'][number] }) {
  const disabled = props.installation.revokedAt !== null || props.installation.activeTokenCount <= 0
  return (
    <form method="post" data-submit-feedback="true">
      <input type="hidden" name="action" value="revoke-installation" />
      <input type="hidden" name="installationId" value={props.installation.id} />
      <Button
        class="w-full sm:w-auto"
        type="submit"
        variant="secondary"
        size="sm"
        disabled={disabled}
        data-confirm="确认只停用这个安装实例的上传 token？"
        data-submitting-label="正在停用..."
      >
        停用此安装
      </Button>
    </form>
  )
}

function DeviceAuditTrail(props: { auditLogs: UserDeviceAuditLog[]; compact?: boolean }) {
  if (props.auditLogs.length === 0) return null
  return (
    <section class={props.compact ? 'mt-3 grid gap-1' : 'mt-4 grid gap-1'}>
      <p class="text-xs font-black uppercase tracking-wide text-[var(--app-muted)]">最近操作</p>
      {props.auditLogs.map((log) => (
        <p class="break-all text-xs text-[var(--app-muted)]">
          <span class="font-bold text-[var(--app-text)]">{formatAuditAction(log.action)}</span>
          <span> / {log.createdAt}</span>
        </p>
      ))}
    </section>
  )
}

function formatAuditAction(action: string) {
  const labels: Record<string, string> = {
    'device.pair': '新设备连接',
    'device.reconnect': '旧设备重连',
    'device.rename': '重命名',
    'device.revoke': '停用设备',
    'installation.revoke': '停用安装',
    'token.revoke': '停用 token'
  }
  return labels[action] ?? action
}

function DevicesEmptyState() {
  return (
    <div class="app-surface-subtle rounded-xl border border-dashed border-[var(--app-border)] p-6 text-sm text-[var(--app-muted)]">
      还没有连接设备。
    </div>
  )
}

function DeviceStatus(props: { device: UserDevice }) {
  if (props.device.activeTokenCount <= 0) {
    return <StatusPill tone="muted">已停用</StatusPill>
  }
  if (!props.device.lastSyncedAt) {
    return <StatusPill tone="warning">从未同步</StatusPill>
  }
  if (isStaleSync(props.device.lastSyncedAt)) {
    return <StatusPill tone="warning">长时间未同步</StatusPill>
  }
  return <StatusPill tone="ok">正常</StatusPill>
}

function StatusPill(props: { tone: 'ok' | 'warning' | 'muted'; children: string }) {
  const classes = {
    ok: 'app-status-pill app-status-pill-ok',
    warning: 'app-status-pill app-status-pill-warning',
    muted: 'app-status-pill app-status-pill-muted'
  }
  return <span class={classes[props.tone]}>{props.children}</span>
}

function isStaleSync(lastSyncedAt: string) {
  const last = Date.parse(lastSyncedAt)
  if (!Number.isFinite(last)) return true
  return Date.now() - last > 72 * 60 * 60 * 1000
}
