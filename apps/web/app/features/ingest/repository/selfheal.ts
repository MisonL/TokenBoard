import {
  listSummaryKeysNeedingRefresh,
  nextAggregateTimestamp,
  prepareSummaryRefresh,
  prepareUserTotalFromSummaryRefresh
} from './refresh'
import {
  deleteOrphanSummaryRowSql,
  selfHealCandidateUsersSql,
  selfHealOrphanSummaryRowsSql,
  selfHealStateId,
  selfHealSummaryKeysCursorSql,
  selfHealSummaryKeysInitialSql,
  totalRepairCheckSql
} from './selfheal-sql'
import { readUsageSummaryStateRow, writeUsageSummaryStateRow } from './backfill'
import { d1MaxBoundParameters, runStatementBatches, type UsageSummaryKey } from './types'

// The daily aggregate self-heal pass (batch B6). Once per maintenance window it walks the
// derived state — summaries against raw rows, orphans against summaries, totals against
// summaries — and repairs what disagrees. Each sweep is cursor-bounded and the cursor persists
// between calls, so a call never becomes an unbounded scan even on a large account, while a
// day's worth of chunks still finishes a round quickly at the current keyspace. When the walk
// runs out it starts over: the round period scales with the keyspace instead of degrading to a
// fixed multi-day cadence.
//
// This pass is the only channel that fixes drift the incremental totals path cannot see: a
// difference keeps whatever the stored aggregate already claimed, so a summary row deleted
// behind the client's back leaves the totals over-counting forever. The probe in
// docs/research/2026-11-25-d1-write-probe/delta-correctness-probe.mjs reproduced that drift
// (125 → 250 after a delete followed by a re-upload). Removing the per-request full
// reconciliations without this pass online makes every such drift permanent, so the two
// changes ship in the same batch. The `repaired` counters are also the drift evidence the
// summary-strict cutover (C1) observes before it flips.
//
// The state shares the usage_summary_backfill_state table under its own id: an unfinished
// initial backfill never blocks a heal round, and a heal never touches the backfill's
// completion marker (which gates the totals writers).
export const defaultSelfHealChunkSize = 500
export const maxSelfHealChunkSize = 2000
// Statement budget guard: a chunk issues one write per repaired key, so bounding chunks bounds
// one scheduled tick's work even when an entire sweep needs repairs.
export const defaultSelfHealChunks = 20

type SelfHealSweep = 'summaries' | 'orphans' | 'totals'

type SelfHealState = {
  sweep: SelfHealSweep
  cursorUserId: string | null
  cursorUsageDate: string | null
  cursorSource: string | null
  cursorModel: string | null
  // When the previous full round finished, kept on the row purely as an observation record;
  // it gates nothing (the totals writers read the *initial* backfill row's gate).
  lastRoundCompletedAt: string | null
}

// The cursor carries the four key columns loosely: the `totals` sweep tracks users only, so its
// cursor leaves the rest null while the summary/orphan sweeps fill all four.
type SelfHealCursor = {
  userId: string | null
  usageDate: string | null
  source: string | null
  model: string | null
}

export type SelfHealResult = {
  summariesChecked: number
  summariesRepaired: number
  orphansRemoved: number
  totalsChecked: number
  totalsRepaired: number
  roundCompleted: boolean
}

export async function selfHealAggregates(input: {
  db: D1Database
  chunkSize?: number
  maxChunks?: number
}): Promise<SelfHealResult> {
  const chunkSize = input.chunkSize ?? defaultSelfHealChunkSize
  const maxChunks = input.maxChunks ?? defaultSelfHealChunks
  const result: SelfHealResult = {
    summariesChecked: 0,
    summariesRepaired: 0,
    orphansRemoved: 0,
    totalsChecked: 0,
    totalsRepaired: 0,
    roundCompleted: false
  }

  for (let used = 0; used < maxChunks; used += 1) {
    const state = await readSelfHealState(input.db)
    const outcome = await runChunk(input.db, state, chunkSize)
    const exhausted = outcome.rows < chunkSize

    if (exhausted) {
      // The sweep ran out. Advance it; a round finishes when `totals` runs out, and the reset
      // back to `summaries` is what starts the next round.
      const next = nextSweep(state.sweep)
      if (next === 'done') {
        await writeRoundCompleted(input.db, state.lastRoundCompletedAt)
        result.roundCompleted = true
      } else {
        await writeSelfHealState(input.db, {
          sweep: next,
          cursorUserId: null,
          cursorUsageDate: null,
          cursorSource: null,
          cursorModel: null,
          lastRoundCompletedAt: state.lastRoundCompletedAt
        })
      }
    } else {
      await writeSelfHealState(input.db, resumeSweep(state, outcome.cursor))
    }

    accumulate(result, state.sweep, outcome)
    if (state.sweep === 'totals' && exhausted) break
  }
  return result
}

