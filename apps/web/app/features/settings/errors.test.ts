import { describe, expect, test } from 'vitest'
import { ZodError } from 'zod'
import { FormError } from '../../lib/form-error'
import { settingsFormErrorCodeForRedirect, settingsFormErrorMessage } from './errors'

describe('settingsFormErrorMessage', () => {
  test('returns the message for a known code', () => {
    expect(settingsFormErrorMessage('slug-taken')).toContain('已被占用')
  })

  test('returns undefined for a missing or unknown code', () => {
    expect(settingsFormErrorMessage(undefined)).toBeUndefined()
    expect(settingsFormErrorMessage('')).toBeUndefined()
    expect(settingsFormErrorMessage('nope')).toBeUndefined()
  })

  // `?error=` is user-controlled; a bracket lookup would resolve inherited members and render
  // an empty banner instead of nothing.
  test('ignores prototype-chain keys', () => {
    for (const key of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      expect(settingsFormErrorMessage(key)).toBeUndefined()
    }
  })
})

describe('settingsFormErrorCodeForRedirect', () => {
  test('maps a ZodError to invalid-profile', () => {
    expect(settingsFormErrorCodeForRedirect(new ZodError([]))).toBe('invalid-profile')
  })

  test('keeps a known FormError code', () => {
    expect(settingsFormErrorCodeForRedirect(new FormError('slug-taken', 'taken'))).toBe('slug-taken')
    expect(settingsFormErrorCodeForRedirect(new FormError('invalid-card', 'bad card'))).toBe('invalid-card')
  })

  // A FormError that carries a non-400 status is not a validation failure: `profile-not-found`
  // is a 404 and must take the JSON path rather than a redirect banner.
  test('refuses a FormError whose status is not a validation failure', () => {
    expect(settingsFormErrorCodeForRedirect(new FormError('profile-not-found', 'missing', 'NOT_FOUND', 404))).toBeNull()
  })

  test('ignores unknown codes, prototype keys, and non-FormError values', () => {
    expect(settingsFormErrorCodeForRedirect(new FormError('constructor', 'x'))).toBeNull()
    expect(settingsFormErrorCodeForRedirect(new FormError('made-up', 'x'))).toBeNull()
    expect(settingsFormErrorCodeForRedirect(new Error('boom'))).toBeNull()
  })
})
