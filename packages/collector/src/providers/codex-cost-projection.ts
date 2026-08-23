import type { UsageSnapshot } from '@tokenboard/usage-core'

const costUsdScale = 1_000_000
const costUsdScaleBigInt = BigInt(costUsdScale)

type SnapshotEntry = {
  index: number
  snapshot: UsageSnapshot
}

type CostShare = SnapshotEntry & {
  units: bigint
  remainder: bigint
}

// ccusage reports the Codex daily cost as a date-level total, not a per-model cost.
// Project it only after frozen collection batches have been merged.
export function projectCodexDailyCosts(snapshots: UsageSnapshot[]) {
  const entriesByDate = new Map<string, SnapshotEntry[]>()
  snapshots.forEach((snapshot, index) => {
    const key = [snapshot.source, snapshot.usageDate, snapshot.timezone].join('\0')
    const entries = entriesByDate.get(key) ?? []
    entries.push({ index, snapshot })
    entriesByDate.set(key, entries)
  })

  const projected = new Map<number, UsageSnapshot>()
  for (const entries of entriesByDate.values()) {
    for (const [index, snapshot] of projectDailyCostEntries(entries)) {
      projected.set(index, snapshot)
    }
  }

  return snapshots.map((snapshot, index) => projected.get(index) ?? snapshot)
}

function projectDailyCostEntries(entries: SnapshotEntry[]) {
  const projected = new Map<number, UsageSnapshot>()
  const weightedEntries = entries.filter(({ snapshot }) => snapshot.totalTokens > 0)
  for (const entry of entries) {
    projected.set(entry.index, {
      ...entry.snapshot,
      costUsd: costFromUnits(costUnits(entry.snapshot.costUsd))
    })
  }
  if (weightedEntries.length === 0) return projected

  const totalTokens = weightedEntries.reduce((total, { snapshot }) => total + snapshot.totalTokens, 0)
  if (!Number.isSafeInteger(totalTokens) || totalTokens <= 0) {
    throw new Error('Codex daily token total cannot be projected safely')
  }
  const totalCostUnits = costUnits(weightedEntries.reduce((total, { snapshot }) => total + snapshot.costUsd, 0))
  const tokenTotal = BigInt(totalTokens)
  let allocatedUnits = 0n
  const shares = weightedEntries.map((entry) => {
    const numerator = totalCostUnits * BigInt(entry.snapshot.totalTokens)
    const units = numerator / tokenTotal
    allocatedUnits += units
    return { ...entry, units, remainder: numerator % tokenTotal }
  })
  const remainderUnits = totalCostUnits - allocatedUnits
  if (remainderUnits < 0n || remainderUnits >= BigInt(shares.length)) {
    throw new Error('Codex daily cost projection produced an invalid remainder')
  }

  const orderedShares = [...shares].sort(compareCostShares)
  for (let index = 0; index < Number(remainderUnits); index += 1) {
    orderedShares[index].units += 1n
  }
  for (const share of shares) {
    projected.set(share.index, {
      ...share.snapshot,
      costUsd: costFromUnits(share.units)
    })
  }
  return projected
}

function compareCostShares(left: CostShare, right: CostShare) {
  if (left.remainder !== right.remainder) return left.remainder > right.remainder ? -1 : 1
  if (left.snapshot.model !== right.snapshot.model) return left.snapshot.model < right.snapshot.model ? -1 : 1
  return left.index - right.index
}

function costUnits(costUsd: number) {
  const units = Math.round(costUsd * costUsdScale)
  if (!Number.isSafeInteger(units) || units < 0) {
    throw new Error('Codex daily cost cannot be projected at fixed precision')
  }
  return BigInt(units)
}

function costFromUnits(units: bigint) {
  return Number(units) / costUsdScale
}