export function selfHealChunkSize(env: { TOKENBOARD_USAGE_SELFHEAL_LIMIT?: string }) {
  const raw = env.TOKENBOARD_USAGE_SELFHEAL_LIMIT
  if (raw === undefined) return defaultSelfHealChunkSize
  const value = raw.trim()
  if (!/^\d+$/.test(value)) {
    throw new Error(`TOKENBOARD_USAGE_SELFHEAL_LIMIT must be an integer from 1 to ${maxSelfHealChunkSize}`)
  }
  const limit = Number(value)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxSelfHealChunkSize) {
    throw new Error(`TOKENBOARD_USAGE_SELFHEAL_LIMIT must be an integer from 1 to ${maxSelfHealChunkSize}`)
  }
  return limit
}

function nextSweep(sweep: SelfHealSweep): SelfHealSweep | 'done' {
  if (sweep === 'summaries') return 'orphans'
  if (sweep === 'orphans') return 'totals'
  return 'done'
}

function accumulate(result: SelfHealResult, sweep: SelfHealSweep, outcome: ChunkOutcome) {
  if (sweep === 'summaries') {
    result.summariesChecked += outcome.rows
    result.summariesRepaired += outcome.repaired
  } else if (sweep === 'orphans') {
    result.orphansRemoved += outcome.rows
  } else {
    result.totalsChecked += outcome.rows
    result.totalsRepaired += outcome.repaired
  }
}

type ChunkOutcome = { rows: number; repaired: number; cursor: SelfHealCursor | null }

async function runChunk(db: D1Database, state: SelfHealState, chunkSize: number): Promise<ChunkOutcome> {
  if (state.sweep === 'summaries') return healSummaries(db, state, chunkSize)
  if (state.sweep === 'orphans') return healOrphans(db, state, chunkSize)
  return healTotals(db, state, chunkSize)
}

async function healSummaries(db: D1Database, state: SelfHealState, chunkSize: number): Promise<ChunkOutcome> {
  const statement = state.cursorUserId
    ? db
        .prepare(selfHealSummaryKeysCursorSql)
        .bind(state.cursorUserId, state.cursorUsageDate, state.cursorSource, state.cursorModel, chunkSize)
    : db.prepare(selfHealSummaryKeysInitialSql).bind(chunkSize)
  const keys = (await statement.all<UsageSummaryKey>()).results ?? []
  // The same expected-vs-stored comparison the per-request path uses, so both ask the identical
  // question; only disagreeing keys are written.
  const stale = await listSummaryKeysNeedingRefresh(db, keys)
  if (stale.length > 0) {
    const stamp = nextAggregateTimestamp().toISOString()
    await runStatementBatches(
      db,
      stale.map((key) => prepareSummaryRefresh(db, key, stamp))
    )
  }
  return { rows: keys.length, repaired: stale.length, cursor: toCursor(keys.at(-1)) }
}

async function healOrphans(db: D1Database, state: SelfHealState, chunkSize: number): Promise<ChunkOutcome> {
  // A sweep that has not started yet must seek from the very first row, so the initial cursor
  // uses the empty string (which compares below every real key): a row-value comparison against
  // NULL is never true and would silently end the sweep.
  const rows =
    (
      await db
        .prepare(selfHealOrphanSummaryRowsSql)
        .bind(
          state.cursorUserId ?? '',
          state.cursorUsageDate ?? '',
          state.cursorSource ?? '',
          state.cursorModel ?? '',
          chunkSize
        )
        .all<UsageSummaryKey>()
    ).results ?? []
  if (rows.length > 0) {
    await runStatementBatches(
      db,
      rows.map((row) => db.prepare(deleteOrphanSummaryRowSql).bind(row.userId, row.usageDate, row.source, row.model))
    )
  }
  return { rows: rows.length, repaired: rows.length, cursor: toCursor(rows.at(-1)) }
}

