import type { Health, HostStatus, Status } from '@substrate/protocol'
import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { vmRoutes, type VmRoutesOptions } from './vms.ts'
import type { previewRoutes } from './previews.ts'
import type { macRoutes } from './macs/routes.ts'

type Options = {
  version: string
  region: string
  webDir: string
  readHost: () => Promise<HostStatus>
  // The web app reads this at startup, so builds don't need it. Null: no sign-in.
  clerkPublishableKey: string | null
  // VM routes, or why there aren't any (no sandbox host, or no sign-in).
  vms: VmRoutesOptions | { unavailable: string }
  previews?: ReturnType<typeof previewRoutes>
  // macOS workspaces (M10), when they're set up.
  macs?: ReturnType<typeof macRoutes>
}

export function createApp({ version, region, webDir, readHost, clerkPublishableKey, vms, previews, macs }: Options) {
  const startedAt = new Date().toISOString()
  const app = new Hono()

  // CloudFront's dedicated preview distribution tags its origin requests.
  // It has a separate browser origin and never serves control API routes.
  app.use('*', async (c, next) => {
    if (c.req.header('x-substrate-preview') === '1') return previews ? previews.fetch(c.req.raw, c.env) : c.text('Previews are not configured', 404)
    await next()
  })

  app.get('/api/health', (c) => c.json({ ok: true, version } satisfies Health))

  app.get('/api/status', async (c) => {
    const status: Status = {
      control: { version, region, startedAt },
      host: await readHost(),
    }
    return c.json(status)
  })

  app.get('/api/config', (c) => c.json({ clerkPublishableKey }))

  if ('unavailable' in vms) {
    const { unavailable } = vms
    app.on(['GET', 'POST', 'DELETE'], ['/api/vms', '/api/vms/*'], (c) => c.json({ error: unavailable }, 503))
  } else {
    app.route('/api', vmRoutes(vms))
  }

  if (macs) app.route('/api', macs)
  else app.on(['GET', 'POST', 'DELETE'], ['/api/macs', '/api/macs/*'], (c) => c.json({ error: "macOS workspaces aren't set up on this server" }, 503))

  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404))

  // The web app, with every other path falling back to index.html.
  app.use('/*', serveStatic({ root: webDir }))
  app.get('/*', serveStatic({ root: webDir, path: 'index.html' }))

  app.onError((err, c) => {
    // One line: the bundled binary would print screenfuls of minified source.
    console.error(`${c.req.method} ${c.req.path}: ${err.message}`)
    return c.json({ error: 'internal error' }, 500)
  })

  return app
}
