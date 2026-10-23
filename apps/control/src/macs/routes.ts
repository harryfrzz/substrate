import { CreateMacWorkspace, Session } from '@substrate/protocol'
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { upgradeWebSocket } from 'hono/bun'
import type { Authenticate, User } from '../auth.ts'
import type { Tickets } from '../tickets.ts'
import type { MacAgents } from './agents.ts'
import { MacPoolError, type MacPool } from './pool.ts'
import type { MacHost, MacStore } from './store.ts'

export type MacRoutesOptions = {
  authenticate: Authenticate
  pool: MacPool
  agents: MacAgents
  store: MacStore
  tickets: Tickets
}

type Env = { Variables: { user: User; host: MacHost } }

// macOS workspaces for signed-in users, and the endpoints Macs' agents dial.
export function macRoutes({ authenticate, pool, agents, store, tickets }: MacRoutesOptions) {
  const app = new Hono<Env>()

  // ── Macs' agents: a bearer token that only a Mac's own first-boot script had ──
  const agent: MiddlewareHandler<Env> = async (c, next) => {
    const token = c.req.header('authorization')?.replace(/^Bearer /, '') ?? ''
    const host = token ? store.hostForToken(token) : null
    if (!host) return c.json({ error: 'unknown Mac' }, 401)
    c.set('host', host)
    await next()
  }
  app.get('/macs/agent', agent, upgradeWebSocket((c) => agents.connection((c as Context<Env>).var.host.id)))
  app.get('/macs/agent/streams/:stream', agent, async (c, next) => {
    if (!agents.streamConnection(c.var.host.id, c.req.param('stream'))) return c.json({ error: 'no such terminal' }, 404)
    await next()
  }, upgradeWebSocket((c) => agents.streamConnection((c as Context<Env>).var.host.id, c.req.param('stream')!)!))

  // ── Terminals: a one-time ticket, since browsers can't add headers to WebSockets ──
  app.get('/macs/:id/sessions/:session/terminal', async (c, next) => {
    const id = c.req.param('id')
    const user = tickets.redeem(c.req.query('ticket') ?? '', id, c.req.param('session'))
    const row = store.workspace(id)
    if (!user || !row || row.owner !== user) return c.json({ error: 'missing or expired terminal ticket' }, 401)
    try { pool.hostOf(row) } catch (err) { return c.json({ error: (err as Error).message }, 409) }
    await next()
  }, upgradeWebSocket((c) => {
    const row = store.workspace(c.req.param('id')!)!
    return agents.terminal(row.hostId, row.id, c.req.param('session')!)
  }))

  // ── Everything else: a signed-in user, and only their own workspaces ──
  const signedIn: MiddlewareHandler<Env> = async (c, next) => {
    const user = await authenticate(c.req.raw)
    if (!user) return c.json({ error: 'sign in first' }, 401)
    c.set('user', user)
    await next()
  }
  app.use('/macs', signedIn)
  app.use('/macs/*', signedIn)

  app.get('/macs', (c) => c.json(pool.list(c.var.user.id)))

  app.post('/macs', async (c) => {
    const input = CreateMacWorkspace.safeParse(await c.req.json().catch(() => null))
    if (!input.success) return c.json({ error: input.error.issues[0]?.message ?? 'invalid workspace' }, 400)
    return c.json(await pool.create(c.var.user.id, input.data), 201)
  })

  app.delete('/macs/:id', async (c) => {
    await pool.remove(c.var.user.id, c.req.param('id'))
    return c.body(null, 204)
  })

  app.get('/macs/:id/sessions', async (c) => {
    const row = pool.own(c.var.user.id, c.req.param('id'))
    const result = await agents.call(pool.hostOf(row), { method: 'sessions', params: { vmId: row.id } }, 30_000)
    return c.json(Session.array().parse(result))
  })

  app.post('/macs/:id/sessions', async (c) => {
    const row = pool.own(c.var.user.id, c.req.param('id'))
    const result = await agents.call(pool.hostOf(row), { method: 'createSession', params: { vmId: row.id } }, 60_000)
    return c.json(Session.parse(result), 201)
  })

  app.post('/macs/:id/sessions/:session/terminal/ticket', (c) => {
    const row = pool.own(c.var.user.id, c.req.param('id'))
    return c.json({ ticket: tickets.issue({ userId: c.var.user.id, vmId: row.id, sessionId: c.req.param('session') }) })
  })

  app.onError((err, c) => {
    if (err instanceof MacPoolError) return c.json({ error: err.message, ...err.body }, err.status)
    console.error(`${c.req.method} ${c.req.path}: ${err.message}`)
    return c.json({ error: err.message }, 502)
  })

  return app
}
