import { describe, expect, test } from 'vitest'
import {
  assertIsoDate,
  isValidIsoDate,
  isValidUploadIsoDate,
  maxUploadIsoDate,
  minUploadIsoDate,
  uploadIsoDateIssue
} from './dates'

describe('ISO calendar dates', () => {
  test.each(['2024-02-29', '0000-01-01', '9999-12-31'])('accepts valid date %s', (value) => {
    expect(isValidIsoDate(value)).toBe(true)
    expect(() => assertIsoDate(value)).not.toThrow()
  })

  test.each(['2023-02-29', '2026-02-30', '2026-04-31', '2026-1-01', 'not-a-date'])(
    'rejects invalid date %s',
    (value) => {
      expect(isValidIsoDate(value)).toBe(false)
      expect(() => assertIsoDate(value)).toThrow(`Invalid ISO date: ${value}`)
    }
  )
})

describe('upload usage-date ceiling', () => {
  const reference = new Date('2026-10-07T11:22:33.000Z')

  test('allows the reference day and one day ahead, rejects beyond', () => {
    expect(maxUploadIsoDate(reference)).toBe('2026-10-08')
    expect(isValidUploadIsoDate('2026-10-07', reference)).toBe(true)
    expect(isValidUploadIsoDate('2026-10-08', reference)).toBe(true)
    expect(isValidUploadIsoDate('2026-10-09', reference)).toBe(false)
  })

  test('allows plausible history but rejects dates before any tool existed', () => {
    expect(isValidUploadIsoDate('2024-06-01', reference)).toBe(true)
    expect(isValidUploadIsoDate(minUploadIsoDate, reference)).toBe(true)
    expect(isValidUploadIsoDate('2022-12-31', reference)).toBe(false)
    expect(isValidUploadIsoDate('0000-01-01', reference)).toBe(false)
  })

  test('still rejects malformed dates', () => {
    expect(isValidUploadIsoDate('2026-10-99', reference)).toBe(false)
    expect(isValidUploadIsoDate('not-a-date', reference)).toBe(false)
  })

  // The ingest API maps each issue to a distinct message so a collector can tell "not yet"
  // from "too old"; the classification must agree with the boolean helper at every boundary.
  test('classifies the exact reason a date is refused', () => {
    expect(uploadIsoDateIssue('2026-10-07', reference)).toBeNull()
    expect(uploadIsoDateIssue('2026-10-08', reference)).toBeNull()
    expect(uploadIsoDateIssue('2026-10-09', reference)).toBe('too-far-future')
    expect(uploadIsoDateIssue(minUploadIsoDate, reference)).toBeNull()
    expect(uploadIsoDateIssue('2022-12-31', reference)).toBe('before-history-window')
    expect(uploadIsoDateIssue('not-a-date', reference)).toBe('invalid')
  })
})
