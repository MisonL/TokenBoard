import { formatUsd } from '../../lib/money'

const antigravityCostUnavailableLabels: Record<string, string> = {
  'antigravity-cli': 'Antigravity CLI 费用不可用',
  antigravity: 'Antigravity 费用不可用',
  'antigravity-ide': 'Antigravity IDE 费用不可用'
}
const antigravityCostUnavailableLabel = 'Antigravity 费用不可用'

export type SourceSplitItem = {
  source: string
}

export function formatSource(source: string) {
  if (source === 'claude-code') return 'Claude Code'
  if (source === 'codex') return 'Codex'
  if (source === 'antigravity-cli') return 'Antigravity CLI (agy)'
  if (source === 'antigravity') return 'Antigravity'
  if (source === 'antigravity-ide') return 'Antigravity IDE'
  if (source === 'all') return '全部来源'
  return source
}

export function hasUnavailableCostSource(sourceSplit: SourceSplitItem[]) {
  return sourceSplit.some((item) => item.source in antigravityCostUnavailableLabels)
}

export function formatCostWithAvailability(costUsd: number, sourceSplit: SourceSplitItem[]) {
  const formatted = formatUsd(costUsd)
  const label = formatUnavailableCostLabel(sourceSplit)
  return label
    ? `${formatted} (${label})`
    : formatted
}

export function formatSourceCostNote(source: string) {
  return antigravityCostUnavailableLabels[source] ?? ''
}

function formatUnavailableCostLabel(sourceSplit: SourceSplitItem[]) {
  const labels = new Set(sourceSplit
    .map((item) => antigravityCostUnavailableLabels[item.source])
    .filter((label): label is string => Boolean(label)))
  if (labels.size === 0) return ''
  if (labels.size === 1) return [...labels][0]
  return antigravityCostUnavailableLabel
}
