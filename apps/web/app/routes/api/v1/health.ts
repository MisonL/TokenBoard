import { createRoute } from 'honox/factory'

export const GET = createRoute((c) => {
  // A health probe that an intermediary can cache reports a stale verdict: the endpoint
  // would keep answering "ok" after the deployment behind it stopped being healthy.
  c.header('Cache-Control', 'no-store')
  return c.json({ ok: true, name: 'TokenBoard' })
})
