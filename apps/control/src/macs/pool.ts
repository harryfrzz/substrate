import { VMS_PER_MAC, type CreateMacWorkspace, type MacWorkspace, type NewMacNeeded } from '@substrate/protocol'
import { randomBytes } from 'node:crypto'
import type { MacAgents } from './agents.ts'
import type { MacCloud } from './cloud.ts'
import type { MacHost, MacStore, MacWorkspaceRow } from './store.ts'

export type MacPoolOptions = {
  store: MacStore
  cloud: MacCloud
  agents: MacAgents
  availabilityZones: readonly string[]
  // Never more Macs than this at once: the account's quota, and a cost cap.
  maxHosts: number
  maxPerUser: number
  hourlyUsd: number
  // The first-boot script for a new Mac, given its agent token.
  userData: (token: string) => string
  now?: () => number
}

// How long a new Mac may take to boot, prepare, and connect its agent.
const BOOT_TIMEOUT_MS = 90 * 60_000
// EC2 bills a Mac host for 24 hours at least.
const MINIMUM_MS = 24 * 3_600_000
// A Mac must have stood empty this long before it's released.
const EMPTY_GRACE_MS = 10 * 60_000

export class MacPoolError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 502, message: string, readonly body: Record<string, unknown> = {}) {
    super(message)
  }
}

export const toWorkspace = ({ id, name, state, createdAt, error }: MacWorkspaceRow): MacWorkspace => ({ id, name, state, createdAt, error })

// The pool of Mac hosts. A new workspace goes to a free slot on a Mac that's
// up or on its way up; only when every slot is taken is a new Mac allocated,
// after the user agreed to its cost. A Mac that has stood empty past its
// 24-hour minimum is released.
export class MacPool {
  private readonly o: Required<MacPoolOptions>
  // Placement and release happen one at a time.
  private queue = Promise.resolve()

