import type { AgentRequest } from '@substrate/protocol'
import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { websocket } from 'hono/bun'
import type { WSContext } from 'hono/ws'
import { Agent } from '../../../macd/src/agent.ts'
import { MacSessions } from '../../../macd/src/sessions.ts'
import { Tickets } from '../tickets.ts'
import { MacAgents } from './agents.ts'
import type { MacCloud } from './cloud.ts'
import { MacPool, MacPoolError } from './pool.ts'
import { macRoutes } from './routes.ts'
import { MacStore } from './store.ts'
import { macUserData } from './user-data.ts'

const HOUR = 3_600_000

function fakeCloud() {
  const calls: string[] = []
  let next = 0
  const cloud: MacCloud & { calls: string[]; failLaunch: boolean } = {
    calls,
    failLaunch: false,
    async allocateHost(azs) {
      calls.push(`allocate ${azs[0]}`)
      return { hostId: `h-${++next}`, az: azs[0]! }
    },
    async launch({ hostId }) {
      calls.push(`launch ${hostId}`)
      if (cloud.failLaunch) throw new Error('no capacity')
      return `i-${hostId}`
    },
    async terminate(id) {
      calls.push(`terminate ${id}`)
    },
    async release(id) {
      calls.push(`release ${id}`)
      return true
    },
  }
  return cloud
}

function setup({ maxHosts = 2, maxPerUser = 1 } = {}) {
  let now = Date.parse('2026-10-24T00:00:00Z')
  const store = new MacStore(':memory:')
  const cloud = fakeCloud()
  const tokens: string[] = []
  const agents = new MacAgents((hostId, vms) => pool.hello(hostId, vms))
  const pool = new MacPool({
    store, cloud, agents,
    availabilityZones: ['ap-southeast-1a', 'ap-southeast-1b'],
    maxHosts, maxPerUser, hourlyUsd: 0.779,
    userData: (token) => (tokens.push(token), 'user data'),
    now: () => now,
  })
  return { store, cloud, agents, pool, tokens, advance: (ms: number) => (now += ms) }
}

// A Mac's agent, connected straight to MacAgents, that answers with `handle`.
function connectMac(agents: MacAgents, hostId: string, vms: string[], handle: (r: AgentRequest) => unknown = () => null) {
  const requests: AgentRequest[] = []
  const events = agents.connection(hostId)
  const ws = {
    send(data: string) {
      const { type: _, id, ...request } = JSON.parse(data)
      requests.push(request)
      queueMicrotask(async () => {
        try {
          events.onMessage?.({ data: JSON.stringify({ type: 'response', id, ok: true, result: await handle(request) }) } as MessageEvent, ws)
        } catch (err) {
          events.onMessage?.({ data: JSON.stringify({ type: 'response', id, ok: false, error: (err as Error).message }) } as MessageEvent, ws)
        }
      })
    },
    close() {},
  } as unknown as WSContext
  events.onOpen?.(new Event('open'), ws)
  events.onMessage?.({ data: JSON.stringify({ type: 'hello', version: 'test', vms }) } as MessageEvent, ws)
  return { requests, close: () => events.onClose?.(new CloseEvent('close') as never, ws) }
}

async function until(check: () => boolean, ms = 3_000) {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await Bun.sleep(10)
  }
}

