import { createRoute } from 'honox/factory'
import { AppNav } from '../../components/app-nav'
import { Button, LinkButton } from '../../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { LucideIcon } from '../../components/ui/icon'
import { requireUser } from '../../features/auth/middleware'
import {
  listDeviceAuditLogs,
  listUserDevices,
  parseDeviceNameForm,
  renameDevice,
  rotateUploadToken,
  revokeDevice,
  revokeInstallation,
  revokeUploadToken,
  type UserDeviceAuditLog,
  type UserDevice
} from '../../features/device/service'
import { requireDeviceStepUp } from '../../features/device/step-up'
import { jsonError } from '../../lib/http'
import { LayoutGrid, List, Search, type IconNode } from 'lucide'

export const GET = createRoute(async (c) => {
  const user = await requireUser(c)
  const devices = await listUserDevices(c.env.DB, user.id)
  const view = c.req.query('view') === 'cards' ? 'cards' : 'list'
  const query = c.req.query('query') ?? ''
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
      view={view}
      query={query}
    />
  )
})

export const POST = createRoute(async (c) => {
  try {
    const user = await requireUser(c)
    const form = await c.req.parseBody()
    const action = String(form.action ?? '')
    const deviceId = String(form.deviceId ?? '')
    const view = normalizeDevicesView(form.view)
    const query = String(form.query ?? '')

    if (action === 'rename') {
      await renameDevice(c.env.DB, {
        userId: user.id,
        deviceId,
        name: parseDeviceNameForm(form)
      })
      return c.redirect(buildDevicesUrl({ saved: '1', view, query }), 303)
    }

    if (action === 'revoke') {
      requireDeviceStepUp(c.env, 'device.revoke')
      await revokeDevice(c.env.DB, {
        userId: user.id,
        deviceId
      })
      return c.redirect(buildDevicesUrl({ revoked: '1', view, query }), 303)
    }

    if (action === 'revoke-installation') {
      requireDeviceStepUp(c.env, 'installation.revoke')
      await revokeInstallation(c.env.DB, {
        userId: user.id,
        installationId: String(form.installationId ?? '')
      })
      return c.redirect(buildDevicesUrl({ revoked: 'installation', view, query }), 303)
    }

    if (action === 'revoke-token') {
      requireDeviceStepUp(c.env, 'token.revoke')
      await revokeUploadToken(c.env.DB, {
        userId: user.id,
        uploadTokenId: String(form.uploadTokenId ?? '')
      })
      return c.redirect(buildDevicesUrl({ revoked: 'token', view, query }), 303)
    }

    if (action === 'rotate-token') {
      requireDeviceStepUp(c.env, 'token.rotate')
      const result = await rotateUploadToken(c.env.DB, {
        userId: user.id,
        uploadTokenId: String(form.uploadTokenId ?? '')
      })
      return renderDevicesPage(c, user, {
        rotatedCredentials: result,
        serverOrigin: new URL(c.req.url).origin,
        view,
        query
      })
    }

    return c.redirect(buildDevicesUrl({ view, query }), 303)
  } catch (error) {
    return jsonError(c, error)
  }
})

export function DevicesPage(props: {
  devices: DeviceViewModel[]
  email: string
  saved: boolean
  revoked: string | null
  rotatedUploadToken?: string | null
  rotatedCredentials?: RotatedCredentials | null
  serverOrigin?: string | null
  view?: DevicesView
  query?: string
}) {
  const rotatedCredentials = props.rotatedCredentials ?? credentialsFromLegacyToken(props.rotatedUploadToken)
  const view = props.view ?? 'list'
  const query = props.query ?? ''
  const filteredDevices = filterDevices(props.devices, query)
  const summary = summarizeDevices(filteredDevices)
  const pageState: DevicesPageState = { view, query }
  return (
    <main class="min-h-screen bg-[var(--app-bg)] px-4 py-4 text-[var(--app-text)] sm:px-5 sm:py-6">
      <title>设备管理 - TokenBoard</title>
      <AppNav active="devices" email={props.email} />

      <section class="mx-auto flex max-w-6xl flex-col gap-5">
        <DevicesHeader />
        <DevicePageFlash saved={props.saved} revoked={props.revoked} />
        <RotatedTokenFlash
          credentials={rotatedCredentials}
          serverOrigin={props.serverOrigin ?? null}
        />
        <DevicesOverview summary={summary} visible={filteredDevices.length} total={props.devices.length} />
        <DevicesToolbar view={view} query={query} total={props.devices.length} visible={filteredDevices.length} />
        {filteredDevices.length === 0 ? (
          <DevicesEmptyState query={query} />
        ) : view === 'list' ? (
          <DevicesList devices={filteredDevices} state={pageState} />
        ) : (
          <DevicesCardGrid devices={filteredDevices} state={pageState} />
        )}
      </section>
    </main>
  )
}

