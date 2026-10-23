import { VMS_PER_MAC } from '@substrate/protocol'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Ssh } from './ssh.ts'
import type { Tart } from './tart.ts'

type VmRecord = { id: string; password: string; createdAt: string }

type Options = {
  tart: Tart
  ssh: Pick<Ssh, 'publicKey' | 'exec' | 'execWithPassword' | 'forget'>
  dir: string
  baseImage: string
  cpus: number
  memoryMb: number
  log?: (message: string) => void
  // How long to keep trying a new VM's sshd, and how often.
  firstContact?: { timeoutMs: number; retryMs: number }
}

// The control box names workspaces mac-<12 hex>; the VMs are named the same.
export const isWorkspaceId = (name: string) => /^mac-[0-9a-f]{12}$/.test(name)

// The Cirrus Labs base images sign in as admin/admin.
const BASE_PASSWORD = 'admin'

// Gives a fresh VM macd's key, key-only SSH, host keys of its own instead of
// the base image's, and a password nobody knows. Password sign-in must really
// be off afterwards, or this fails.
export const bootstrapScript = (publicKey: string, password: string) => `set -euo pipefail
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo '${publicKey}' > ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
printf 'PasswordAuthentication no\\nKbdInteractiveAuthentication no\\n' | sudo tee /etc/ssh/sshd_config.d/000-substrate.conf >/dev/null
sudo rm -f /etc/ssh/ssh_host_*
sudo ssh-keygen -A >/dev/null
sudo /usr/sbin/sshd -T 2>/dev/null | grep -qx 'passwordauthentication no' || { echo 'password sign-in is still on' >&2; exit 1; }
sudo dscl . -passwd /Users/admin '${password}'
`

// Claude Code, for the agent most people will run. Best effort: a workspace
// without it is still a workspace.
const extrasScript = `set -euo pipefail
curl -fsSL https://claude.ai/install.sh | bash >/dev/null
grep -q '.local/bin' ~/.zprofile 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zprofile
`

// The macOS VMs on this Mac, one per workspace. Each VM's operations happen
// one at a time.
export class Vms {
  private locks = new Map<string, Promise<unknown>>()
  private readonly log: (message: string) => void

  constructor(private readonly o: Options) {
    this.log = o.log ?? console.log
  }

  // At macd's start: VMs that were running come back (after the Mac
  // restarted, say), and any a failed create left half-made go.
  async start() {
    await mkdir(join(this.o.dir, 'vms'), { recursive: true, mode: 0o700 })
    await mkdir(join(this.o.dir, 'logs'), { recursive: true })
    for (const vm of await this.o.tart.list()) {
      if (!isWorkspaceId(vm.name)) continue
      if (!(await this.record(vm.name))) {
        this.log(`${vm.name}: discarding a half-made VM`)
        await this.discard(vm.name)
      } else if (!vm.running) {
        this.log(`${vm.name}: starting`)
        this.o.tart.start(vm.name, this.logFile(vm.name))
      }
    }
  }

  // The workspaces this Mac has VMs for.
  async ids() {
    const names = (await this.o.tart.list()).map((vm) => vm.name).filter(isWorkspaceId)
    const made = await Promise.all(names.map(async (name) => ((await this.record(name)) ? name : null)))
    return made.filter((name) => name !== null)
  }

  create(id: string) {
    return this.locked(id, async () => {
      if (!isWorkspaceId(id)) throw new Error(`${id} isn't a workspace ID`)
      if (await this.record(id)) return void (await this.ensureRunning(id))
      const vms = (await this.o.tart.list()).filter((vm) => isWorkspaceId(vm.name))
      if (vms.some((vm) => vm.name === id)) await this.discard(id)
      if (vms.filter((vm) => vm.name !== id).length >= VMS_PER_MAC) throw new Error(`this Mac already has ${VMS_PER_MAC} VMs`)
      const started = Date.now()
      try {
        await this.o.tart.clone(this.o.baseImage, id)
        await this.o.tart.configure(id, { cpus: this.o.cpus, memoryMb: this.o.memoryMb })
        this.o.tart.start(id, this.logFile(id))
        const ip = await this.o.tart.ip(id)
        const password = randomBytes(16).toString('hex')
        await this.firstContact(id, ip, password)
        const record: VmRecord = { id, password, createdAt: new Date().toISOString() }
        await writeFile(this.recordFile(id), JSON.stringify(record), { mode: 0o600 })
      } catch (err) {
        await this.discard(id)
        throw err
      }
      await this.o.ssh.exec(id, await this.o.tart.ip(id), extrasScript, 5 * 60_000)
        .catch((err: Error) => this.log(`${id}: couldn't install Claude Code: ${err.message}`))
      this.log(`${id}: ready in ${Math.round((Date.now() - started) / 1000)} s`)
    })
  }

  delete(id: string) {
    return this.locked(id, () => this.discard(id))
  }

  // Its address, starting it first if it has stopped.
  async address(id: string) {
    if (!(await this.record(id))) throw new Error(`no VM for ${id} on this Mac`)
    await this.ensureRunning(id)
    return this.o.tart.ip(id)
  }

  // sshd can take a little while after the VM has an address.
  private async firstContact(id: string, ip: string, password: string) {
    const script = bootstrapScript(await this.o.ssh.publicKey(), password)
    const { timeoutMs, retryMs } = this.o.firstContact ?? { timeoutMs: 3 * 60_000, retryMs: 5_000 }
    const deadline = Date.now() + timeoutMs
    for (;;) {
      try {
        await this.o.ssh.execWithPassword(id, ip, BASE_PASSWORD, script)
        break
      } catch (err) {
        if (Date.now() > deadline) throw err
        await Bun.sleep(retryMs)
      }
    }
    // It has new host keys now; learn them over key-based SSH.
    await this.o.ssh.forget(id)
    await this.o.ssh.exec(id, ip, 'true')
  }

  private async ensureRunning(id: string) {
    const vm = (await this.o.tart.list()).find((v) => v.name === id)
    if (vm && !vm.running) this.o.tart.start(id, this.logFile(id))
  }

  // Stops and deletes it, ignoring what's already gone.
  private async discard(id: string) {
    const exists = (await this.o.tart.list()).some((vm) => vm.name === id)
    if (exists) {
      await this.o.tart.stop(id).catch(() => {})
      await this.o.tart.delete(id)
    }
    await rm(this.recordFile(id), { force: true })
    await this.o.ssh.forget(id)
    await rm(this.logFile(id), { force: true })
  }

  private record(id: string) {
    return readFile(this.recordFile(id), 'utf8').then((text) => JSON.parse(text) as VmRecord, () => null)
  }

  private recordFile(id: string) {
    return join(this.o.dir, 'vms', `${id}.json`)
  }

  private logFile(id: string) {
    return join(this.o.dir, 'logs', `${id}.log`)
  }

  private locked<T>(id: string, work: () => Promise<T>): Promise<T> {
    const result = (this.locks.get(id) ?? Promise.resolve()).then(work)
    const settled = result.then(() => {}, () => {})
    this.locks.set(id, settled)
    void settled.then(() => {
      if (this.locks.get(id) === settled) this.locks.delete(id)
    })
    return result
  }
}
