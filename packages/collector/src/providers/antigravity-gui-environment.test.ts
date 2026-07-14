import { describe, expect, test } from 'vitest'
import { isUnavailableLanguageServerError } from './antigravity-gui-environment'

describe('isUnavailableLanguageServerError', () => {
  test('recognizes metadata response size-limit errors', () => {
    expect(isUnavailableLanguageServerError(
      new Error('Antigravity metadata response exceeded the 8388608-byte limit for antigravity')
    )).toBe(true)
  })
})
