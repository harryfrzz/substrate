import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { run } from './run.ts'

export type TartVm = { name: string; running: boolean }

// What macd needs from tart (https://tart.run); tests substitute a fake.
export interface Tart {
  list(): Promise<TartVm[]>
  clone(image: string, name: string): Promise<void>
  configure(name: string, size: { cpus: number; memoryMb: number }): Promise<void>
  // Boots it without a display, behind softnet (which keeps it off the other
  // VM and the Mac's own network). It keeps running if macd restarts.
  start(name: string, log: string): void
  // Waits for it to have an address.
  ip(name: string): Promise<string>
  stop(name: string): Promise<void>
  delete(name: string): Promise<void>
}

export function tartCli(bin = 'tart'): Tart {
  return {
    async list() {
      const vms = JSON.parse(await run([bin, 'list', '--source', 'local', '--format', 'json'])) as { Name: string; State?: string; Running?: boolean }[]
      return vms.map((vm) => ({ name: vm.Name, running: vm.Running ?? vm.State === 'running' }))
    },
    async clone(image, name) {
      await run([bin, 'clone', image, name])
    },
    async configure(name, { cpus, memoryMb }) {
      await run([bin, 'set', name, '--cpu', String(cpus), '--memory', String(memoryMb)])
    },
    start(name, log) {
      const fd = openSync(log, 'a')
      spawn(bin, ['run', name, '--no-graphics', '--net-softnet'], { detached: true, stdio: ['ignore', fd, fd] }).unref()
      closeSync(fd)
    },
    async ip(name) {
      return (await run([bin, 'ip', name, '--wait', '180'])).trim()
    },
    async stop(name) {
      await run([bin, 'stop', name])
    },
    async delete(name) {
      await run([bin, 'delete', name])
    },
  }
}
