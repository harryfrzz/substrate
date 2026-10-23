import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { run } from './run.ts'

// macd's own SSH key, and SSH into its VMs as their admin user. Each VM has
// its own known_hosts, learned the first time macd connects.
export class Ssh {
  private readonly key: string
  private readonly askpass: string

  constructor(private readonly dir: string) {
    this.key = join(dir, 'id_ed25519')
    this.askpass = join(dir, 'askpass.sh')
  }

  async init() {
    await mkdir(join(this.dir, 'known_hosts'), { recursive: true, mode: 0o700 })
    if (!existsSync(this.key)) await run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'substrate-macd', '-f', this.key])
    // Hands ssh the password from the environment, so it's never in argv.
    await writeFile(this.askpass, '#!/bin/sh\nprintf \'%s\\n\' "$SUBSTRATE_ASKPASS"\n')
    await chmod(this.askpass, 0o700)
  }

  publicKey() {
    return readFile(`${this.key}.pub`, 'utf8').then((key) => key.trim())
  }

  // The argv for an interactive login shell in the VM.
  shell(vmId: string, ip: string) {
    return ['ssh', ...this.keyOptions(vmId), '-tt', `admin@${ip}`]
  }

  // Runs a script in the VM, as admin.
  exec(vmId: string, ip: string, script: string, timeoutMs = 60_000) {
    return run(['ssh', ...this.keyOptions(vmId), `admin@${ip}`, 'bash -s'], { stdin: script, timeoutMs })
  }

  // The same, signing in with a password: only for a VM's first contact.
  execWithPassword(vmId: string, ip: string, password: string, script: string) {
    return run(
      ['ssh', ...this.options(vmId), '-o', 'PubkeyAuthentication=no', '-o', 'PreferredAuthentications=password,keyboard-interactive', '-o', 'NumberOfPasswordPrompts=1', `admin@${ip}`, 'bash -s'],
      { stdin: script, env: { SSH_ASKPASS: this.askpass, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: 'none', SUBSTRATE_ASKPASS: password }, timeoutMs: 120_000 },
    )
  }

  // Forgets the VM's host key (after it made itself new ones, or it's gone).
  forget(vmId: string) {
    return rm(join(this.dir, 'known_hosts', vmId), { force: true })
  }

  private options(vmId: string) {
    return [
      '-o', `UserKnownHostsFile=${join(this.dir, 'known_hosts', vmId)}`,
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ConnectTimeout=10',
      '-o', 'ServerAliveInterval=30',
      '-o', 'LogLevel=ERROR',
    ]
  }

  private keyOptions(vmId: string) {
    return ['-i', this.key, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', ...this.options(vmId)]
  }
}
