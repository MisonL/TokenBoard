import { Badge } from '../../../components/ui/badge'
import { Card, CardContent, CardHeader } from '../../../components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../../components/ui/table'
import { cn } from '../../../lib/cn'
import { formatUsd } from '../../../lib/money'
import { formatPercentRate } from '../../../lib/usage-metrics'
import type { LeaderboardEntry, LeaderboardSourceBreakdown } from '../queries'
import { costUnavailableSourceNames, formatSource } from '../../usage/source-format'

type LeaderboardMetric = 'tokens' | 'tokens-without-cache-read' | 'cost'

export type LeaderboardPanelProps = {
  entries: LeaderboardEntry[]
  period: 'daily' | 'monthly'
  metric: LeaderboardMetric
  /** The window this page ranked — `2026-05-01` daily, `2026-05` monthly. */
  rangeLabel: string
  /** The zone the window was measured in, which is the viewer's own. */
  timezone: string
  /** The offset of `timezone` right now, e.g. `UTC+8`. */
  timezoneLabel: string
}

export function LeaderboardPanel(props: LeaderboardPanelProps) {
  const title = `${props.period === 'monthly' ? '每月' : '每日'}${metricTitle(props.metric)}排名`

  return (
    <div data-leaderboard-panel="true">
      <Card class="mx-auto max-w-6xl rounded-2xl">
        <LeaderboardPanelHeader
          title={title}
          period={props.period}
          metric={props.metric}
          rangeLabel={props.rangeLabel}
          timezone={props.timezone}
          timezoneLabel={props.timezoneLabel}
        />
        <LeaderboardPanelContent entries={props.entries} />
      </Card>
    </div>
  )
}

function LeaderboardPanelHeader(props: {
  title: string
  period: 'daily' | 'monthly'
  metric: LeaderboardMetric
  rangeLabel: string
  timezone: string
  timezoneLabel: string
}) {
  return (
    <CardHeader class="flex-col gap-4 border-b border-[var(--app-border)] md:flex-row md:items-end md:justify-between">
      <div>
        <Badge>排行榜</Badge>
        <h1 class="mt-3 text-3xl font-black tracking-tight sm:text-4xl">{props.title}</h1>
        <LeaderboardRangeCaption
          period={props.period}
          rangeLabel={props.rangeLabel}
          timezone={props.timezone}
          timezoneLabel={props.timezoneLabel}
        />
        <p class="mt-2 max-w-2xl text-sm text-[var(--app-muted)]">
          {costUnavailableSourceNames().join('、')} 费用不可用，费用列和费用排名不包含这些来源成本。主要模型和来源占比按
          total token 计算。
        </p>
      </div>
      <div class="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
        <SegmentedControl items={periodItems(props.period, props.metric)} />
        <SegmentedControl items={metricItems(props.period, props.metric)} />
      </div>
    </CardHeader>
  )
}

// The board is the one surface that spans users, and `usage_date` is stamped by each collector
// in its own local zone — so two rows labelled `2026-05-01` were collected 16 hours apart. The
// window below is the one this page actually ranked, and the note says why a viewer abroad may
// see a different set of rows than they would expect from the same date.
function LeaderboardRangeCaption(props: {
  period: 'daily' | 'monthly'
  rangeLabel: string
  timezone: string
  timezoneLabel: string
}) {
  const rangeText = props.period === 'monthly' ? `${props.rangeLabel} 当月` : `${props.rangeLabel} 当天`

  return (
    <div class="mt-3 flex flex-col gap-1" data-leaderboard-range="true">
      <p class="text-sm font-bold text-[var(--app-text)]">
        统计范围：{rangeText}
        <span class="ml-2 font-normal text-[var(--app-muted)]">
          （{props.timezone}，{props.timezoneLabel}）
        </span>
      </p>
      <p class="max-w-2xl text-xs text-[var(--app-muted)]">
        每位用户的用量按各自本地时区归属到日期，跨时区对比时同一天的绝对时间窗口并不完全重合。
      </p>
    </div>
  )
}

function LeaderboardPanelContent(props: { entries: LeaderboardEntry[] }) {
  return (
    <CardContent class="pt-5">
      {props.entries.length > 0 ? (
        <>
          <div class="grid gap-3 md:hidden" data-leaderboard-mobile-list="true">
            {props.entries.map((entry) => (
              <LeaderboardMobileItem entry={entry} />
            ))}
          </div>
          <LeaderboardTable entries={props.entries} />
        </>
      ) : (
        <div
          class="app-surface-subtle rounded-xl border border-dashed border-[var(--app-border)] bg-[var(--app-bg-soft)] px-4 py-8 text-center text-sm text-[var(--app-muted)]"
          data-leaderboard-empty="true"
        >
          还没有公开排行榜数据。
        </div>
      )}
    </CardContent>
  )
}

