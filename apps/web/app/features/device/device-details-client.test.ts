import { describe, expect, test } from 'vitest'
import { shouldEnhanceDeviceDetailsClick } from './device-details-client'

describe('device details client enhancement', () => {
  test('enhances ordinary primary clicks', () => {
    expect(shouldEnhanceDeviceDetailsClick(mouseEvent())).toBe(true)
  })

  test.each([
    ['middle click', { button: 1 }],
    ['meta click', { metaKey: true }],
    ['ctrl click', { ctrlKey: true }],
    ['shift click', { shiftKey: true }],
    ['alt click', { altKey: true }],
    ['already handled click', { defaultPrevented: true }]
  ])('leaves %s to native link behavior', (_label, init) => {
    expect(shouldEnhanceDeviceDetailsClick(mouseEvent(init))).toBe(false)
  })
})

function mouseEvent(init: Partial<MouseEvent> = {}) {
  return {
    button: 0,
    defaultPrevented: false,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...init
  } as MouseEvent
}
