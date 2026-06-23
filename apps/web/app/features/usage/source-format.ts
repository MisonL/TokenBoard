import { formatUsd } from '../../lib/money'

const antigravitySource = 'antigravity-cli'
const antigravityCostUnavailableLabel = 'Antigravity CLI 费用不可用'

export type SourceSplitItem = {
  source: string
}

export function formatSource(source: string) {
  if (source === 'claude-code') return 'Claude Code'
  if (source === 'codex') return 'Codex'
  if (source === antigravitySource) return 'Antigravity CLI (agy)'
  if (source === 'all') return '全部来源'
  return source
}

export function hasUnavailableCostSource(sourceSplit: SourceSplitItem[]) {
  return sourceSplit.some((item) => item.source === antigravitySource)
}

export function formatCostWithAvailability(costUsd: number, sourceSplit: SourceSplitItem[]) {
  const formatted = formatUsd(costUsd)
  return hasUnavailableCostSource(sourceSplit)
    ? `${formatted} (${antigravityCostUnavailableLabel})`
    : formatted
}

export function formatSourceCostNote(source: string) {
  return source === antigravitySource ? antigravityCostUnavailableLabel : ''
}