function periodItems(period: 'daily' | 'monthly', metric: LeaderboardMetric) {
  return [
    { label: '每日', href: leaderboardHref('daily', metric), active: period === 'daily' },
    { label: '每月', href: leaderboardHref('monthly', metric), active: period === 'monthly' }
  ]
}

function metricItems(period: 'daily' | 'monthly', metric: LeaderboardMetric) {
  return [
    { label: 'Tokens', href: leaderboardHref(period, 'tokens'), active: metric === 'tokens' },
    {
      label: '不含缓存读',
      href: leaderboardHref(period, 'tokens-without-cache-read'),
      active: metric === 'tokens-without-cache-read'
    },
    { label: '费用', href: leaderboardHref(period, 'cost'), active: metric === 'cost' }
  ]
}

function LeaderboardMobileItem(props: { entry: LeaderboardEntry }) {
  return (
    <article
      class={cn(
        'app-surface-raised rounded-xl border border-[var(--app-border)] bg-[var(--app-bg-soft)] p-4',
        props.entry.isCurrentViewer && 'border-lime-400/70 ring-1 ring-lime-400/70'
      )}
      data-leaderboard-entry="true"
      data-leaderboard-current-user={props.entry.isCurrentViewer ? 'true' : undefined}
    >
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <RankBadge rank={props.entry.rank} />
            <CurrentViewerBadge isCurrentViewer={props.entry.isCurrentViewer} />
          </div>
          <h2 class="mt-1 truncate text-lg font-black">{props.entry.displayName}</h2>
        </div>
        <p class="shrink-0 text-sm font-bold text-[var(--app-muted)]">{formatLeaderboardCost(props.entry)}</p>
      </div>{' '}
      <dl class="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div class="min-w-0">
          <dt class="text-xs font-bold uppercase text-[var(--app-muted)]">Tokens</dt>
          <dd class="mt-1 break-words font-black tabular-nums">{formatInteger(props.entry.totalTokens)}</dd>
        </div>
        <div class="min-w-0">
          <dt class="text-xs font-bold uppercase text-[var(--app-muted)]">不含缓存读</dt>
          <dd class="mt-1 break-words font-black tabular-nums">
            {formatInteger(props.entry.totalTokensWithoutCacheRead)}
          </dd>
        </div>
        <div class="min-w-0">
          <dt class="text-xs font-bold uppercase text-[var(--app-muted)]">费用</dt>
          <dd class="mt-1 break-words font-black tabular-nums">{formatLeaderboardCost(props.entry)}</dd>
        </div>
        <div class="min-w-0">
          <dt class="text-xs font-bold uppercase text-[var(--app-muted)]">缓存率</dt>
          <dd class="mt-1 break-words font-black tabular-nums">{formatPercentRate(props.entry.cacheReadRate)}</dd>
        </div>
      </dl>
      <dl class="mt-3 grid grid-cols-1 gap-3 text-sm">
        <div class="min-w-0">
          <dt class="text-xs font-bold uppercase text-[var(--app-muted)]">主要模型</dt>
          <dd class="mt-1 break-words font-bold [overflow-wrap:anywhere]">
            {formatPrimaryModel(props.entry.primaryModel)}
          </dd>
        </div>
        <div class="min-w-0">
          <dt class="text-xs font-bold uppercase text-[var(--app-muted)]">来源占比</dt>
          <dd class="mt-1">
            <LeaderboardSourceShare breakdown={props.entry.sourceBreakdown} />
          </dd>
        </div>
      </dl>
    </article>
  )
}

