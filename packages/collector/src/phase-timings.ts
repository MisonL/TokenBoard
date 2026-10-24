// Per-run phase timings for the collector.
//
// A hook sync runs daily and session ccusage scans back to back, plus a local
// cursor scan and an upload, and the run record kept only one total. That made
// the expensive phase — and any regression in it — invisible: a run that spent
// two minutes in ccusage looked exactly like one that spent two minutes
// parsing JSONL.
//
// The sink is deliberately narrow: a closed set of phase names and integer
// milliseconds. The run record it feeds is local state, but it is also read by
// `status.mjs`, whose output is redacted on purpose, so the only thing that may
// travel is a number and a name from this file.

/** The phases one collection measures. Names are a closed set: a caller cannot
 * invent one, which is what keeps paths, model ids or command lines from
 * reaching the run record through a timing key. */
export const phaseNames = {
  cursorScan: 'cursorScan',
  ccusageDaily: 'ccusageDaily',
  ccusageSession: 'ccusageSession',
  upload: 'upload',
  cursorAck: 'cursorAck'
} as const

export type PhaseName = (typeof phaseNames)[keyof typeof phaseNames]

const phaseNameSet = new Set<string>(Object.values(phaseNames))

/** PhaseTimings collects durations for one run. */
export type PhaseTimings = {
  /** record stores one phase's duration. A phase that runs twice keeps the
   * last measurement; the snapshot is what a reader sees, not a sum. */
  record(name: PhaseName, durationMs: number): void
  snapshot(): Record<string, number>
}

export function createPhaseTimings(): PhaseTimings {
  const durations = new Map<string, number>()
  return {
    record(name: PhaseName, durationMs: number) {
      if (!phaseNameSet.has(name)) return
      durations.set(name, normalizeDuration(durationMs))
    },
    snapshot() {
      return Object.fromEntries(durations)
    }
  }
}

// A duration is wall-clock arithmetic on a machine that can be loaded past the
// point of useful measurement. Rounding keeps float noise out of the record;
// clamping keeps a clock jump from writing a negative or absurd number that a
// later reader would have to special-case.
const maxPhaseDurationMs = 24 * 60 * 60 * 1000

function normalizeDuration(durationMs: number) {
  if (!Number.isFinite(durationMs)) return 0
  return Math.min(Math.max(Math.round(durationMs), 0), maxPhaseDurationMs)
}

/** timePhase runs one phase and records how long it took, keeping the
 * measurement next to the work instead of at every call site. */
export async function timePhase<T>(
  timings: PhaseTimings | undefined,
  name: PhaseName,
  work: () => Promise<T>
): Promise<T> {
  if (!timings) return work()
  const startedAt = performance.now()
  try {
    return await work()
  } finally {
    timings.record(name, performance.now() - startedAt)
  }
}
