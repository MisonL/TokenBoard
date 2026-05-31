export function cacheReadRate(input: { cacheReadTokens: number; totalTokens: number }) {
  if (input.totalTokens <= 0) return 0
  return input.cacheReadTokens / input.totalTokens
}

export function cacheReadRateFromTotals(input: {
  totalTokens: number
  totalTokensWithoutCacheRead: number
}) {
  return cacheReadRate({
    cacheReadTokens: input.totalTokens - input.totalTokensWithoutCacheRead,
    totalTokens: input.totalTokens
  })
}

export function formatPercentRate(value: number) {
  return new Intl.NumberFormat('zh-CN', {
    style: 'percent',
    maximumFractionDigits: value > 0 && value < 0.01 ? 1 : 0
  }).format(value)
}
