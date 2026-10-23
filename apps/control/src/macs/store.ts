import { Database } from 'bun:sqlite'
import type { MacWorkspaceState } from '@substrate/protocol'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

// allocating: asking EC2 for a host. booting: its instance is starting and
// preparing (15 minutes or more). ready: its agent is connected. releasing:
// idle past its 24-hour minimum, on its way out.
export type MacHostState = 'allocating' | 'booting' | 'ready' | 'failed' | 'releasing' | 'released'

export type MacHost = {
  id: string
  ec2HostId: string | null
  instanceId: string | null
  az: string | null
  state: MacHostState
  // When EC2 started billing it (24 hours at least).
  allocatedAt: string | null
  // When its last workspace went away, if it has none.
  emptySince: string | null
  error: string | null
}

export type MacWorkspaceRow = {
  id: string
  owner: string
  name: string
  hostId: string
  state: MacWorkspaceState
  createdAt: string
  error: string | null
}

export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex')

// The Mac pool's state, in the control box's SQLite database. Each host's
// agent token is kept only as a hash.
export class MacStore {
  private db: Database

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path, { create: true, strict: true })
    this.db.run('pragma journal_mode = wal')
    this.db.run(`create table if not exists mac_hosts (
      id text primary key, ec2HostId text, instanceId text, az text, state text not null,
      allocatedAt text, emptySince text, error text, tokenHash text not null
    )`)
    this.db.run(`create table if not exists mac_workspaces (
      id text primary key, owner text not null, name text not null, hostId text not null,
      state text not null, createdAt text not null, error text
    )`)
  }

  hosts(): MacHost[] {
    return this.db.query("select * from mac_hosts where state != 'released' order by rowid").all() as MacHost[]
  }

  host(id: string) {
    return this.db.query('select * from mac_hosts where id = ?').get(id) as MacHost | null
  }

  // The host an agent's token belongs to, while it may connect.
  hostForToken(token: string) {
    return this.db
      .query("select * from mac_hosts where tokenHash = ? and state in ('booting', 'ready')")
      .get(tokenHash(token)) as MacHost | null
  }

  addHost(host: MacHost, token: string) {
    this.db.query('insert into mac_hosts values ($id, $ec2HostId, $instanceId, $az, $state, $allocatedAt, $emptySince, $error, $tokenHash)')
      .run({ ...host, tokenHash: tokenHash(token) })
  }

  updateHost(id: string, fields: Partial<Omit<MacHost, 'id'>>) {
    for (const [key, value] of Object.entries(fields)) {
      this.db.query(`update mac_hosts set ${key} = ? where id = ?`).run(value as string | null, id)
    }
  }

  workspaces(): MacWorkspaceRow[] {
    return this.db.query('select * from mac_workspaces order by createdAt').all() as MacWorkspaceRow[]
  }

  workspace(id: string) {
    return this.db.query('select * from mac_workspaces where id = ?').get(id) as MacWorkspaceRow | null
  }

  workspacesOf(owner: string) {
    return this.db.query('select * from mac_workspaces where owner = ? order by createdAt').all(owner) as MacWorkspaceRow[]
  }

  workspacesOn(hostId: string) {
    return this.db.query('select * from mac_workspaces where hostId = ?').all(hostId) as MacWorkspaceRow[]
  }

  addWorkspace(row: MacWorkspaceRow) {
    this.db.query('insert into mac_workspaces values ($id, $owner, $name, $hostId, $state, $createdAt, $error)').run(row)
  }

  updateWorkspace(id: string, fields: Partial<Pick<MacWorkspaceRow, 'state' | 'error'>>) {
    for (const [key, value] of Object.entries(fields)) {
      this.db.query(`update mac_workspaces set ${key} = ? where id = ?`).run(value as string | null, id)
    }
  }

  removeWorkspace(id: string) {
    this.db.query('delete from mac_workspaces where id = ?').run(id)
  }
}
