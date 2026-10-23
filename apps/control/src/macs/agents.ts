import { AgentMessage, type AgentRequest } from '@substrate/protocol'
import type { WSContext, WSEvents } from 'hono/ws'
import { randomBytes } from 'node:crypto'

type Link = { ws: WSContext; pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }> }
type Stream = { hostId: string; browser: WSContext; agent: WSContext | null; buffered: string[]; timer: ReturnType<typeof setTimeout> }

// A dialled-back stream that hasn't arrived by then is given up on.
const STREAM_TIMEOUT_MS = 15_000

// The Macs' agents (macd), each connected over one WebSocket that it dialled
// out on, so no Mac needs an open port. Requests go down it as JSON; a
// browser terminal gets its own WebSocket, which macd dials back on request
// and the control box pairs with the browser's.
export class MacAgents {
  private links = new Map<string, Link>()
  private waiters = new Map<string, (() => void)[]>()
  private streams = new Map<string, Stream>()
  private nextId = 1

  constructor(private readonly onHello: (hostId: string, vms: string[]) => void = () => {}) {}

  connected(hostId: string) {
    return this.links.has(hostId)
  }

  // Resolves once the host's agent is connected (or right away if it is).
  whenConnected(hostId: string, timeoutMs: number) {
    if (this.connected(hostId)) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.set(hostId, (this.waiters.get(hostId) ?? []).filter((w) => w !== done))
        reject(new Error('the Mac never came up'))
      }, timeoutMs)
      const done = () => {
        clearTimeout(timer)
        resolve()
      }
      this.waiters.set(hostId, [...(this.waiters.get(hostId) ?? []), done])
    })
  }

  // The agent's own connection.
  connection(hostId: string): WSEvents {
    let link: Link | null = null
    return {
      onOpen: (_event, ws) => {
        // A reconnecting agent replaces its previous link, whose calls won't be answered.
        const previous = this.links.get(hostId)
        link = { ws, pending: new Map() }
        this.links.set(hostId, link)
        if (previous) {
          for (const call of previous.pending.values()) call.reject(new Error("the Mac's agent reconnected"))
          previous.ws.close(1012, 'replaced')
        }
      },
      onMessage: (event) => {
        const parsed = AgentMessage.safeParse(parseJson(event.data))
        if (!parsed.success || !link) return
        const message = parsed.data
        if (message.type === 'hello') {
          this.onHello(hostId, message.vms)
          for (const done of this.waiters.get(hostId) ?? []) done()
          this.waiters.delete(hostId)
        } else {
          const call = link.pending.get(message.id)
          link.pending.delete(message.id)
          if (message.ok) call?.resolve(message.result)
          else call?.reject(new Error(message.error ?? 'the Mac refused'))
        }
      },
      onClose: () => {
        if (!link || this.links.get(hostId) !== link) return
        this.links.delete(hostId)
        for (const call of link.pending.values()) call.reject(new Error("lost the Mac's agent"))
      },
    }
  }

  call<T>(hostId: string, request: AgentRequest, timeoutMs = 30 * 60_000): Promise<T> {
    const link = this.links.get(hostId)
    if (!link) return Promise.reject(new Error("the Mac's agent isn't connected"))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        link.pending.delete(id)
        reject(new Error(`the Mac didn't answer ${request.method}`))
      }, timeoutMs)
      link.pending.set(id, {
        resolve: (value) => (clearTimeout(timer), resolve(value as T)),
        reject: (error) => (clearTimeout(timer), reject(error)),
      })
      link.ws.send(JSON.stringify({ type: 'request', id, ...request }))
    })
  }

  // The browser's side of a terminal: asks the agent to dial back, then relays
  // frames between the two, buffering the browser's until the agent arrives.
  terminal(hostId: string, vmId: string, sessionId: string): WSEvents {
    const streamId = randomBytes(18).toString('base64url')
    return {
      onOpen: (_event, browser) => {
        const timer = setTimeout(() => this.endStream(streamId, 1011, "the Mac didn't connect the terminal"), STREAM_TIMEOUT_MS)
        this.streams.set(streamId, { hostId, browser, agent: null, buffered: [], timer })
        this.call(hostId, { method: 'openStream', params: { vmId, sessionId, streamId } }, STREAM_TIMEOUT_MS)
          .catch((err: Error) => this.endStream(streamId, 1011, err.message))
      },
      onMessage: (event) => {
        const stream = this.streams.get(streamId)
        if (!stream) return
        const data = String(event.data)
        if (stream.agent) stream.agent.send(data)
        else stream.buffered.push(data)
      },
      onClose: () => this.endStream(streamId),
    }
  }

  // The agent's dialled-back side of a terminal. Null for a stream that isn't
  // waiting, or belongs to another host.
  streamConnection(hostId: string, streamId: string): WSEvents | null {
    const stream = this.streams.get(streamId)
    if (!stream || stream.hostId !== hostId || stream.agent) return null
    return {
      onOpen: (_event, agent) => {
        const current = this.streams.get(streamId)
        if (!current) return agent.close(1000)
        clearTimeout(current.timer)
        current.agent = agent
        for (const data of current.buffered.splice(0)) agent.send(data)
      },
      onMessage: (event) => this.streams.get(streamId)?.browser.send(String(event.data)),
      onClose: () => this.endStream(streamId),
    }
  }

  private endStream(streamId: string, code = 1000, reason = '') {
    const stream = this.streams.get(streamId)
    if (!stream) return
    this.streams.delete(streamId)
    clearTimeout(stream.timer)
    stream.browser.close(code, reason)
    stream.agent?.close(code, reason)
  }
}

function parseJson(value: unknown): unknown {
  try {
    return JSON.parse(String(value))
  } catch {
    return null
  }
}
