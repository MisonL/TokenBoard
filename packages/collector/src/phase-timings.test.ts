import { describe, expect, test } from 'vitest'
import { createPhaseTimings, phaseNames, type PhaseName } from './phase-timings'

describe('createPhaseTimings', () => {
  test('records named phases as integer milliseconds', () => {
    const timings = createPhaseTimings()
    timings.record('ccusageDaily', 1234.6)
    timings.record('ccusageSession', 20.2)

    expect(timings.snapshot()).toEqual({ ccusageDaily: 1235, ccusageSession: 20 })
  })

  test('keeps the last measurement when a phase runs more than once', () => {
    const timings = createPhaseTimings()
    timings.record('upload', 100)
    timings.record('upload', 250)

    expect(timings.snapshot()).toEqual({ upload: 250 })
  })

  test('clamps negative and absurd values into a sane range', () => {
    const timings = createPhaseTimings()
    timings.record('cursorScan', -5)

    expect(timings.snapshot()).toEqual({ cursorScan: 0 })
  })

  test('snapshot returns a copy, so later records cannot mutate an emitted payload', () => {
    const timings = createPhaseTimings()
    timings.record('upload', 100)
    const payload = timings.snapshot()
    timings.record('upload', 999)

    expect(payload).toEqual({ upload: 100 })
    expect(timings.snapshot()).toEqual({ upload: 999 })
  })

  test('empty timings serialize as an empty object', () => {
    expect(createPhaseTimings().snapshot()).toEqual({})
  })

  test('the phase name list is a closed set', () => {
    const names = Object.values<string>(phaseNames).sort()
    expect(names).toEqual(['ccusageDaily', 'ccusageSession', 'cursorAck', 'cursorScan', 'upload'])
  })

  test('the sink is opt-in and typed, so callers can always pass undefined', () => {
    const sink: { timings?: { record(name: PhaseName, durationMs: number): void } } = {}
    expect(() => sink.timings?.record('upload', 5)).not.toThrow()
  })
})
