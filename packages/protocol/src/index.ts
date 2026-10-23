import { z } from 'zod'

export const Health = z.object({
  ok: z.literal(true),
  version: z.string(),
})
export type Health = z.infer<typeof Health>

// EC2 instance states, as reported by DescribeInstances.
export const InstanceState = z.enum([
  'pending',
  'running',
  'stopping',
  'stopped',
  'shutting-down',
  'terminated',
])
export type InstanceState = z.infer<typeof InstanceState>

export const HostStatus = z.discriminatedUnion('configured', [
  // Local development: the control API runs without a sandbox host.
  z.object({ configured: z.literal(false) }),
  z.object({
    configured: z.literal(true),
    instanceId: z.string(),
    instanceType: z.string(),
    state: InstanceState,
    // When the host last started, if it is running.
    launchedAt: z.string().nullable(),
  }),
])
export type HostStatus = z.infer<typeof HostStatus>

export const Status = z.object({
  control: z.object({
    version: z.string(),
    region: z.string(),
    startedAt: z.string(),
  }),
  host: HostStatus,
})
export type Status = z.infer<typeof Status>

export * from './vm.ts'
export * from './terminal.ts'
export * from './activity.ts'
export * from './github.ts'
export * from './management.ts'
export * from './mac.ts'
