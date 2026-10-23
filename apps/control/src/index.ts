import { websocket } from 'hono/bun'
import { createApp } from './app.ts'
import { clerkAuth, localDevAuth, type Authenticate } from './auth.ts'
import { config } from './config.ts'
import { createHostReader } from './host.ts'
import { Owners } from './owners.ts'
import { Tickets } from './tickets.ts'
import { Capabilities } from './capabilities.ts'
import { previewRoutes } from './previews.ts'
import { githubTokens } from './github.ts'
import { Jobs } from './jobs.ts'
import { MacAgents } from './macs/agents.ts'
import { awsMacCloud } from './macs/cloud.ts'
import { MacPool } from './macs/pool.ts'
import { macRoutes } from './macs/routes.ts'
import { MacStore } from './macs/store.ts'
import { macUserData } from './macs/user-data.ts'

const authenticate = config.clerk
  ? clerkAuth({ ...config.clerk, authorizedParties: config.authorizedParties, allowedEmails: config.allowedEmails })
  : config.vmsWithoutLogin
    ? localDevAuth
    : null
const owners = new Owners(config.db)
const tickets = new Tickets()
const capabilities = new Capabilities(config.db)
const jobs = new Jobs(config.db)

// macOS workspaces (M10), on the deployed control box only: each one can
// start a Mac that's billed for a day.
const macs = config.mac && authenticate ? setUpMacs(config.mac, authenticate) : undefined

function setUpMacs(mac: NonNullable<typeof config.mac>, authenticate: Authenticate) {
  const store = new MacStore(config.db)
  const agents = new MacAgents((hostId, vms) => pool.hello(hostId, vms))
  const pool = new MacPool({
    store, agents,
    cloud: awsMacCloud({ region: mac.region, instanceType: 'mac2.metal', macos: mac.macos, instanceProfile: 'substrate-mac', rootGiB: 300 }),
    availabilityZones: mac.availabilityZones,
    maxHosts: mac.maxHosts,
    maxPerUser: mac.maxPerUser,
    hourlyUsd: mac.hourlyUsd,
    userData: (token) => macUserData({ bucket: mac.bucket, bucketRegion: config.region, controlUrl: mac.publicUrl, token, baseImage: mac.baseImage }),
  })
  pool.start()
  return macRoutes({ authenticate, pool, agents, store, tickets })
}

const app = createApp({
  version: config.version,
  region: config.region,
  webDir: config.webDir,
  readHost: createHostReader(config.hostInstanceId, config.region),
  clerkPublishableKey: config.clerk?.publishableKey ?? null,
  macs,
  previews: config.hostd && config.previewOrigin ? previewRoutes({ hostd: config.hostd, owners, tickets, capabilities }) : undefined,
  vms: !config.hostd
    ? { unavailable: 'no sandbox host configured' }
    : !authenticate
      ? { unavailable: "sign-in isn't set up on this server yet, so VMs are off" }
      : {
          hostd: config.hostd,
          authenticate,
          owners,
          tickets,
          capabilities,
          jobs,
          previewOrigin: config.previewOrigin,
          githubToken: githubTokens(config.region),
          maxVmsPerUser: config.maxVmsPerUser,
        },
})

// Creating a VM waits for it to boot, which can take longer than Bun's default 10 s.
const server = Bun.serve({ port: config.port, idleTimeout: 120, fetch: app.fetch, websocket })
console.log(
  `substrate-control ${config.version} listening on :${server.port}` +
    (config.clerk ? ', Clerk sign-in on' : authenticate ? ', local dev without sign-in' : ''),
)
