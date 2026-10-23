import { ControlMessage, type AgentMessage, type AgentRequest, type TerminalOutput } from '@substrate/protocol'

// A terminal session, as far as a stream needs one.
export type Attachable = {
  attach(listener: (message: TerminalOutput) => void): () => void
  receive(value: unknown): boolean
}

type Socket = Pick<WebSocket, 'send' | 'close' | 'addEventListener' | 'readyState'> & { ping?: () => void }

type Options = {
  // The control box's public URL.
  url: string
  token: string
  version: string
  // The workspaces this Mac has VMs for, for the hello.
  vms: () => Promise<string[]>
  // Every request but openStream, which the agent handles itself.
  handle: (request: Exclude<AgentRequest, { method: 'openStream' }>) => Promise<unknown>
  session: (vmId: string, sessionId: string) => Attachable | undefined
  socket?: (url: string, headers: Record<string, string>) => Socket
  log?: (message: string) => void
}

const PING_MS = 30_000
const MAX_RETRY_MS = 30_000

// macd's link to the control box: one WebSocket that it dials out on (the Mac
// needs no open port), carrying requests down and responses up. Each terminal
// gets a WebSocket of its own, dialled back when the control box asks.
export class Agent {
  private ws: Socket | null = null
  private stopped = false
  private attempts = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private pinger: ReturnType<typeof setInterval> | undefined
  private readonly socket: NonNullable<Options['socket']>
  private readonly log: (message: string) => void

  constructor(private readonly o: Options) {
    this.socket = o.socket ?? ((url, headers) => new WebSocket(url, { headers }))
    this.log = o.log ?? console.log
  }

  start() {
    this.stopped = false
    this.connect()
  }

  stop() {
    this.stopped = true
    clearTimeout(this.timer)
    clearInterval(this.pinger)
    this.ws?.close(1000)
  }

  private get headers() {
    return { authorization: `Bearer ${this.o.token}` }
  }

  private wsUrl(path: string) {
    const url = new URL(path, this.o.url)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return url.href
  }

  private connect() {
    if (this.stopped) return
    const ws = this.socket(this.wsUrl('/api/macs/agent'), this.headers)
    this.ws = ws
    ws.addEventListener('open', () => {
      this.attempts = 0
      this.log('connected to the control box')
      clearInterval(this.pinger)
      this.pinger = setInterval(() => ws.ping?.(), PING_MS)
      void this.o.vms()
        .then((vms) => this.send(ws, { type: 'hello', version: this.o.version, vms }))
        .catch((err: Error) => {
          this.log(`couldn't list VMs for the hello: ${err.message}`)
          ws.close(1011)
        })
    })
    ws.addEventListener('message', (event) => {
      const parsed = ControlMessage.safeParse(parseJson((event as MessageEvent).data))
      if (!parsed.success) return
      const { type: _, id, ...request } = parsed.data
      void this.answer(ws, id, request as AgentRequest)
    })
    ws.addEventListener('close', () => {
      clearInterval(this.pinger)
      if (this.ws !== ws || this.stopped) return
      this.ws = null
      const delay = Math.min(1_000 * 2 ** this.attempts++, MAX_RETRY_MS)
      this.log(`lost the control box; reconnecting in ${delay / 1000} s`)
      this.timer = setTimeout(() => this.connect(), delay)
    })
  }

  private async answer(ws: Socket, id: number, request: AgentRequest) {
    try {
      const result = request.method === 'openStream' ? await this.openStream(request.params) : await this.o.handle(request)
      this.send(ws, { type: 'response', id, ok: true, result })
    } catch (err) {
      this.send(ws, { type: 'response', id, ok: false, error: (err as Error).message })
    }
  }

  // Dials back for a browser's terminal and attaches it to the session.
  private openStream({ vmId, sessionId, streamId }: { vmId: string; sessionId: string; streamId: string }) {
    const session = this.o.session(vmId, sessionId)
    if (!session) return Promise.reject(new Error('no such terminal'))
    return new Promise<null>((resolve, reject) => {
      const ws = this.socket(this.wsUrl(`/api/macs/agent/streams/${encodeURIComponent(streamId)}`), this.headers)
      let detach = () => {}
      let opened = false
      ws.addEventListener('open', () => {
        opened = true
        detach = session.attach((message) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
        })
        resolve(null)
      })
      ws.addEventListener('message', (event) => {
        if (!session.receive(parseJson((event as MessageEvent).data))) ws.close(1003, 'invalid terminal message')
      })
      ws.addEventListener('close', () => {
        detach()
        if (!opened) reject(new Error("couldn't connect the terminal back to the control box"))
      })
    })
  }

  private send(ws: Socket, message: AgentMessage) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
  }
}

function parseJson(value: unknown): unknown {
  try {
    return JSON.parse(String(value))
  } catch {
    return null
  }
}
