import type { NotFoundHandler } from 'hono'

const handler: NotFoundHandler = (c) => {
  if (c.req.path.startsWith('/api/')) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404)
  }

  c.status(404)
  return c.render('404 Not Found')
}

export default handler
