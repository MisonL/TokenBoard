import { describe, expect, test, vi } from 'vitest'
import { forwardGithubSignIn } from './service'

// `postAuth` re-issues the request before handing it to Better Auth. Anything it fails to
// copy is invisible to the auth handler, and the rate limiter reads the caller's address
// from a header — so a dropped header silently splits the budget between a per-address
// bucket and the shared `no-trusted-ip` one. That shared bucket is the dangerous half:
// exhausting it locks out every user of that path, not just the caller.
vi.mock('./auth', () => ({
  authBasePath: '/api/auth',
  createAuth: () => ({
    handler: async (request: Request) => {
      captured.push(request)
      return new Response(JSON.stringify({ url: 'https://github.com/login/oauth/authorize' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
  })
}))

const captured: Request[] = []

function contextWith(headers: Record<string, string>) {
  const url = 'https://example.test/auth/sign-in'
  return {
    env: {},
    req: {
      url,
      raw: new Request(url, { method: 'POST', headers }),
      header: (name: string) => headers[name.toLowerCase()]
    },
    redirect: (location: string, status: number) =>
      new Response(null, { status, headers: { location, 'cache-control': 'max-age=0' } })
  }
}

describe('forwardGithubSignIn', () => {
  test('forwards the Cloudflare client address to the auth handler', async () => {
    captured.length = 0
    await forwardGithubSignIn(contextWith({ 'cf-connecting-ip': '203.0.113.7' }) as never)
    expect(captured).toHaveLength(1)
    expect(captured[0].headers.get('cf-connecting-ip')).toBe('203.0.113.7')
  })

  test('still carries the cookie and origin the auth handler needs', async () => {
    captured.length = 0
    await forwardGithubSignIn(
      contextWith({ cookie: 'tb=abc', origin: 'https://example.test', 'cf-connecting-ip': '203.0.113.7' }) as never
    )
    expect(captured[0].headers.get('cookie')).toBe('tb=abc')
    expect(captured[0].headers.get('origin')).toBe('https://example.test')
  })

  test('omits the header entirely when the edge did not supply one', async () => {
    captured.length = 0
    await forwardGithubSignIn(contextWith({}) as never)
    expect(captured[0].headers.get('cf-connecting-ip')).toBeNull()
  })

  // The 303 carries the sign-in `Set-Cookie`, so a shared cache replaying it would hand one
  // visitor's session cookie to the next. `c.redirect` builds a fresh response that does not
  // inherit the `no-store` the auth handler set, so `redirectWithCookies` has to set it again.
  test('marks the sign-in redirect no-store so a shared cache cannot replay the cookie', async () => {
    captured.length = 0
    const response = await forwardGithubSignIn(contextWith({ cookie: 'tb=abc' }) as never)

    expect(response.status).toBe(303)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('location')).toBe('https://github.com/login/oauth/authorize')
  })
})
