import { homedir } from 'node:os'
import { join } from 'node:path'

declare const BUILD_VERSION: string | undefined

// From the environment: setup-mac.sh writes it to /opt/substrate/macd.env,
// readable by ec2-user only, since the agent token is in it.
export function loadConfig(env: Record<string, string | undefined> = process.env) {
  const need = (key: string) => {
    const value = env[key]
    if (!value) throw new Error(`${key} isn't set`)
    return value
  }
  return {
    version: typeof BUILD_VERSION === 'string' ? BUILD_VERSION : 'dev',
    controlUrl: need('SUBSTRATE_CONTROL_URL').replace(/\/+$/, ''),
    token: need('SUBSTRATE_MAC_TOKEN'),
    baseImage: need('SUBSTRATE_MAC_BASE_IMAGE'),
    stateDir: env.SUBSTRATE_MACD_STATE ?? join(homedir(), '.substrate-macd'),
    // A mac2.metal is an M1 with 8 cores and 16 GiB, for two VMs and macOS itself.
    cpus: Number(env.SUBSTRATE_MAC_VM_CPUS ?? 4),
    memoryMb: Number(env.SUBSTRATE_MAC_VM_MEMORY_MB ?? 6144),
  }
}
export type Config = ReturnType<typeof loadConfig>
