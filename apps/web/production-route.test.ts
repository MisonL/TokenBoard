import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
// @ts-expect-error The executable route checker is intentionally JavaScript.
import * as routeChecker from './scripts/check-production-route.mjs'

const { findAccessibleZone, readProductionRoute, stripJsonc, verifyProductionRoute, wranglerAuthPaths } = routeChecker

describe('production route preflight', () => {
  test('preserves comma-like text inside JSONC strings while removing structural trailing commas', () => {
    const parsed = JSON.parse(stripJsonc('{"note":"keep, } and , ]","items":[1,],}'))

    expect(parsed).toEqual({ note: 'keep, } and , ]', items: [1] })
  })

  test('reads the enabled custom domain from JSONC', () => {
    const fixture = createProductionRouteFixture()
    try {
      expect(readProductionRoute(fixture.path)).toBe('tokenboard.chaosyn.com')
    } finally {
      fixture.cleanup()
    }
  })

  test.each(['tokenboard..chaosyn.com', '-tokenboard.chaosyn.com', 'tokenboard-.chaosyn.com', 'tokenboard.chaosyn..'])(
    'rejects invalid custom domain hostnames: %s',
    (pattern) => {
      const fixture = createProductionRouteFixture(pattern)
      try {
        expect(() => readProductionRoute(fixture.path)).toThrow('Production custom domain route is invalid')
      } finally {
        fixture.cleanup()
      }
    }
  )

  test('accepts one optional trailing dot in a custom domain hostname', () => {
    const fixture = createProductionRouteFixture('tokenboard.chaosyn.com.')
    try {
      expect(readProductionRoute(fixture.path)).toBe('tokenboard.chaosyn.com')
    } finally {
      fixture.cleanup()
    }
  })

  test('rejects unterminated JSONC block comments', () => {
    expect(() => stripJsonc('/* missing terminator')).toThrow('Unterminated JSONC block comment')
  })

  test('matches the accessible parent zone without exposing credentials', async () => {
    const requested: string[] = []
    const zone = await findAccessibleZone(
      'tokenboard.chaosyn.com',
      'test-token',
      async (url: RequestInfo | URL, init?: RequestInit) => {
        requested.push(`${url} ${new Headers(init?.headers).get('authorization') ?? ''}`)
        return new Response(
          JSON.stringify({
            success: true,
            errors: [],
            result: [{ id: 'zone-1', name: 'chaosyn.com', status: 'active' }]
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }
        )
      }
    )

    expect(zone).toEqual({ id: 'zone-1', name: 'chaosyn.com', status: 'active' })
    expect(requested[0]).toContain('name=tokenboard.chaosyn.com')
    expect(requested[0]).toContain('Bearer test-token')
  })

  test('fails closed when the current credentials cannot access any parent zone', async () => {
    const fixture = createProductionRouteFixture()
    try {
      await expect(
        verifyProductionRoute({
          configPath: fixture.path,
          token: 'test-token',
          fetcher: async () =>
            new Response(JSON.stringify({ success: true, errors: [], result: [] }), {
              status: 200,
              headers: { 'content-type': 'application/json' }
            })
        })
      ).rejects.toThrow('is not accessible')
    } finally {
      fixture.cleanup()
    }
  })

  test('rejects Cloudflare authentication failures', async () => {
    await expect(
      findAccessibleZone('tokenboard.chaosyn.com', 'test-token', async () => new Response('{}', { status: 403 }))
    ).rejects.toThrow('credentials were rejected')
  })
})

// The preflight reads the oauth token from wherever wrangler would have written it. Getting
// this wrong fails closed — the deploy refuses to start even though `wrangler login` succeeded —
// so the search has to mirror wrangler's own resolution.
describe('wrangler auth file resolution', () => {
  const noneDirectory = () => false

  test('honours XDG_CONFIG_HOME, which wrangler reads but this script used to skip', () => {
    const paths = wranglerAuthPaths(
      { XDG_CONFIG_HOME: '/custom/xdg' },
      { home: '/home/me', isDirectory: noneDirectory }
    )

    expect(paths).toContain('/custom/xdg/.wrangler/config/default.toml')
  })

  test('falls back to the macOS config directory when XDG_CONFIG_HOME is unset', () => {
    const paths = wranglerAuthPaths({}, { home: '/Users/me', platform: 'darwin', isDirectory: noneDirectory })

    expect(paths).toContain('/Users/me/Library/Preferences/.wrangler/config/default.toml')
  })

  test('falls back to ~/.config on Linux', () => {
    const paths = wranglerAuthPaths({}, { home: '/home/me', platform: 'linux', isDirectory: noneDirectory })

    expect(paths).toContain('/home/me/.config/.wrangler/config/default.toml')
  })

  // wrangler prefers the legacy `~/.wrangler` directory whenever it exists, so the search has to
  // cover it before the XDG-derived paths or a login from an older install would be missed.
  test('searches the legacy ~/.wrangler directory when it exists', () => {
    const paths = wranglerAuthPaths(
      { XDG_CONFIG_HOME: '/custom/xdg' },
      { home: '/home/me', platform: 'linux', isDirectory: (path: string) => path === '/home/me/.wrangler' }
    )

    expect(paths.indexOf('/home/me/.wrangler/config/default.toml')).toBeLessThan(
      paths.indexOf('/custom/xdg/.wrangler/config/default.toml')
    )
  })

  test('every candidate is an absolute path ending in the auth file name', () => {
    const paths = wranglerAuthPaths(
      { XDG_CONFIG_HOME: '/custom/xdg' },
      { home: '/home/me', isDirectory: noneDirectory }
    )

    for (const path of paths) {
      expect(path.startsWith('/')).toBe(true)
      expect(path.endsWith('/config/default.toml')).toBe(true)
    }
  })

  test('returns no duplicates', () => {
    const paths = wranglerAuthPaths(
      { XDG_CONFIG_HOME: '/home/me/.config' },
      { home: '/home/me', platform: 'linux', isDirectory: noneDirectory }
    )

    expect(new Set(paths).size).toBe(paths.length)
  })
})

function createProductionRouteFixture(pattern = 'tokenboard.chaosyn.com') {
  const directory = mkdtempSync(join(tmpdir(), 'tokenboard-production-route-'))
  const path = join(directory, 'wrangler.production.jsonc')
  writeFileSync(
    path,
    `{
  // The test only needs the route fields consumed by the preflight checker.
  "routes": [{ "pattern": "${pattern}", "custom_domain": true }]
}
`
  )
  return {
    path,
    cleanup: () => rmSync(directory, { recursive: true, force: true })
  }
}
