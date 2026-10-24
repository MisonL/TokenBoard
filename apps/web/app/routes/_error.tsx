import type { ErrorHandler } from 'hono'
import { SkipLinkTarget } from '../components/skip-link-target'
import { ApiError } from '../lib/errors'

const handler: ErrorHandler = (e, c) => {
  if ('getResponse' in e) {
    return e.getResponse()
  }
  if (e instanceof ApiError && e.code === 'UNAUTHORIZED') {
    if (expectsJson(c)) {
      return c.json({ error: { code: e.code, message: e.message } }, e.status, e.headers)
    }
    return c.redirect('/auth/sign-in')
  }
  if (e instanceof ApiError) {
    if (expectsJson(c)) {
      return c.json({ error: { code: e.code, message: e.message } }, e.status, e.headers)
    }
    for (const [name, value] of Object.entries(e.headers ?? {})) c.header(name, value)
    c.status(e.status)
    return c.render(
      <>
        <SkipLinkTarget />
        {e.message}
      </>
    )
  }
  // An unhandled error on an `/api/*` path must still answer in the `{ error: { code, message } }`
  // shape the rest of the API uses — a route that forgot its own try/catch (for example the
  // auth passthrough) would otherwise return an HTML body to a JSON client. `no-store` matches
  // every other error branch.
  if (expectsJson(c)) {
    console.error(e.message)
    return c.json({ error: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' } }, 500, {
      'Cache-Control': 'no-store'
    })
  }
  console.error(e.message)
  c.status(500)
  return c.render(
    <>
      <SkipLinkTarget />
      Internal Server Error
    </>
  )
}

export default handler

function expectsJson(c: Parameters<ErrorHandler>[1]) {
  return c.req.path.startsWith('/api/') || (c.req.header('accept') || '').includes('application/json')
}
