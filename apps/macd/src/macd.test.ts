import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './config.ts'
import { MacSession } from './sessions.ts'
import type { Tart, TartVm } from './tart.ts'
import { bootstrapScript, Vms } from './vms.ts'

const ID = 'mac-0123456789ab'
const OTHER = 'mac-ba9876543210'
const THIRD = 'mac-aaaaaaaaaaaa'

function fakeTart(initial: TartVm[] = []) {
  const vms = new Map(initial.map((vm) => [vm.name, { ...vm }]))
  const calls: string[] = []
  const tart: Tart & { calls: string[]; vms: typeof vms } = {
    calls, vms,
    async list() {
      return [...vms.values()].map((vm) => ({ ...vm }))
    },
    async clone(image, name) {
      calls.push(`clone ${image} ${name}`)
      vms.set(name, { name, running: false })
    },
    async configure(name, { cpus, memoryMb }) {
      calls.push(`set ${name} ${cpus} ${memoryMb}`)
    },
    start(name) {
      calls.push(`run ${name}`)
      vms.get(name)!.running = true
    },
    async ip() {
      return '192.168.64.2'
    },
    async stop(name) {
      calls.push(`stop ${name}`)
      vms.get(name)!.running = false
    },
    async delete(name) {
      calls.push(`delete ${name}`)
      vms.delete(name)
    },
  }
  return tart
}

function fakeSsh({ failFirstContact = 0 } = {}) {
  const calls: string[] = []
  let failures = failFirstContact
  return {
    calls,
    async publicKey() {
      return 'ssh-ed25519 AAAAkey substrate-macd'
    },
    async execWithPassword(vmId: string, _ip: string, password: string, script: string) {
      calls.push(`password ${vmId} ${password} ${script.includes('PasswordAuthentication no')}`)
      if (failures-- > 0) throw new Error('Connection refused')
      return ''
    },
    async exec(vmId: string, _ip: string, script: string) {
      calls.push(`key ${vmId} ${script.includes('claude.ai/install.sh') ? 'extras' : script}`)
      return ''
    },
    async forget(vmId: string) {
      calls.push(`forget ${vmId}`)
    },
  }
}

async function makeVms(tart = fakeTart(), ssh = fakeSsh()) {
  const dir = await mkdtemp(join(tmpdir(), 'macd-'))
  const vms = new Vms({ tart, ssh, dir, baseImage: 'base', cpus: 4, memoryMb: 6144, log: () => {}, firstContact: { timeoutMs: 50, retryMs: 10 } })
  await vms.start()
  return { vms, tart, ssh, dir }
}

describe('Vms', () => {
  test('create clones, sizes and boots a VM, then locks down its SSH', async () => {
    const { vms, tart, ssh } = await makeVms()
    await vms.create(ID)
    expect(tart.calls).toEqual([`clone base ${ID}`, `set ${ID} 4 6144`, `run ${ID}`])
    // Signs in once with the base image's password, then by key only.
    expect(ssh.calls).toEqual([`password ${ID} admin true`, `forget ${ID}`, `key ${ID} true`, `key ${ID} extras`])
    expect(await vms.ids()).toEqual([ID])
    expect(await vms.address(ID)).toBe('192.168.64.2')
  })

  test('create is idempotent, and starts a stopped VM', async () => {
    const { vms, tart } = await makeVms()
    await vms.create(ID)
    await tart.stop(ID)
    tart.calls.length = 0
    await vms.create(ID)
    expect(tart.calls).toEqual([`run ${ID}`])
  })

  test('a Mac takes two VMs at most', async () => {
    const { vms } = await makeVms()
    await vms.create(ID)
    await vms.create(OTHER)
    expect(vms.create(THIRD)).rejects.toThrow('already has 2 VMs')
  })

  test('a VM whose first contact fails is discarded', async () => {
    const tart = fakeTart()
    const ssh = fakeSsh({ failFirstContact: 1_000 })
    const { vms } = await makeVms(tart, ssh)
    await expect(vms.create(ID)).rejects.toThrow('Connection refused')
    expect(ssh.calls.length).toBeGreaterThan(1)
    expect(tart.vms.has(ID)).toBe(false)
    expect(await vms.ids()).toEqual([])
  })

  test("at start, stopped VMs come back and half-made ones go; others' VMs are left alone", async () => {
    const tart = fakeTart()
    const { vms, dir, ssh } = await makeVms(tart)
    await vms.create(ID)
    await tart.stop(ID)
    tart.vms.set(OTHER, { name: OTHER, running: true })
    tart.vms.set('someone-elses', { name: 'someone-elses', running: false })
    tart.calls.length = 0

    await new Vms({ tart, ssh, dir, baseImage: 'base', cpus: 4, memoryMb: 6144, log: () => {} }).start()
    expect(tart.calls).toEqual([`run ${ID}`, `stop ${OTHER}`, `delete ${OTHER}`])
    expect(tart.vms.has('someone-elses')).toBe(true)
  })

  test('delete removes the VM and anything that would bring it back', async () => {
    const { vms, tart } = await makeVms()
    await vms.create(ID)
    await vms.delete(ID)
    await vms.delete(ID)
    expect(tart.vms.has(ID)).toBe(false)
    expect(await vms.ids()).toEqual([])
    expect(vms.address(ID)).rejects.toThrow('no VM')
  })

  test('the bootstrap turns password sign-in off and checks it', () => {
    const script = bootstrapScript('ssh-ed25519 AAAA substrate-macd', 'f00')
    expect(script).toContain("echo 'ssh-ed25519 AAAA substrate-macd' > ~/.ssh/authorized_keys")
    expect(script).toContain("grep -qx 'passwordauthentication no'")
    expect(script).toContain("dscl . -passwd /Users/admin 'f00'")
  })
})

describe('MacSession', () => {
  test('runs on a PTY, takes input and resizes, and replays its scrollback', async () => {
    const session = new MacSession(['/bin/sh'])
    let output = ''
    const detach = session.attach((m) => {
      if (m.type === 'output') output += m.data
    })
    expect(session.receive({ type: 'resize', cols: 100, rows: 30 })).toBe(true)
    expect(session.receive({ type: 'nonsense' })).toBe(false)
    session.receive({ type: 'input', data: 'stty size; echo done-$((1+1))\n' })
    const deadline = Date.now() + 5_000
    while (!output.includes('done-2') && Date.now() < deadline) await Bun.sleep(20)
    expect(output).toContain('30 100')
    detach()

    let replay = ''
    session.attach((m) => {
      if (m.type === 'ready') replay = m.scrollback
    })
    expect(replay).toContain('done-2')
    session.receive({ type: 'input', data: 'exit\n' })
    expect(await session.exited).toBe(0)
    expect(session.info.state).toBe('exited')
  })
})

test('config needs the control URL, token and base image', () => {
  expect(() => loadConfig({})).toThrow('SUBSTRATE_CONTROL_URL')
  const config = loadConfig({ SUBSTRATE_CONTROL_URL: 'https://x.example/', SUBSTRATE_MAC_TOKEN: 't', SUBSTRATE_MAC_BASE_IMAGE: 'i' })
  expect(config.controlUrl).toBe('https://x.example')
  expect(config.cpus).toBe(4)
})