function LeaderboardTable(props: { entries: LeaderboardEntry[] }) {
  return (
    <div class="hidden overflow-x-auto md:block" data-leaderboard-desktop-table="true">
      <Table class="min-w-[860px] border-separate border-spacing-y-2">
        <TableHeader>
          <TableRow class="border-0">
            <TableHead>排名</TableHead>
            <TableHead>用户</TableHead>
            <TableHead>主要模型</TableHead>
            <TableHead>来源占比</TableHead>
            <TableHead>Tokens</TableHead>
            <TableHead>不含缓存读</TableHead>
            <TableHead>缓存率</TableHead>
            <TableHead>费用</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {props.entries.map((entry) => (
            <TableRow class={cn('border-0 bg-[var(--app-bg-soft)]', entry.isCurrentViewer && 'bg-lime-300/10')}>
              <TableCell class={cn('rounded-l-xl', entry.isCurrentViewer && 'border-l-2 border-lime-400')}>
                <div
                  class="flex flex-wrap items-center gap-2"
                  data-leaderboard-entry="true"
                  data-leaderboard-current-user={entry.isCurrentViewer ? 'true' : undefined}
                >
                  <RankBadge rank={entry.rank} />
                  <CurrentViewerBadge isCurrentViewer={entry.isCurrentViewer} />
                </div>
              </TableCell>
              <TableCell>{entry.displayName}</TableCell>
              <TableCell class="max-w-[18rem]">
                <span class="block break-words font-bold [overflow-wrap:anywhere]" title={entry.primaryModel ?? ''}>
                  {formatPrimaryModel(entry.primaryModel)}
                </span>
              </TableCell>
              <TableCell class="align-top">
                <LeaderboardSourceShare breakdown={entry.sourceBreakdown} />
              </TableCell>
              <TableCell class="font-bold">{formatInteger(entry.totalTokens)}</TableCell>
              <TableCell class="font-bold">{formatInteger(entry.totalTokensWithoutCacheRead)}</TableCell>
              <TableCell class="font-bold">{formatPercentRate(entry.cacheReadRate)}</TableCell>
              <TableCell
                class={cn(
                  'rounded-r-xl text-[var(--app-muted)]',
                  entry.isCurrentViewer && 'border-r-2 border-lime-400'
                )}
              >
                {formatLeaderboardCost(entry)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

// The viewer's own row is the one row on a page of strangers they care about, and the board is
// long enough that finding it by name is work. The marker is a plain boolean from the query —
// the row never carries an id — so an anonymous viewer (or a signed-in one whose row is not on
// this page) simply gets no marker.
function CurrentViewerBadge(props: { isCurrentViewer: boolean }) {
  if (!props.isCurrentViewer) return null

  return (
    <span
      class="rounded-full bg-lime-300 px-2 py-0.5 text-[11px] font-black text-stone-950"
      data-leaderboard-current-user-badge="true"
    >
      我
    </span>
  )
}

// Up to two sources are named; the rest collapse into one remainder so a user running many
// sources still fits the cell. The full breakdown stays available as the element's title.
function LeaderboardSourceShare(props: { breakdown: LeaderboardSourceBreakdown[] }) {
  if (props.breakdown.length === 0) return <span class="text-[var(--app-muted)]">—</span>

  const named = props.breakdown.slice(0, 2)
  const rest = props.breakdown.slice(2)
  const restShare = rest.reduce((total, item) => total + item.share, 0)

  return (
    <div class="min-w-0 space-y-1" data-leaderboard-source-share="true" title={sourceShareTitle(props.breakdown)}>
      {named.map((item) => (
        <div class="flex items-baseline justify-between gap-2 text-xs">
          <span class="min-w-0 truncate">{formatSource(item.source)}</span>
          <span class="shrink-0 font-bold text-[var(--app-text)] tabular-nums">{formatShare(item.share)}</span>
        </div>
      ))}
      {rest.length > 0 ? (
        <div class="flex items-baseline justify-between gap-2 text-xs text-[var(--app-muted)]">
          <span class="min-w-0 truncate">其他 {rest.length} 个来源</span>
          <span class="shrink-0 font-bold tabular-nums">{formatShare(restShare)}</span>
        </div>
      ) : null}
    </div>
  )
}

function sourceShareTitle(breakdown: LeaderboardSourceBreakdown[]) {
  return breakdown.map((item) => `${formatSource(item.source)} ${formatShare(item.share)}`).join(' / ')
}

// Rounded to whole percent like every other share on the site, but never to `0%`: a source that
// is listed at all put tokens on the board, and "0%" would read as a display bug rather than a
// small contribution.
function formatShare(share: number) {
  if (!(share > 0)) return '0%'
  return `${Math.max(1, Math.round(share * 100))}%`
}

function formatPrimaryModel(model: string | null) {
  return model ?? '—'
}

function RankBadge(props: { rank: number }) {
  return <span class="app-rank-badge">#{props.rank}</span>
}

function formatInteger(value: number) {
  return new Intl.NumberFormat('en-US').format(value)
}

function formatLeaderboardCost(entry: LeaderboardEntry) {
  return entry.costAvailable ? formatUsd(entry.costUsd) : '费用不可用'
}

function metricTitle(metric: LeaderboardMetric) {
  if (metric === 'cost') return '费用'
  if (metric === 'tokens-without-cache-read') return '不含缓存读 token'
  return ' token'
}

function leaderboardHref(period: 'daily' | 'monthly', metric: LeaderboardMetric) {
  return `/leaderboards?period=${period}&metric=${metric}`
}

function SegmentedControl(props: { items: Array<{ label: string; href: string; active: boolean }> }) {
  return (
    <div
      class={cn(
        'grid rounded-full border border-[var(--app-border)] p-1 text-sm text-[var(--app-muted)] sm:flex',
        props.items.length === 3 ? 'grid-cols-3' : 'grid-cols-2'
      )}
    >
      {props.items.map((item) =>
        item.active ? (
          <Badge class="w-full justify-center sm:w-auto">{item.label}</Badge>
        ) : (
          <a
            class={cn(
              'inline-flex min-h-11 w-full items-center justify-center rounded-full px-4 py-2 text-xs font-black text-[var(--app-muted)] transition hover:bg-[var(--app-hover)] hover:text-[var(--app-text)] sm:w-auto'
            )}
            href={item.href}
            data-leaderboard-link="true"
          >
            {item.label}
          </a>
        )
      )}
    </div>
  )
}
