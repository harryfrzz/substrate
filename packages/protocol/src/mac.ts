import { z } from 'zod'
import { VmName } from './vm.ts'

// macOS workspaces (M10): macOS VMs on EC2 Mac hosts, at most two per Mac
// (Apple's licence). The control box keeps the pool of Macs; an agent on each
// one (macd) runs its VMs with tart.

export const MacWorkspaceState = z.enum(['waiting', 'creating', 'running', 'failed', 'deleting'])
export type MacWorkspaceState = z.infer<typeof MacWorkspaceState>

export const MacWorkspace = z.object({
  id: z.string(),
  name: z.string(),
  // waiting: for its Mac to boot, which takes 15 minutes or more for a new one.
  state: MacWorkspaceState,
  createdAt: z.string(),
  error: z.string().nullable(),
})
export type MacWorkspace = z.infer<typeof MacWorkspace>

export const CreateMacWorkspace = z.object({
  name: VmName,
  // A new Mac costs at least a day, so creating one needs saying yes to that.
  confirmNewMac: z.boolean().optional(),
})
export type CreateMacWorkspace = z.infer<typeof CreateMacWorkspace>

// Instead of a workspace: why creating one needs confirming first.
export const NewMacNeeded = z.object({
  needsNewMac: z.literal(true),
  hourlyUsd: z.number(),
  minimumHours: z.number(),
})
export type NewMacNeeded = z.infer<typeof NewMacNeeded>

// ── control box ↔ macd, as JSON text frames on the agent's WebSocket ──

const Hello = z.object({
  type: z.literal('hello'),
  version: z.string(),
  // The workspaces macd has VMs for, so the control box can reconcile.
  vms: z.string().array(),
})
const Response = z.object({
  type: z.literal('response'),
  id: z.number().int(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
})
export const AgentMessage = z.discriminatedUnion('type', [Hello, Response])
export type AgentMessage = z.infer<typeof AgentMessage>

export const AgentRequest = z.discriminatedUnion('method', [
  z.object({ method: z.literal('createVm'), params: z.object({ vmId: z.string() }) }),
  z.object({ method: z.literal('deleteVm'), params: z.object({ vmId: z.string() }) }),
  z.object({ method: z.literal('sessions'), params: z.object({ vmId: z.string() }) }),
  z.object({ method: z.literal('createSession'), params: z.object({ vmId: z.string() }) }),
  // Dial the control box back at /api/macs/agent/streams/:streamId and attach
  // that WebSocket to a terminal session, speaking the usual terminal protocol.
  z.object({ method: z.literal('openStream'), params: z.object({ vmId: z.string(), sessionId: z.string(), streamId: z.string() }) }),
])
export type AgentRequest = z.infer<typeof AgentRequest>

export const ControlMessage = z.object({ type: z.literal('request'), id: z.number().int() }).and(AgentRequest)
export type ControlMessage = z.infer<typeof ControlMessage>

// A Mac runs at most this many macOS VMs at once (Apple's licence).
export const VMS_PER_MAC = 2
