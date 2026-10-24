import { describe, expect, test } from 'vitest'
import {
  createSessionContentHasher,
  isCurrentContentHashAlgorithm,
  legacySessionContentHashAlgorithm,
  sessionContentHashAlgorithm
} from './session-content-hash'

describe('session content hashing', () => {
  test('hashes with the current algorithm and produces a stable digest', () => {
    const first = createSessionContentHasher().update('session bytes').digest('hex')
    const second = createSessionContentHasher().update('session bytes').digest('hex')

    expect(first).toBe(second)
    expect(first).toMatch(/^[a-f0-9]{128}$/)
  })

  test('distinguishes different content', () => {
    const left = createSessionContentHasher().update('first').digest('hex')
    const right = createSessionContentHasher().update('second').digest('hex')

    expect(left).not.toBe(right)
  })

  test('produces a digest the legacy sha256 algorithm cannot collide with by shape', () => {
    const digest = createSessionContentHasher().update('session bytes').digest('hex')

    // Legacy entries store 64 hex characters. Recording the algorithm alongside the
    // digest is what keeps the two apart; this guards the shape that assumption rests on.
    expect(digest).toHaveLength(128)
    expect(digest).not.toHaveLength(64)
  })

  test('treats an entry without a recorded algorithm as legacy', () => {
    expect(isCurrentContentHashAlgorithm(undefined)).toBe(false)
    expect(isCurrentContentHashAlgorithm(legacySessionContentHashAlgorithm)).toBe(false)
  })

  test('accepts an entry that records the current algorithm', () => {
    expect(isCurrentContentHashAlgorithm(sessionContentHashAlgorithm)).toBe(true)
  })

  test('treats an unknown algorithm name as not current', () => {
    // An entry written by a newer collector with an algorithm this build does not
    // know must not be compared against a digest this build produces.
    expect(isCurrentContentHashAlgorithm('sha3-256')).toBe(false)
    expect(isCurrentContentHashAlgorithm('')).toBe(false)
  })
})