  constructor(options: MacPoolOptions) {
    this.o = { now: Date.now, ...options }
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work)
    this.queue = result.then(() => {}, () => {})
    return result
  }

  // A new Mac's cost, for the confirmation the user is shown first.
  estimate(): NewMacNeeded {
    return { needsNewMac: true, hourlyUsd: this.o.hourlyUsd, minimumHours: 24 }
  }

  list(owner: string) {
    return this.o.store.workspacesOf(owner).map(toWorkspace)
  }

  // The workspace, if it's this user's; others' look like they don't exist.
  own(owner: string, id: string) {
    const row = this.o.store.workspace(id)
    if (!row || row.owner !== owner) throw new MacPoolError(404, `no macOS workspace ${id}`)
    return row
  }

  create(owner: string, { name, confirmNewMac }: CreateMacWorkspace): Promise<MacWorkspace> {
    return this.exclusive(async () => {
      const { store } = this.o
      const mine = store.workspacesOf(owner)
      if (mine.length >= this.o.maxPerUser) {
        throw new MacPoolError(409, `you have ${mine.length} macOS workspace${mine.length === 1 ? '' : 's'}, the most each user may have. Delete one first.`)
      }
      if (mine.some((w) => w.name === name)) throw new MacPoolError(409, `you already have a macOS workspace named ${name}`)

      let host = this.freeHost()
      if (!host) {
        const live = store.hosts().filter((h) => h.state !== 'releasing' && h.state !== 'failed')
        if (live.length >= this.o.maxHosts) {
          throw new MacPoolError(409, `every Mac is in use (${this.o.maxHosts * VMS_PER_MAC} macOS workspaces at most). Try again when one is free.`)
        }
        if (!confirmNewMac) throw new MacPoolError(409, 'this needs a new Mac', { ...this.estimate() })
        host = await this.provision()
      }
      const row: MacWorkspaceRow = {
        id: `mac-${randomBytes(6).toString('hex')}`,
        owner, name, hostId: host.id,
        state: host.state === 'ready' ? 'creating' : 'waiting',
        createdAt: new Date(this.o.now()).toISOString(),
        error: null,
      }
      store.addWorkspace(row)
      store.updateHost(host.id, { emptySince: null })
      void this.realize(row)
      return toWorkspace(row)
    })
  }

  remove(owner: string, id: string) {
    return this.exclusive(async () => {
      const row = this.own(owner, id)
      const host = this.o.store.host(row.hostId)
      // A Mac that isn't connected deletes it when it next says hello.
      if (host && this.o.agents.connected(host.id)) {
        this.o.store.updateWorkspace(id, { state: 'deleting' })
        try {
          await this.o.agents.call(host.id, { method: 'deleteVm', params: { vmId: id } }, 5 * 60_000)
        } catch (err) {
          this.o.store.updateWorkspace(id, { state: row.state })
          // A failed one may have no VM to delete; let it go regardless.
          if (row.state !== 'failed') throw new MacPoolError(502, `couldn't delete it on its Mac: ${(err as Error).message}`)
        }
      }
      this.o.store.removeWorkspace(id)
      if (host && this.o.store.workspacesOn(host.id).length === 0) {
        this.o.store.updateHost(host.id, { emptySince: new Date(this.o.now()).toISOString() })
      }
    })
  }

  // The host a workspace runs on, once it's running.
  hostOf(row: MacWorkspaceRow) {
    if (row.state !== 'running') throw new MacPoolError(409, `this macOS workspace is ${row.state}`)
    if (!this.o.agents.connected(row.hostId)) throw new MacPoolError(502, "its Mac isn't connected right now; try again shortly")
    return row.hostId
  }

  // After a control box restart: carry on with workspaces still on their way.
  resume() {
    for (const row of this.o.store.workspaces()) {
      if (row.state === 'waiting' || row.state === 'creating') void this.realize(row)
    }
  }

  start(intervalMs = 60_000) {
    this.resume()
    return setInterval(() => void this.reap(), intervalMs)
  }

  // Releases Macs that are empty and past their paid 24 hours, and gives up
  // on ones that never came up.
  reap() {
    return this.exclusive(async () => {
      const { store, cloud } = this.o
      const now = this.o.now()
      for (const host of store.hosts()) {
        const workspaces = store.workspacesOn(host.id)
        const allocated = host.allocatedAt ? Date.parse(host.allocatedAt) : now
        if (host.state === 'booting' && now - allocated > BOOT_TIMEOUT_MS && !this.o.agents.connected(host.id)) {
          store.updateHost(host.id, { state: 'failed', error: "it didn't come up within 90 minutes" })
          for (const w of workspaces) store.updateWorkspace(w.id, { state: 'failed', error: 'its Mac never came up' })
          continue
        }
        const empty = workspaces.length === 0
        const emptyFor = host.emptySince ? now - Date.parse(host.emptySince) : 0
        const due = host.state === 'releasing' || (empty && now - allocated >= MINIMUM_MS && emptyFor >= EMPTY_GRACE_MS)
        // A failed Mac with nothing on it goes too, once its day is paid for.
        if (!due && !(host.state === 'failed' && empty && now - allocated >= MINIMUM_MS)) continue
        try {
          if (host.state !== 'releasing') {
            store.updateHost(host.id, { state: 'releasing' })
            if (host.instanceId) await cloud.terminate(host.instanceId)
          }
          if (!host.ec2HostId || (await cloud.release(host.ec2HostId))) {
            store.updateHost(host.id, { state: 'released' })
            console.log(`macs: released ${host.ec2HostId ?? host.id}`)
          }
        } catch (err) {
          console.error(`macs: couldn't release ${host.ec2HostId ?? host.id}: ${(err as Error).message}`)
        }
      }
    })
  }

  // A Mac that's up or on its way, with a free slot; the fullest first, so
  // the others empty out and can be released.
  private freeHost() {
    const { store } = this.o
    return store
      .hosts()
      .filter((h) => h.state === 'allocating' || h.state === 'booting' || h.state === 'ready')
      .map((h) => ({ h, used: store.workspacesOn(h.id).length }))
      .filter(({ used }) => used < VMS_PER_MAC)
      .sort((a, b) => b.used - a.used)[0]?.h ?? null
  }

  private async provision(): Promise<MacHost> {
    const { store, cloud } = this.o
    const token = randomBytes(32).toString('hex')
    const host: MacHost = {
      id: `host-${randomBytes(6).toString('hex')}`,
      ec2HostId: null, instanceId: null, az: null, state: 'allocating',
      allocatedAt: null, emptySince: null, error: null,
    }
    store.addHost(host, token)
    try {
      const { hostId, az } = await cloud.allocateHost(this.o.availabilityZones)
      Object.assign(host, { ec2HostId: hostId, az, allocatedAt: new Date(this.o.now()).toISOString() })
      store.updateHost(host.id, { ec2HostId: hostId, az, allocatedAt: host.allocatedAt })
      host.instanceId = await cloud.launch({ hostId, az, userData: this.o.userData(token) })
      host.state = 'booting'
      store.updateHost(host.id, { instanceId: host.instanceId, state: 'booting' })
      console.log(`macs: allocated ${hostId} in ${az}, starting ${host.instanceId}`)
      return host
    } catch (err) {
      const message = (err as Error).message
      // An allocated host is billed regardless; keep it (failed) so the reaper
      // releases it after its 24 hours rather than losing track of it.
      store.updateHost(host.id, { state: host.ec2HostId ? 'failed' : 'released', error: message })
      throw new MacPoolError(502, `couldn't start a new Mac: ${message}`)
    }
  }

  // Waits for the workspace's Mac, then has its agent create the VM.
  private async realize(row: MacWorkspaceRow) {
    const { store, agents } = this.o
    try {
      await agents.whenConnected(row.hostId, BOOT_TIMEOUT_MS)
      if (store.workspace(row.id)?.state !== 'waiting' && store.workspace(row.id)?.state !== 'creating') return
      store.updateWorkspace(row.id, { state: 'creating' })
      await agents.call(row.hostId, { method: 'createVm', params: { vmId: row.id } })
      // Unless it's being deleted meanwhile.
      if (store.workspace(row.id)?.state === 'creating') store.updateWorkspace(row.id, { state: 'running', error: null })
    } catch (err) {
      if (store.workspace(row.id)?.state === 'creating' || store.workspace(row.id)?.state === 'waiting') {
        store.updateWorkspace(row.id, { state: 'failed', error: (err as Error).message })
      }
    }
  }

  // An agent said hello: its Mac is ready. A workspace it no longer has a VM
  // for is marked failed, and a VM no workspace has (deleted while the Mac
  // was out of touch) is deleted, so it doesn't hold one of the Mac's slots.
  hello(hostId: string, vms: string[]) {
    const { store, agents } = this.o
    store.updateHost(hostId, { state: 'ready', error: null })
    const workspaces = store.workspacesOn(hostId)
    for (const w of workspaces) {
      if (w.state === 'running' && !vms.includes(w.id)) store.updateWorkspace(w.id, { state: 'failed', error: 'its VM is gone from its Mac' })
    }
    for (const vmId of vms.filter((id) => !workspaces.some((w) => w.id === id))) {
      agents.call(hostId, { method: 'deleteVm', params: { vmId } }, 5 * 60_000)
        .then(() => console.log(`macs: deleted ${vmId}, left over on ${hostId}`))
        .catch((err: Error) => console.error(`macs: couldn't delete ${vmId}, left over on ${hostId}: ${err.message}`))
    }
  }
}
