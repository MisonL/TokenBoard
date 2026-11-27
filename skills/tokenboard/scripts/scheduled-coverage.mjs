import { readScheduledSyncState, scheduledSyncStatePath } from './scheduled-sync-state.mjs'

// Batch C4 support: does a scheduled sync that finished after a hook signal was requested
// already cover that source?
//
// The coordinator suppresses hook triggers inside the scheduled-run window because the
// scheduled run collects the same usage moments later. The queued signal is then covered by
// that run — and once it is, the signal must not shape a later trailing retry either: the
// signal asks for a scan that already happened, and honouring it after the window (or after
// a lock/cooldown delay pushed the retry past it) starts the duplicate scan the window
// existed to avoid.
//
// The decision may not be made from the scheduled task's exit code. It records `success`
// even when the upload was paused, and a run can exit 0 after skipping sources or being
// deferred to a scheduled retry that is still in flight. What is checked instead is the
// per-source state file the scheduled sync writes (`scheduled-sync-state.<source>.json`,
// or the plain `all` file for a full run):
//
//   - the latest terminal state (not `running`; `deferred` is a hand-off, not a completion)
//   - completed no earlier than the request
//   - covers the source: the state file written for `all` (or for this exact source) — and
//     it must not be `failed`. A failed scheduled run may still have collected the source
//     before failing, but that cannot be told apart from one that never reached it, so the
//     hook run proceeds and re-collects: a duplicate is the accepted cost, a silent skip
//     of the only remaining attempt is not.
//
// Every uncertain answer ("no state file", "unreadable", "no timestamp", clock behind the
// request) means *not covered*, so the hook run proceeds. That direction costs a duplicate
// scan at worst; the opposite direction loses the hook's sync.

// A completion claim read long after the fact is not evidence. The scheduled state files
// are overwritten every run, so a stale file means no scheduled run has finished recently
// and no window decision should treat the hook signal as answered by it.
export const maximumCoverCompletionAgeMs = 24 * 60 * 60_000

const coveredStatuses = new Set(['success'])

export function sourceCoveredByScheduledRun({ stateDir, source, requestedAt, now = Date.now, readFile }) {
  if (typeof stateDir !== 'string' || !stateDir) return false
  if (typeof source !== 'string' || !source) return false
  const requestedMs = Date.parse(requestedAt)
  // An unknown request age can never be shown to be covered.
  if (!Number.isFinite(requestedMs)) return false
  const current = typeof now === 'function' ? now() : now
  if (!Number.isFinite(current)) return false
  const runtime = typeof readFile === 'function' ? { readFile } : undefined
  for (const candidate of scheduledStateSources(source)) {
    const state = readScheduledSyncState(scheduledSyncStatePath(stateDir, candidate), runtime)
    if (!state || state.status === 'invalid' || state.status === 'running') continue
    if (!coveredStatuses.has(state.status)) continue
    if (!(candidate === 'all' || candidate === source)) continue
    if (completedRecently(state, requestedMs, current)) return true
  }
  return false
}

function completedRecently(state, requestedMs, nowMs) {
  const completedMs = Date.parse(state.completedAt ?? state.updatedAt)
  if (!Number.isFinite(completedMs)) return false
  if (completedMs < requestedMs) return false
  // A completion after `now` is a clock inconsistency, not proof of coverage.
  if (completedMs > nowMs) return false
  if (nowMs - completedMs > maximumCoverCompletionAgeMs) return false
  return true
}

// `all` first: a full scheduled run covers every source, and it is the default (`config.source`
// is `all` unless changed), so the common case stops after one read.
function scheduledStateSources(source) {
  const candidates = ['all']
  if (source !== 'all') candidates.push(source)
  return candidates
}
