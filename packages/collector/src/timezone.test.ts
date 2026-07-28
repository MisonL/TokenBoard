import { describe, expect, test } from 'vitest'
import { assertValidTimeZone } from './timezone'

describe('assertValidTimeZone', () => {
  test('accepts and canonicalizes IANA timezones', () => {
    expect(assertValidTimeZone('Asia/Shanghai')).toBe('Asia/Shanghai')
    expect(assertValidTimeZone('UTC')).toBe('UTC')
  })

  test.each(['', 'UTC&whoami', 'Not/A-Timezone'])('rejects invalid timezone input', (timezone) => {
    expect(() => assertValidTimeZone(timezone)).toThrow('Invalid timezone')
  })
})