describe('Mac pool', () => {
  test('a workspace that needs a new Mac asks first, with the cost', async () => {
    const { pool, cloud } = setup()
    const err = await pool.create('ann', { name: 'one' }).catch((e) => e)
    expect(err).toBeInstanceOf(MacPoolError)
    expect(err.status).toBe(409)
    expect(err.body).toEqual({ needsNewMac: true, hourlyUsd: 0.779, minimumHours: 24 })
    expect(cloud.calls).toEqual([])
  })

  test('a confirmed workspace starts a Mac, then its VM once the agent says hello', async () => {
    const { pool, cloud, store, agents, tokens } = setup()
    const workspace = await pool.create('ann', { name: 'one', confirmNewMac: true })
    expect(workspace.state).toBe('waiting')
    expect(cloud.calls).toEqual(['allocate ap-southeast-1a', 'launch h-1'])
    const [host] = store.hosts()
    expect(host).toMatchObject({ state: 'booting', ec2HostId: 'h-1', instanceId: 'i-h-1', az: 'ap-southeast-1a' })
    // Only the token's hash is kept, and it's how the agent is recognised.
    expect(store.hostForToken(tokens[0]!)?.id).toBe(host!.id)
    expect(store.hostForToken('not-the-token')).toBeNull()

    const mac = connectMac(agents, host!.id, [])
    await until(() => store.workspace(workspace.id)?.state === 'running')
    expect(mac.requests).toEqual([{ method: 'createVm', params: { vmId: workspace.id } }])
    expect(store.host(host!.id)?.state).toBe('ready')
  })

  test('workspaces share a Mac before another is started, up to the cap', async () => {
    const { pool, cloud } = setup({ maxHosts: 1 })
    await pool.create('ann', { name: 'one', confirmNewMac: true })
    await pool.create('bob', { name: 'two' })
    expect(cloud.calls.filter((c) => c.startsWith('allocate'))).toHaveLength(1)
    const err = await pool.create('cat', { name: 'three', confirmNewMac: true }).catch((e) => e)
    expect(err.status).toBe(409)
    expect(err.message).toContain('every Mac is in use')
  })

  test('each user has a limit, and names are their own', async () => {
    const { pool } = setup({ maxPerUser: 1 })
    await pool.create('ann', { name: 'one', confirmNewMac: true })
    expect((await pool.create('ann', { name: 'two' }).catch((e) => e)).message).toContain('the most each user may have')
    expect(pool.list('bob')).toEqual([])
    expect(() => pool.own('bob', pool.list('ann')[0]!.id)).toThrow('no macOS workspace')
  })

  test('an empty Mac is released only after its 24 hours, and a grace period', async () => {
    const { pool, cloud, store, agents, advance } = setup()
    const workspace = await pool.create('ann', { name: 'one', confirmNewMac: true })
    const hostId = store.hosts()[0]!.id
    const mac = connectMac(agents, hostId, [])
    await until(() => store.workspace(workspace.id)?.state === 'running')

    advance(2 * HOUR)
    await pool.remove('ann', workspace.id)
    expect(mac.requests.at(-1)).toEqual({ method: 'deleteVm', params: { vmId: workspace.id } })
    await pool.reap()
    expect(cloud.calls).not.toContain('release h-1')

    advance(22 * HOUR)
    await pool.reap()
    expect(cloud.calls).toContain('terminate i-h-1')
    expect(cloud.calls).toContain('release h-1')
    expect(store.hosts()).toEqual([])
  })

  test('a Mac that gets a workspace again is not released', async () => {
    const { pool, cloud, store, agents, advance } = setup({ maxPerUser: 2 })
    const first = await pool.create('ann', { name: 'one', confirmNewMac: true })
    connectMac(agents, store.hosts()[0]!.id, [])
    await until(() => store.workspace(first.id)?.state === 'running')
    await pool.remove('ann', first.id)
    advance(30 * HOUR)
    await pool.create('ann', { name: 'two' })
    await pool.reap()
    expect(cloud.calls).not.toContain('release h-1')
  })

  test("hello deletes VMs the control box doesn't know, and fails workspaces whose VM is gone", async () => {
    const { pool, store, agents } = setup({ maxPerUser: 2 })
    const workspace = await pool.create('ann', { name: 'one', confirmNewMac: true })
    const hostId = store.hosts()[0]!.id
    const first = connectMac(agents, hostId, [])
    await until(() => store.workspace(workspace.id)?.state === 'running')
    first.close()

    const again = connectMac(agents, hostId, ['mac-000000000000'])
    await until(() => again.requests.length > 0)
    expect(again.requests).toEqual([{ method: 'deleteVm', params: { vmId: 'mac-000000000000' } }])
    expect(store.workspace(workspace.id)).toMatchObject({ state: 'failed', error: 'its VM is gone from its Mac' })
  })

  test("a Mac that was allocated but didn't launch is kept until its day is paid, then released", async () => {
    const { pool, cloud, store, advance } = setup()
    cloud.failLaunch = true
    const err = await pool.create('ann', { name: 'one', confirmNewMac: true }).catch((e) => e)
    expect(err.status).toBe(502)
    expect(store.hosts()[0]).toMatchObject({ state: 'failed', ec2HostId: 'h-1' })
    expect(pool.list('ann')).toEqual([])
    await pool.reap()
    expect(cloud.calls).not.toContain('release h-1')
    advance(24 * HOUR)
    await pool.reap()
    expect(cloud.calls).toContain('release h-1')
  })

  test('first-boot user data quotes nothing it should not', () => {
    const script = macUserData({ bucket: 'b', bucketRegion: 'ap-south-1', controlUrl: 'https://x.example', token: 'abc', baseImage: 'ghcr.io/cirruslabs/macos-sequoia-base:latest' })
    expect(script).toContain("export SUBSTRATE_MAC_TOKEN='abc'")
    expect(() => macUserData({ bucket: 'b', bucketRegion: 'r', controlUrl: "x'; rm -rf /", token: 't', baseImage: 'i' })).toThrow()
  })
})

