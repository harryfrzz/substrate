import { MacWorkspace, Session, Vm, RunCheckpoint, type CreateMacWorkspace, type ResizeVm, type ForkVm, type CreateSession, type CreateVm, type UpdateVm } from '@substrate/protocol'
import { authHeaders } from '../auth.ts'

export class WorkspaceApiError extends Error {
  constructor(readonly status: number, message: string, readonly body: unknown = null) {
    super(message)
  }
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, { ...init, headers: { ...(init?.headers as Record<string, string>), ...(await authHeaders()) } })
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    const message = body && typeof body.error === 'string' ? body.error : `Request failed (${response.status})`
    throw new WorkspaceApiError(response.status, message, body)
  }
  return response.status === 204 ? null : response.json()
}

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

const vmPath = (id: string) => `/api/vms/${encodeURIComponent(id)}`
async function waitForVmJob(job: { id: string; vmId: string }) {
  for (;;) {
    const status = await request(`/api/jobs/${encodeURIComponent(job.id)}`) as { state: string; error: string | null }
    if (status.state === 'failed') throw new Error(status.error ?? 'Workspace operation failed')
    if (status.state === 'done') return Vm.parse(await request(vmPath(job.vmId)))
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
}
export const workspaceApi = {
  async list(signal?: AbortSignal) {
    return Vm.array().parse(await request('/api/vms', { signal }))
  },
  async create(input: CreateVm) {
    const result = await request('/api/vms', post(input))
    const vm = Vm.safeParse(result)
    return vm.success ? vm.data : waitForVmJob(result as { id: string; vmId: string })
  },
  async start(vmId: string) {
    return Vm.parse(await request(`${vmPath(vmId)}/start`, post({})))
  },
  async pause(vmId: string) {
    return Vm.parse(await request(`${vmPath(vmId)}/pause`, post({})))
  },
  async resume(vmId: string) {
    return Vm.parse(await request(`${vmPath(vmId)}/resume`, post({})))
  },
  async update(vmId: string, input: UpdateVm) {
    return Vm.parse(await request(vmPath(vmId), { ...post(input), method: 'PATCH' }))
  },
  async stop(vmId: string) { return Vm.parse(await request(`${vmPath(vmId)}/stop`, post({}))) },
  async remove(vmId: string) { await request(vmPath(vmId), { method: 'DELETE' }) },
  async resize(vmId: string, input: ResizeVm) { return Vm.parse(await request(`${vmPath(vmId)}/resize`, post(input))) },
  async fork(vmId: string, input: ForkVm) {
    const job = await request(`${vmPath(vmId)}/fork`, post(input)) as { id: string; vmId: string }
    return waitForVmJob(job)
  },
  async checkpoints(vmId: string) { return RunCheckpoint.array().parse(await request(`${vmPath(vmId)}/checkpoints`)) },
  async rollback(vmId: string, id: string) { return Vm.parse(await request(`${vmPath(vmId)}/checkpoints/${encodeURIComponent(id)}/restore`, post({}))) },
  async preview(vmId: string, port: number) { return await request(`${vmPath(vmId)}/previews`, post({ port })) as { url: string; basePath: string } },
  async authorizeSsh(vmId: string, publicKey: string) { await request(`${vmPath(vmId)}/ssh/keys`, post({ publicKey })) },
  async sshAccess(vmId: string) { return await request(`${vmPath(vmId)}/ssh/access`, post({})) as { url: string; expiresAt: string } },
  async sessions(vmId: string, signal?: AbortSignal) {
    return Session.array().parse(await request(`${vmPath(vmId)}/sessions`, { signal }))
  },
  async createSession(vmId: string, input: CreateSession = {}) {
    return Session.parse(await request(`${vmPath(vmId)}/sessions`, post(input)))
  },
  terminalPath(vmId: string, sessionId: string) {
    return `${vmPath(vmId)}/sessions/${encodeURIComponent(sessionId)}/terminal`
  },
  // A WebSocket URL for a terminal. Browsers can't add a sign-in header to a
  // WebSocket, so it carries a one-time ticket instead.
  async terminalUrl(path: string) {
    const { ticket } = (await request(`${path}/ticket`, post({}))) as { ticket: string }
    const url = new URL(path, window.location.href)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('ticket', ticket)
    return url.href
  },
}

// macOS workspaces (M10). Creating one that needs a new Mac fails with a 409
// whose body is NewMacNeeded, until it's retried with confirmNewMac.
const macPath = (id: string) => `/api/macs/${encodeURIComponent(id)}`
export const macApi = {
  async list(signal?: AbortSignal) {
    return MacWorkspace.array().parse(await request('/api/macs', { signal }))
  },
  async create(input: CreateMacWorkspace) {
    return MacWorkspace.parse(await request('/api/macs', post(input)))
  },
  async remove(id: string) { await request(macPath(id), { method: 'DELETE' }) },
  async sessions(id: string, signal?: AbortSignal) {
    return Session.array().parse(await request(`${macPath(id)}/sessions`, { signal }))
  },
  async createSession(id: string) {
    return Session.parse(await request(`${macPath(id)}/sessions`, post({})))
  },
  terminalPath(id: string, sessionId: string) {
    return `${macPath(id)}/sessions/${encodeURIComponent(sessionId)}/terminal`
  },
}
