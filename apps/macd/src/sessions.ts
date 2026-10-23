import { TerminalInput, type Session, type TerminalOutput } from '@substrate/protocol'

type Listener = (message: TerminalOutput) => void
const MAX_SCROLLBACK_BYTES = 1024 * 1024
const MAX_SESSIONS_PER_VM = 16

// One terminal: here, ssh into the VM on a PTY, plus its scrollback. Like
// guestd's TerminalSession, it runs whether or not anyone is attached, and
// every attach replays the scrollback first.
export class MacSession {
  readonly id = crypto.randomUUID()
  readonly createdAt = new Date().toISOString()
  private readonly terminal: Bun.Terminal
  private readonly process: Bun.Subprocess
  private listeners = new Set<Listener>()
  private chunks: string[] = []
  private bytes = 0
  private truncated = false
  private cols = 80
  private rows = 24
  private exitCode: number | null = null

  constructor(argv: string[]) {
    const decoder = new TextDecoder()
    this.terminal = new Bun.Terminal({
      cols: this.cols,
      rows: this.rows,
      data: (_terminal, data) => {
        const text = decoder.decode(data, { stream: true })
        if (text) this.output(text)
      },
    })
    this.process = Bun.spawn(argv, {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/', TERM: 'xterm-256color', LANG: 'en_US.UTF-8' },
      terminal: this.terminal,
    })
    void this.process.exited.then((code) => {
      this.exitCode = code
      this.broadcast({ type: 'exit', exitCode: code })
      this.terminal.close()
    })
  }

  get exited() {
    return this.process.exited
  }

  get state(): Session['state'] {
    return this.exitCode === null ? 'running' : 'exited'
  }

  get info(): Session {
    return { id: this.id, agent: null, createdAt: this.createdAt, state: this.state, exitCode: this.exitCode }
  }

  attach(listener: Listener) {
    listener({ type: 'ready', scrollback: this.chunks.join(''), truncated: this.truncated, cols: this.cols, rows: this.rows, state: this.state, exitCode: this.exitCode })
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  // False for a message that isn't valid terminal input.
  receive(value: unknown) {
    const message = TerminalInput.safeParse(value)
    if (!message.success) return false
    if (this.state === 'exited') return true
    if (message.data.type === 'input') {
      this.terminal.write(message.data.data)
    } else {
      this.cols = message.data.cols
      this.rows = message.data.rows
      this.terminal.resize(this.cols, this.rows)
      // The PTY isn't ssh's controlling terminal, so the kernel won't tell it.
      this.process.kill('SIGWINCH')
    }
    return true
  }

  stop() {
    this.listeners.clear()
    if (this.state === 'running') this.process.kill('SIGKILL')
  }

  private output(data: string) {
    this.chunks.push(data)
    this.bytes += Buffer.byteLength(data)
    while (this.bytes > MAX_SCROLLBACK_BYTES && this.chunks.length > 1) {
      this.bytes -= Buffer.byteLength(this.chunks.shift()!)
      this.truncated = true
    }
    this.broadcast({ type: 'output', data })
  }

  private broadcast(message: TerminalOutput) {
    for (const listener of this.listeners) listener(message)
  }
}

// Each VM's terminals. They end if macd restarts.
export class MacSessions {
  private byVm = new Map<string, Map<string, MacSession>>()

  // `argv` gives the command for a new terminal in a VM.
  constructor(private readonly argv: (vmId: string) => Promise<string[]>) {}

  list(vmId: string) {
    return [...(this.byVm.get(vmId)?.values() ?? [])].map((s) => s.info)
  }

  get(vmId: string, sessionId: string) {
    return this.byVm.get(vmId)?.get(sessionId)
  }

  async create(vmId: string) {
    const argv = await this.argv(vmId)
    const sessions = this.byVm.get(vmId) ?? new Map<string, MacSession>()
    if (sessions.size >= MAX_SESSIONS_PER_VM) {
      // Make room by forgetting the oldest session that has ended.
      const ended = [...sessions.values()].find((s) => s.state === 'exited')
      if (!ended) throw new Error(`this workspace already has ${MAX_SESSIONS_PER_VM} terminals`)
      sessions.delete(ended.id)
    }
    const session = new MacSession(argv)
    sessions.set(session.id, session)
    this.byVm.set(vmId, sessions)
    return session
  }

  stopAll(vmId: string) {
    for (const session of this.byVm.get(vmId)?.values() ?? []) session.stop()
    this.byVm.delete(vmId)
  }
}