// The control box's routes with a real macd agent dialling in over WebSockets,
// and a shell on a PTY standing in for ssh into a VM.
describe('Mac routes, end to end', () => {
  const cleanups: (() => void)[] = []
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  async function serve() {
    const { pool, store, agents, tokens } = setup()
    const tickets = new Tickets()
    const authenticate = async (req: Request) => {
      const user = req.headers.get('authorization')?.replace('Bearer ', '')
      return user ? { id: user } : null
    }
    const app = new Hono().route('/api', macRoutes({ authenticate, pool, agents, store, tickets }))
    const server = Bun.serve({ port: 0, fetch: app.fetch, websocket })
    cleanups.push(() => server.stop(true))
    const base = server.url.href.replace(/\/$/, '')
    const api = (path: string, user = 'ann', init: RequestInit = {}) =>
      fetch(`${base}/api${path}`, { ...init, headers: { ...(user && { authorization: `Bearer ${user}` }), 'content-type': 'application/json', ...init.headers } })
    return { base, api, store, tokens }
  }

  function startMac(base: string, token: string) {
    const vms = new Set<string>()
    const sessions = new MacSessions(async () => ['/bin/sh'])
    const agent = new Agent({
      url: base, token, version: 'test',
      vms: async () => [...vms],
      session: (vmId, sessionId) => sessions.get(vmId, sessionId),
      async handle(request) {
        const { vmId } = request.params
        if (request.method === 'createVm') return void vms.add(vmId)
        if (request.method === 'deleteVm') return void (sessions.stopAll(vmId), vms.delete(vmId))
        if (request.method === 'sessions') return sessions.list(vmId)
        return (await sessions.create(vmId)).info
      },
      log: () => {},
    })
    agent.start()
    cleanups.push(() => agent.stop())
    return vms
  }

  test('a workspace, a terminal in it, and deleting it', async () => {
    const { base, api, store, tokens } = await serve()
    expect((await api('/macs', '', {})).status).toBe(401)

    const asked = await api('/macs', 'ann', { method: 'POST', body: JSON.stringify({ name: 'one' }) })
    expect(asked.status).toBe(409)
    expect(await asked.json()).toMatchObject({ needsNewMac: true })

    const created = await api('/macs', 'ann', { method: 'POST', body: JSON.stringify({ name: 'one', confirmNewMac: true }) })
    expect(created.status).toBe(201)
    const { id } = (await created.json()) as { id: string }

    // An agent with the wrong token is turned away; the right one gets to work.
    expect((await fetch(`${base}/api/macs/agent`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401)
    const vms = startMac(base, tokens[0]!)
    await until(() => store.workspace(id)?.state === 'running')
    expect([...vms]).toEqual([id])

    expect((await api(`/macs/${id}/sessions`, 'bob')).status).toBe(404)
    const session = (await (await api(`/macs/${id}/sessions`, 'ann', { method: 'POST', body: '{}' })).json()) as { id: string }
    const { ticket } = (await (await api(`/macs/${id}/sessions/${session.id}/terminal/ticket`, 'ann', { method: 'POST', body: '{}' })).json()) as { ticket: string }

    const url = `${base.replace('http', 'ws')}/api/macs/${id}/sessions/${session.id}/terminal?ticket=${ticket}`
    const ws = new WebSocket(url)
    cleanups.push(() => ws.close())
    let output = ''
    let ready = false
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (message.type === 'ready') ready = true
      if (message.type === 'output') output += message.data
    })
    // Sent before the Mac has dialled back, so the control box buffers it.
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'input', data: 'echo hello-$((40+2))\n' })))
    await until(() => ready && output.includes('hello-42'), 5_000)

    // A ticket opens one terminal, once.
    const reused = new WebSocket(url)
    const closed = await new Promise<boolean>((resolve) => {
      reused.addEventListener('open', () => resolve(false))
      reused.addEventListener('error', () => resolve(true))
      reused.addEventListener('close', () => resolve(true))
    })
    expect(closed).toBe(true)

    expect((await api(`/macs/${id}`, 'ann', { method: 'DELETE' })).status).toBe(204)
    expect([...vms]).toEqual([])
    expect(await (await api('/macs')).json()).toEqual([])
  })
})
