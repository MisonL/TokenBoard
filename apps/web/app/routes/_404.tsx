import type { NotFoundHandler } from 'hono'

const handler: NotFoundHandler = (c) => {
  // A 404 is not a representation of a resource, so nothing should hold on to it: without
  // a directive a browser may cache it heuristically, and `.csv`/`.json` style paths are on
  // Cloudflare's cache-by-extension list. That would keep answering "not found" for a path
  // that starts existing later. Matches the app's other error surfaces.
  c.header('Cache-Control', 'no-store')

  if (c.req.path.startsWith('/api/')) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404)
  }

  c.status(404)
  return c.render('404 Not Found')
}

export default handler
