import { join } from 'node:path'
import { Agent } from './agent.ts'
import { loadConfig } from './config.ts'
import { MacSessions } from './sessions.ts'
import { Ssh } from './ssh.ts'
import { tartCli } from './tart.ts'
import { Vms } from './vms.ts'

// macd: runs on each Mac host as ec2-user (a LaunchDaemon from setup-mac.sh),
// keeps that Mac's macOS VMs, and takes the control box's requests.
const { config, ssh, vms } = await prepare().catch((err: Error) => {
  // One line, not the minified source around it.
  console.error(`substrate-macd couldn't start: ${err.message}`)
  process.exit(1)
})

async function prepare() {
  const config = loadConfig()
  const ssh = new Ssh(join(config.stateDir, 'ssh'))
  await ssh.init()
  const vms = new Vms({ tart: tartCli(), ssh, dir: config.stateDir, baseImage: config.baseImage, cpus: config.cpus, memoryMb: config.memoryMb })
  await vms.start()
  return { config, ssh, vms }
}
const sessions = new MacSessions(async (vmId) => ssh.shell(vmId, await vms.address(vmId)))

const agent = new Agent({
  url: config.controlUrl,
  token: config.token,
  version: config.version,
  vms: () => vms.ids(),
  session: (vmId, sessionId) => sessions.get(vmId, sessionId),
  async handle(request) {
    const { vmId } = request.params
    switch (request.method) {
      case 'createVm':
        await vms.create(vmId)
        return null
      case 'deleteVm':
        sessions.stopAll(vmId)
        await vms.delete(vmId)
        return null
      case 'sessions':
        return sessions.list(vmId)
      case 'createSession':
        return (await sessions.create(vmId)).info
    }
  },
})
agent.start()
console.log(`substrate-macd ${config.version}, dialling ${config.controlUrl}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    agent.stop()
    process.exit(0)
  })
}
