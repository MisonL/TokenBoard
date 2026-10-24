import { describe, expect, test } from 'vitest'
import { assertValidTimeZone } from './timezone'

describe('assertValidTimeZone', () => {
  test('accepts and canonicalizes IANA timezones', () => {
    expect(assertValidTimeZone('Asia/Shanghai')).toBe('Asia/Shanghai')
    expect(assertValidTimeZone('UTC')).toBe('UTC')
  })

  test.each(['', 'UTC&whoami'])('rejects malformed timezone input', (timezone) => {
    expect(() => assertValidTimeZone(timezone)).toThrow('Invalid timezone')
  })

  test('a well-formed but unknown zone gets the ICU diagnostic hint', () => {
    expect(() => assertValidTimeZone('Not/A-Timezone')).toThrow(/Invalid timezone: Not\/A-Timezone\. .*ICU/)
  })
})
