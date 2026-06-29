import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { requireDeviceStepUp } from './step-up'

describe('requireDeviceStepUp', () => {
  test('allows sensitive device actions by default', () => {
    expect(() => requireDeviceStepUp({}, 'device.reconnect')).not.toThrow()
    expect(() => requireDeviceStepUp({}, 'token.rotate')).not.toThrow()
    expect(() => requireDeviceStepUp({ TOKENBOARD_STEP_UP_REQUIRED: 'false' }, 'token.revoke')).not.toThrow()
  })

  test('fails closed when the reserved step-up switch is enabled', () => {
    expect(() => requireDeviceStepUp({ TOKENBOARD_STEP_UP_REQUIRED: 'true' }, 'installation.revoke')).toThrow(
      'Step-up verification is required for installation.revoke'
    )
    expect(() => requireDeviceStepUp({ TOKENBOARD_STEP_UP_REQUIRED: '1' }, 'device.revoke')).toThrow()
  })

  test('guards every current high-risk device route action', () => {
    const devicesRoute = readFileSync(new URL('../../routes/settings/devices.tsx', import.meta.url), 'utf8')
    const installRoute = readFileSync(new URL('../../routes/settings/install.tsx', import.meta.url), 'utf8')

    expect(devicesRoute).toContain("requireDeviceStepUp(c.env, 'device.revoke')")
    expect(devicesRoute).toContain("requireDeviceStepUp(c.env, 'installation.revoke')")
    expect(devicesRoute).toContain("requireDeviceStepUp(c.env, 'token.rotate')")
    expect(devicesRoute).toContain("requireDeviceStepUp(c.env, 'token.revoke')")
    expect(installRoute).toContain("requireDeviceStepUp(c.env, 'device.reconnect')")
  })
})
