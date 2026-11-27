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
// The decision may not be made from the scheduled task's exit code alone. It records
// `success` even when the upload was paused — a paused upload keeps its rows in the
// collector's pending cursors, so the scan still happened and the data is not lost — but a
// run can also exit 0 after skipping a source or after being deferred to a scheduled retry
// that is still in flight. What is checked instead is the per-source state file the
// scheduled sync writes (`scheduled-sync-state.<source>.json`, or the plain `all` file for
// a full run):
//
//   - status `success` — no `running`, no `deferred` (a hand-off, not a completion), and no
//     `failed` (a failed run may still have collected the source, but that cannot be told
//     apart from one that never reached it; a duplicate scan is the accepted cost)
//   - the file's own `source` field matches the file it was read from
//   - the request predates the run's start (`requestedAt <= startedAt`): a signal that
//     arrived while the run was already scanning may describe sessions written after that
//     scan began, and only the run *started after* the request is guaranteed to include it
//   - an explicit `completedAt` no earlier than `startedAt`, no later than now, and no more
//     than a day old (the state file is overwritten every run, so an old completion is not
//     evidence)
//
// Every uncertain answer — no file, an unreadable file, a malformed timestamp, a clock
// behind the request — means *not covered*, so the hook run proceeds. That direction costs
// a duplicate scan at worst; the opposite direction loses the hook's sync.
export const maximumCoverCompletionAgeMs = 24 * 60 * 60_000

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
    let state
    try {
      state = readScheduledSyncState(scheduledSyncStatePath(stateDir, candidate), runtime)
    } catch {
      // An unreadable candidate (EACCES, EIO) is "not covered" for this file; the other
      // candidate may still answer, and failing the hook over C4's input would turned a
      // bookkeeping problem into a missed sync.
      continue
    }
    if (!state || state.status !== 'success') continue
    if (state.source !== candidate) continue
    if (!coversRequestedSignal(state, requestedMs, current)) continue
    return true
  }
  return false
}

function coversRequestedSignal(state, requestedMs, nowMs) {
  if (typeof state.completedAt !== 'string') return false
  const startedMs = Date.parse(state.startedAt)
  const completedMs = Date.parse(state.completedAt)
  if (!Number.isFinite(startedMs) || !Number.isFinite(completedMs)) return false
  // Only a run that started after the request is guaranteed to have scanned it.
  if (requestedMs > startedMs) return false
  // Completion before start is a corrupt file, not evidence of a scan.
  if (completedMs < startedMs) return false
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
