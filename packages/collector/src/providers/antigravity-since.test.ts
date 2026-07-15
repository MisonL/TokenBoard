import { describe, expect, test } from 'vitest'
import {
  isReusableAntigravityHistoryScope,
  resolveAntigravityCollectionRange
} from './antigravity-since'

describe('resolveAntigravityCollectionRange', () => {
  test('rejects nonexistent compact calendar dates instead of normalizing them', () => {
    expect(() => resolveAntigravityCollectionRange({ since: '20260230', timezone: 'UTC' }))
      .toThrow('Invalid Antigravity since date: 20260230')
  })

  test('distinguishes bounded empty configuration from explicit full history', () => {
    const bounded = resolveAntigravityCollectionRange({ since: '', timezone: 'UTC' })
    const full = resolveAntigravityCollectionRange({ since: 'all', timezone: 'UTC' })

    expect(bounded.fullHistory).toBe(false)
    expect(full.fullHistory).toBe(true)
    expect(bounded.sinceDate).toBeUndefined()
    expect(full.sinceDate).toBeUndefined()
  })

  test('scopes bounded cursor state by timezone', () => {
    const utc = resolveAntigravityCollectionRange({ since: '20260624', timezone: 'UTC' })
    const shanghai = resolveAntigravityCollectionRange({ since: '20260624', timezone: 'Asia/Shanghai' })

    expect(utc.historyScope).not.toBe(shanghai.historyScope)
    expect(isReusableAntigravityHistoryScope(utc.historyScope, shanghai.historyScope)).toBe(false)
  })
})