type DevicesRenderContext = {
  env: {
    DB: D1Database
  }
  render: (element: ReturnType<typeof DevicesPage>) => Response | Promise<Response>
}

async function renderDevicesPage(
  c: DevicesRenderContext,
  user: { id: string; email: string },
  options: {
    rotatedCredentials?: RotatedCredentials
    serverOrigin?: string
    view?: DevicesView
    query?: string
  } = {}
) {
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
      saved={false}
      revoked={null}
      rotatedCredentials={options.rotatedCredentials}
      serverOrigin={options.serverOrigin}
      view={options.view}
      query={options.query}
    />
  )
}

type DeviceViewModel = UserDevice & {
  auditLogs?: UserDeviceAuditLog[]
}

type DevicesView = 'list' | 'cards'

type RotatedCredentials = {
  uploadToken: string
  deviceId?: string | null
  installationId?: string | null
  installClaim?: string | null
}

function credentialsFromLegacyToken(uploadToken?: string | null): RotatedCredentials | null {
  if (!uploadToken) return null
  return { uploadToken }
}

function DevicesHeader() {
  return (
    <header class="app-surface-raised rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)] p-5">
      <div class="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div class="max-w-2xl">
          <p class="app-accent-text text-sm font-black uppercase tracking-[0.24em]">Devices</p>
          <h1 class="mt-3 text-3xl font-black tracking-tight text-balance sm:text-4xl">设备管理</h1>
          <p class="mt-2 text-sm leading-6 text-pretty text-[var(--app-muted)]">
            查看采集器设备、同步状态、安装实例与上传 token。默认用列表看全局，需要时切到卡片模式逐台处理。
          </p>
        </div>
        <LinkButton class="w-full md:w-auto" href="/settings/install">连接新设备</LinkButton>
      </div>
    </header>
  )
}

type DevicesSummary = ReturnType<typeof summarizeDevices>

function DevicesOverview(props: { summary: DevicesSummary; visible: number; total: number }) {
  return (
    <section
      class="app-surface-subtle grid gap-4 rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)] p-4"
      data-devices-overview="true"
    >
      <div class="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p class="app-accent-text text-xs font-black uppercase tracking-[0.24em]">Overview</p>
          <h2 class="mt-2 text-xl font-black tracking-tight">设备概览</h2>
        </div>
        <p class="text-xs font-bold text-[var(--app-muted)]">
          当前显示 {props.visible} / {props.total} 台设备
        </p>
      </div>
      <dl class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryStat label="设备" value={String(props.summary.deviceCount)} hint="已连接设备总数" />
        <SummaryStat label="安装实例" value={String(props.summary.installationCount)} hint="已登记的安装记录" />
        <SummaryStat label="上传 token" value={String(props.summary.uploadTokenCount)} hint="可用的上传凭证" />
        <SummaryStat label="长时间未同步" value={String(props.summary.staleDeviceCount)} hint="超过 72 小时未同步" />
      </dl>
    </section>
  )
}