async function healTotals(db: D1Database, state: SelfHealState, chunkSize: number): Promise<ChunkOutcome> {
  const withCursor = state.cursorUserId !== null
  const bindings = withCursor
    ? [state.cursorUserId, chunkSize, state.cursorUserId, chunkSize, chunkSize]
    : [chunkSize, chunkSize, chunkSize]
  const userIds = (
    (
      await db
        .prepare(selfHealCandidateUsersSql(withCursor))
        .bind(...(bindings as never[]))
        .all<{ userId: string }>()
    ).results ?? []
  ).map((row) => row.userId)
  const drifted = await listDriftedTotalUsers(db, userIds)
  if (drifted.length > 0) {
    const stamp = nextAggregateTimestamp().toISOString()
    await runStatementBatches(
      db,
      drifted.map((userId) => prepareUserTotalFromSummaryRefresh(db, userId, stamp))
    )
  }
  const lastUser = userIds.at(-1)
  const cursor: SelfHealCursor | null = lastUser
    ? { userId: lastUser, usageDate: null, source: null, model: null }
    : null
  return { rows: userIds.length, repaired: drifted.length, cursor }
}

async function listDriftedTotalUsers(db: D1Database, userIds: string[]) {
  const drifted: string[] = []
  // One bind per candidate user; stay clear of the hundred-parameter ceiling.
  const chunkLength = Math.max(1, Math.min(userIds.length, d1MaxBoundParameters - 20))
  for (let index = 0; index < userIds.length; index += chunkLength) {
    const chunk = userIds.slice(index, index + chunkLength)
    const rows = await db
      .prepare(totalRepairCheckSql(chunk.length))
      .bind(...chunk)
      .all<{ userId: string }>()
    drifted.push(...(rows.results ?? []).map((row) => row.userId))
  }
  return drifted
}

function toCursor(key: UsageSummaryKey | undefined): SelfHealCursor | null {
  return key ? { userId: key.userId, usageDate: key.usageDate, source: key.source, model: key.model } : null
}

function resumeSweep(state: SelfHealState, cursor: SelfHealCursor | null): SelfHealState {
  return {
    sweep: state.sweep,
    cursorUserId: cursor?.userId ?? null,
    cursorUsageDate: cursor?.usageDate ?? null,
    cursorSource: cursor?.source ?? null,
    cursorModel: cursor?.model ?? null,
    lastRoundCompletedAt: state.lastRoundCompletedAt
  }
}

async function readSelfHealState(db: D1Database): Promise<SelfHealState> {
  const row = await readUsageSummaryStateRow(db, selfHealStateId)
  const phase = row?.phase
  const lastRoundCompletedAt = row?.completedAt ?? null
  if (phase === 'summaries' || phase === 'orphans' || phase === 'totals') {
    return {
      sweep: phase,
      cursorUserId: row?.cursorUserId ?? null,
      cursorUsageDate: row?.cursorUsageDate ?? null,
      cursorSource: row?.cursorSource ?? null,
      cursorModel: row?.cursorModel ?? null,
      lastRoundCompletedAt
    }
  }
  return {
    sweep: 'summaries',
    cursorUserId: null,
    cursorUsageDate: null,
    cursorSource: null,
    cursorModel: null,
    lastRoundCompletedAt
  }
}

async function writeSelfHealState(db: D1Database, state: SelfHealState) {
  await writeUsageSummaryStateRow(db, selfHealStateId, {
    phase: state.sweep,
    cursorUserId: state.cursorUserId,
    cursorUsageDate: state.cursorUsageDate,
    cursorSource: state.cursorSource,
    cursorModel: state.cursorModel,
    // A mid-round write preserves the previous round's completion stamp; only a completed round
    // moves it.
    completedAt: state.lastRoundCompletedAt
  })
}

async function writeRoundCompleted(db: D1Database, _previous: string | null) {
  await writeUsageSummaryStateRow(db, selfHealStateId, {
    phase: 'summaries',
    cursorUserId: null,
    cursorUsageDate: null,
    cursorSource: null,
    cursorModel: null,
    completedAt: new Date().toISOString()
  })
}
