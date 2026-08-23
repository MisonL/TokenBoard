import { describe, expect, test, vi } from 'vitest'
import { runCollectorCli } from './cli'

describe('collector CLI timezone validation', () => {
  test.each([
    {
      args: ['preview', '--source', 'codex'],
      env: { TOKENBOARD_TIMEZONE: 'UTC&whoami' }
    },
    {
      args: ['preview', '--source', 'codex', '--timezone', 'UTC&whoami'],
      env: {}
    }
  ])('rejects an unsafe $args timezone before collection', async ({ args, env }) => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await expect(runCollectorCli(args, env)).resolves.toBe(1)
      expect(stderr).toHaveBeenCalledWith('Invalid timezone')
    } finally {
      stderr.mockRestore()
    }
  })
})