function SummaryStat(props: { label: string; value: string; hint: string }) {
  return (
    <div class="rounded-xl border border-[var(--app-border)] bg-[var(--app-bg-soft)] p-3">
      <p class="text-xs font-black uppercase tracking-[0.24em] text-[var(--app-muted)]">{props.label}</p>
      <p class="mt-2 text-2xl font-black tabular-nums text-[var(--app-text)]">{props.value}</p>
      <p class="mt-1 text-xs font-bold leading-5 text-[var(--app-muted)]">{props.hint}</p>
    </div>
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

function DevicesToolbar(props: { view: 'list' | 'cards'; query: string; total: number; visible: number }) {
  const listActive = props.view === 'list'
  const cardsActive = props.view === 'cards'
  return (
    <section class="app-surface-subtle flex flex-col gap-3 rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)] p-4 lg:flex-row lg:items-center lg:justify-between">
      <form method="get" class="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center">
        <label class="flex min-h-11 flex-1 items-center gap-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-input)] px-3 text-sm text-[var(--app-text)]">
          <LucideIcon icon={Search} class="text-[var(--app-muted)]" size={16} />
          <input
            type="search"
            name="query"
            value={props.query}
            aria-label="搜索设备"
            placeholder="按设备名、平台、安装实例或 token 名搜索"
            class="w-full bg-transparent outline-none placeholder:text-[var(--app-subtle)]"
          />
        </label>
        <input type="hidden" name="view" value={props.view} />
        <Button class="w-full sm:w-auto" type="submit" variant="secondary" size="sm">
          搜索
        </Button>
      </form>
      <div class="flex flex-wrap items-center gap-2 lg:justify-end">
        <span class="tabular-nums text-xs font-bold text-[var(--app-muted)]">
          {props.visible} / {props.total}
        </span>
        <ViewToggleButton active={listActive} view="list" label="列表" icon={List} query={props.query} />
        <ViewToggleButton active={cardsActive} view="cards" label="卡片" icon={LayoutGrid} query={props.query} />
      </div>
    </section>
  )
}

function ViewToggleButton(props: { active: boolean; view: 'list' | 'cards'; label: string; icon: IconNode; query: string }) {
  return (
    <a
      data-device-view-toggle={props.view}
      href={buildViewHref(props.view, props.query)}
      class={`inline-flex min-h-11 items-center gap-2 rounded-xl border px-4 py-3 text-sm font-black transition ${
        props.active
          ? 'border-lime-300 bg-lime-300 text-stone-950'
          : 'border-[var(--app-border)] bg-[var(--app-panel-strong)] text-[var(--app-text)] hover:border-lime-300'
      }`}
      aria-current={props.active ? 'page' : undefined}
    >
      <LucideIcon icon={props.icon} size={16} />
      <span>{props.label}</span>
    </a>
  )
}

function buildViewHref(view: 'list' | 'cards', query: string) {
  const params = new URLSearchParams()
  params.set('view', view)
  if (query.trim()) {
    params.set('query', query.trim())
  }
  return `/settings/devices?${params.toString()}`
}

function buildDevicesUrl(options: {
  saved?: string
  revoked?: string
  view: DevicesView
  query: string
}) {
  const params = new URLSearchParams()
  if (options.saved) {
    params.set('saved', options.saved)
  }
  if (options.revoked) {
    params.set('revoked', options.revoked)
  }
  params.set('view', options.view)
  if (options.query.trim()) {
    params.set('query', options.query.trim())
  }
  return `/settings/devices?${params.toString()}`
}

function normalizeDevicesView(value: FormDataEntryValue | null | undefined): DevicesView {
  return value === 'cards' ? 'cards' : 'list'
}

function RotatedTokenFlash(props: {
  credentials: RotatedCredentials | null
  serverOrigin: string | null
}) {
  if (!props.credentials) return null
  const deviceLinkCommands = buildRotatedTokenUpdateCommands(props.credentials, props.serverOrigin)
  return (
    <section class="app-flash-success grid gap-2 p-3 text-sm">
      <p class="font-bold">新的上传 token 只显示一次，请立即更新对应 client 配置。</p>
      <code class="block break-all rounded-lg bg-[var(--app-bg-soft)] p-3 font-mono text-xs text-[var(--app-text)]">
        {props.credentials.uploadToken}
      </code>
      {deviceLinkCommands ? (
        <>
          <p class="text-xs text-[var(--app-muted)]">
            在对应 client 机器执行一次，更新 config 和 device-link 恢复状态，旧 install claim 已失效：
          </p>
          <p class="text-xs font-bold text-[var(--app-muted)]">macOS / Linux / Git Bash</p>
          <code class="block break-all rounded-lg bg-[var(--app-bg-soft)] p-3 font-mono text-xs text-[var(--app-text)]">
            {deviceLinkCommands.bash}
          </code>
          <p class="text-xs font-bold text-[var(--app-muted)]">Windows PowerShell</p>
          <code class="block break-all rounded-lg bg-[var(--app-bg-soft)] p-3 font-mono text-xs text-[var(--app-text)]">
            {deviceLinkCommands.powerShell}
          </code>
        </>
      ) : null}
    </section>
  )
}

function buildRotatedTokenUpdateCommands(credentials: RotatedCredentials, serverOrigin: string | null) {
  if (!serverOrigin || !credentials.deviceId || !credentials.installationId || !credentials.installClaim) {
    return null
  }
  const commandInput = {
    uploadToken: credentials.uploadToken,
    deviceId: credentials.deviceId,
    installationId: credentials.installationId,
    installClaim: credentials.installClaim
  }
  return {
    bash: buildBashRotatedTokenCommand(commandInput, serverOrigin),
    powerShell: buildPowerShellRotatedTokenCommand(commandInput, serverOrigin)
  }
}

type RotatedTokenCommandInput = {
  uploadToken: string
  deviceId: string
  installationId: string
  installClaim: string
}

function buildBashRotatedTokenCommand(credentials: RotatedTokenCommandInput, serverOrigin: string) {
  return [
    'node ~/.tokenboard/TokenBoard/skills/tokenboard/scripts/rotate-token.mjs',
    `--server-origin ${shellQuote(serverOrigin)}`,
    `--upload-token ${shellQuote(credentials.uploadToken)}`,
    `--device-id ${shellQuote(credentials.deviceId)}`,
    `--installation-id ${shellQuote(credentials.installationId)}`,
    `--install-claim ${shellQuote(credentials.installClaim)}`
  ].join(' ')
}

function buildPowerShellRotatedTokenCommand(credentials: RotatedTokenCommandInput, serverOrigin: string) {
  return [
    'node (Join-Path $HOME ".tokenboard\\TokenBoard\\skills\\tokenboard\\scripts\\rotate-token.mjs")',
    `--server-origin ${powerShellQuote(serverOrigin)}`,
    `--upload-token ${powerShellQuote(credentials.uploadToken)}`,
    `--device-id ${powerShellQuote(credentials.deviceId)}`,
    `--installation-id ${powerShellQuote(credentials.installationId)}`,
    `--install-claim ${powerShellQuote(credentials.installClaim)}`
  ].join(' ')
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function powerShellQuote(value: string) {
  return `"${value
    .replaceAll('`', '``')
    .replaceAll('"', '`"')
    .replaceAll('$', '`$')}"`
}

function DevicesCardGrid(props: { devices: DeviceViewModel[]; state: DevicesPageState }) {
  return (
    <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-2" data-devices-card-grid="true">
      {props.devices.map((device) => (
        <DeviceCard device={device} mode="card" state={props.state} />
      ))}
    </div>
  )
}

function DevicesList(props: { devices: DeviceViewModel[]; state: DevicesPageState }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>已连接设备</CardTitle>
        <CardDescription>停用设备只会阻止后续上传，历史用量会继续保留。</CardDescription>
      </CardHeader>
      <CardContent>
        {props.devices.length > 0 ? (
          <div class="grid gap-4" data-devices-list="true">
            {props.devices.map((device) => (
              <DeviceCard device={device} mode="list" state={props.state} />
            ))}
          </div>
        ) : (
          <DevicesEmptyState query={props.state.query} />
        )}
      </CardContent>
    </Card>
  )
}

function DeviceCard(props: { device: DeviceViewModel; mode: 'list' | 'card'; state: DevicesPageState }) {
  const cardTone = props.mode === 'card' ? 'bg-[var(--app-bg-soft)]' : 'bg-[var(--app-panel-strong)]'
  return (
    <article
      class={`app-surface-raised rounded-2xl border border-[var(--app-border)] ${cardTone} p-4 sm:p-5`}
      data-device-card={props.device.id}
      data-device-card-mode={props.mode}
    >
      <div class="flex flex-col gap-5">
        <div class="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <p class="text-xs font-black uppercase tracking-[0.24em] text-[var(--app-muted)]">设备</p>
              <span class="rounded-full border border-[var(--app-border)] bg-[var(--app-bg-soft)] px-3 py-1 text-xs font-bold text-[var(--app-muted)]">
                {formatPlatformLabel(props.device.platform)}
              </span>
              <DeviceStatus device={props.device} />
            </div>

            <div class="mt-3">
              <DeviceRenameForm device={props.device} state={props.state} />
            </div>

            <dl class="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <DeviceMeta label="最近同步" value={props.device.lastSyncedAt ?? '从未同步'} />
              <DeviceMeta label="创建时间" value={props.device.createdAt} />
              <DeviceMeta label="安装实例" value={String(props.device.installations.length)} />
              <DeviceMeta label="上传 token" value={String(props.device.uploadTokens.length)} />
            </dl>
          </div>

          <div class="xl:w-[18rem]">
            <DeviceActionForms device={props.device} state={props.state} />
          </div>
        </div>

        <div class="grid gap-4 xl:grid-cols-2">
          <DeviceInstallations device={props.device} state={props.state} />
          <DeviceUploadTokens device={props.device} state={props.state} />
        </div>

        <DeviceAuditTrail auditLogs={props.device.auditLogs ?? []} />
      </div>
    </article>
  )
}

function DeviceMeta(props: { label: string; value: string }) {
  return (
    <div class="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] p-3">
      <dt class="text-xs font-black uppercase tracking-wide text-[var(--app-muted)]">{props.label}</dt>
      <dd class="mt-1 break-all font-black text-[var(--app-text)]">{props.value}</dd>
    </div>
  )
}

function DeviceUploadTokens(props: { device: UserDevice; state: DevicesPageState }) {
  if (props.device.uploadTokens.length === 0) {
    return (
      <div class="grid gap-2">
        <p class="text-xs font-black uppercase tracking-[0.24em] text-[var(--app-muted)]">上传 token</p>
        <div class="rounded-xl border border-dashed border-[var(--app-border)] bg-[var(--app-panel)] p-3 text-xs font-bold text-[var(--app-muted)]">
          暂无上传 token
        </div>
      </div>
    )
  }

  return (
    <section class="grid gap-2">
      <p class="text-xs font-black uppercase tracking-[0.24em] text-[var(--app-muted)]">上传 token</p>
      {props.device.uploadTokens.map((token) => (
        <div class="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] p-3">
          <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div class="min-w-0 text-sm">
              <p class="truncate font-black text-[var(--app-text)]">{token.name}</p>
              <p class="mt-1 break-all text-xs font-bold text-[var(--app-muted)]">
                {token.installationId ? `安装实例：${token.installationId}` : '未绑定安装实例'}
              </p>
              <p class="mt-1 text-xs text-[var(--app-muted)]">最近使用：{token.lastUsedAt ?? '从未使用'}</p>
            </div>
            <div class="flex flex-col gap-2 sm:items-end">
              <UploadTokenRotateForm token={token} state={props.state} />
              <UploadTokenRevokeForm token={token} state={props.state} />
            </div>
          </div>
        </div>
      ))}
    </section>
  )
}

function UploadTokenRotateForm(props: { token: UserDevice['uploadTokens'][number]; state: DevicesPageState }) {
  const disabled = props.token.revokedAt !== null
  return (
    <form method="post" data-submit-feedback="true">
      <input type="hidden" name="action" value="rotate-token" />
      <input type="hidden" name="uploadTokenId" value={props.token.id} />
      <input type="hidden" name="view" value={props.state.view} />
      <input type="hidden" name="query" value={props.state.query} />
      <Button
        class="w-full sm:w-auto"
        type="submit"
        variant="secondary"
        size="sm"
        disabled={disabled}
        data-confirm="确认轮换这个上传 token？旧 token 会立即停用，新 token 只显示一次。"
        data-submitting-label="正在轮换..."
      >
        轮换 token
      </Button>
    </form>
  )
}

function UploadTokenRevokeForm(props: { token: UserDevice['uploadTokens'][number]; state: DevicesPageState }) {
  const disabled = props.token.revokedAt !== null
  return (
    <form method="post" data-submit-feedback="true">
      <input type="hidden" name="action" value="revoke-token" />
      <input type="hidden" name="uploadTokenId" value={props.token.id} />
      <input type="hidden" name="view" value={props.state.view} />
      <input type="hidden" name="query" value={props.state.query} />
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

function DeviceRenameForm(props: { device: UserDevice; state: DevicesPageState }) {
  return (
    <form method="post" class="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end" data-submit-feedback="true">
      <input type="hidden" name="action" value="rename" />
      <input type="hidden" name="deviceId" value={props.device.id} />
      <input type="hidden" name="view" value={props.state.view} />
      <input type="hidden" name="query" value={props.state.query} />
      <Input
        class="mt-0 h-11 py-2"
        name="name"
        value={props.device.name}
        autocomplete="off"
        required
        minLength={1}
      />
      <Button class="w-full sm:w-auto" type="submit" variant="secondary" size="sm" data-submitting-label="正在保存...">
        保存
      </Button>
    </form>
  )
}

function DeviceActionForms(props: { device: UserDevice; state: DevicesPageState }) {
  return (
    <div class="flex flex-col gap-2 rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg-soft)] p-3">
      <p class="text-xs font-black uppercase tracking-[0.24em] text-[var(--app-muted)]">设备操作</p>
      <DeviceReconnectForm device={props.device} />
      <DeviceRevokeForm device={props.device} state={props.state} />
    </div>
  )
}

function DeviceReconnectForm(props: { device: UserDevice }) {
  return (
    <form method="post" action="/settings/install" data-submit-feedback="true">
      <input type="hidden" name="targetDeviceId" value={props.device.id} />
      <Button class="w-full" type="submit" variant="secondary" size="sm" data-submitting-label="正在生成...">
        重新连接
      </Button>
    </form>
  )
}

function DeviceRevokeForm(props: { device: UserDevice; state: DevicesPageState }) {
  return (
    <form method="post" data-submit-feedback="true">
      <input type="hidden" name="action" value="revoke" />
      <input type="hidden" name="deviceId" value={props.device.id} />
      <input type="hidden" name="view" value={props.state.view} />
      <input type="hidden" name="query" value={props.state.query} />
      <Button
        class="w-full"
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

function DeviceInstallations(props: { device: UserDevice; state: DevicesPageState }) {
  if (props.device.installations.length === 0) {
    return (
      <div class="grid gap-2">
        <p class="text-xs font-black uppercase tracking-[0.24em] text-[var(--app-muted)]">安装实例</p>
        <div class="rounded-xl border border-dashed border-[var(--app-border)] bg-[var(--app-panel)] p-3 text-xs font-bold text-[var(--app-muted)]">
          暂无安装实例
        </div>
      </div>
    )
  }

  return (
    <section class="grid gap-2">
      <p class="text-xs font-black uppercase tracking-[0.24em] text-[var(--app-muted)]">安装实例</p>
      {props.device.installations.map((installation) => (
        <div class="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] p-3">
          <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div class="min-w-0 text-sm">
              <p class="truncate font-black text-[var(--app-text)]">
                {installation.hostname ?? formatPlatformLabel(installation.platform)}
              </p>
              <p class="mt-1 break-all text-xs font-bold text-[var(--app-muted)]">
                {formatPlatformLabel(installation.platform)} / {installation.clientVersion ?? '版本未知'}
              </p>
              <p class="mt-1 text-xs text-[var(--app-muted)]">最近同步：{installation.lastSeenAt ?? '从未同步'}</p>
              <p class="mt-1 text-xs text-[var(--app-muted)]">active token：{installation.activeTokenCount}</p>
            </div>
            <InstallationRevokeForm installation={installation} state={props.state} />
          </div>
        </div>
      ))}
    </section>
  )
}

function InstallationRevokeForm(props: { installation: UserDevice['installations'][number]; state: DevicesPageState }) {
  const disabled = props.installation.revokedAt !== null || props.installation.activeTokenCount <= 0
  return (
    <form method="post" data-submit-feedback="true">
      <input type="hidden" name="action" value="revoke-installation" />
      <input type="hidden" name="installationId" value={props.installation.id} />
      <input type="hidden" name="view" value={props.state.view} />
      <input type="hidden" name="query" value={props.state.query} />
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

function DeviceAuditTrail(props: { auditLogs: UserDeviceAuditLog[] }) {
  if (props.auditLogs.length === 0) return null
  return (
    <section class="grid gap-2">
      <p class="text-xs font-black uppercase tracking-[0.24em] text-[var(--app-muted)]">最近操作</p>
      <div class="grid gap-2">
        {props.auditLogs.map((log) => (
          <p class="break-all text-xs text-[var(--app-muted)]">
            <span class="font-bold text-[var(--app-text)]">{formatAuditAction(log.action)}</span>
            <span> / {log.createdAt}</span>
          </p>
        ))}
      </div>
    </section>
  )
}

function summarizeDevices(devices: DeviceViewModel[]) {
  return devices.reduce(
    (summary, device) => {
      summary.deviceCount += 1
      summary.installationCount += device.installations.length
      summary.uploadTokenCount += device.uploadTokens.length
      if (device.lastSyncedAt && isStaleSync(device.lastSyncedAt)) {
        summary.staleDeviceCount += 1
      }
      return summary
    },
    {
      deviceCount: 0,
      installationCount: 0,
      uploadTokenCount: 0,
      staleDeviceCount: 0
    }
  )
}

type DevicesPageState = {
  view: DevicesView
  query: string
}

function filterDevices(devices: DeviceViewModel[], query: string) {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return devices
  return devices.filter((device) => {
    const haystack = [
      device.name,
      device.platform,
      formatPlatformLabel(device.platform),
      device.createdAt,
      device.lastSyncedAt ?? '',
      ...device.installations.flatMap((installation) => [
        installation.hostname ?? '',
        installation.platform,
        formatPlatformLabel(installation.platform),
        installation.clientVersion ?? ''
      ]),
      ...device.uploadTokens.flatMap((token) => [token.name, token.installationId ?? '', token.lastUsedAt ?? '']),
      ...((device.auditLogs ?? []).map((log) => `${log.action} ${log.createdAt}`))
    ]
      .join(' ')
      .toLowerCase()
    return haystack.includes(normalized)
  })
}

function formatPlatformLabel(platform: string) {
  const labels: Record<string, string> = {
    darwin: 'macOS',
    linux: 'Linux',
    win32: 'Windows',
    browser: 'Browser',
    'browser-e2e': 'Browser E2E'
  }
  return labels[platform] ?? platform
}

function formatAuditAction(action: string) {
  const labels: Record<string, string> = {
    'device.pair': '新设备连接',
    'device.reconnect': '旧设备重连',
    'device.rename': '重命名',
    'device.revoke': '停用设备',
    'installation.revoke': '停用安装',
    'token.rotate': '轮换 token',
    'token.revoke': '停用 token'
  }
  return labels[action] ?? action
}

function DevicesEmptyState(props: { query?: string }) {
  const hasQuery = props.query?.trim()
  return (
    <div
      class="app-surface-subtle rounded-2xl border border-dashed border-[var(--app-border)] bg-[var(--app-bg-soft)] p-6 text-sm text-[var(--app-muted)]"
      data-devices-empty-state="true"
    >
      {hasQuery ? `没有找到匹配「${hasQuery}」的设备。` : '还没有连接设备。'}
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
