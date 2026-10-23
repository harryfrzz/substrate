import type { HostStatus, InstanceState, Status } from '@substrate/protocol'
import type { ReactNode } from 'react'
import { useStatus } from './useStatus.ts'
import { MacPanel } from './workspaces/MacPanel.tsx'
import { WorkspacePanel } from './workspaces/WorkspacePanel.tsx'

const stateStyle: Record<InstanceState, { dot: string; label: string }> = {
  running: { dot: 'bg-emerald-500', label: 'Running' },
  pending: { dot: 'bg-amber-400 animate-pulse', label: 'Starting' },
  stopping: { dot: 'bg-amber-400 animate-pulse', label: 'Stopping' },
  stopped: { dot: 'bg-zinc-400', label: 'Stopped' },
  'shutting-down': { dot: 'bg-red-500 animate-pulse', label: 'Shutting down' },
  terminated: { dot: 'bg-red-500', label: 'Terminated' },
}

// `account` is the signed-in user's menu, when sign-in is on.
export function App({ account }: { account?: ReactNode }) {
  const state = useStatus()
  const status = state.kind === 'ok' ? state.status : state.kind === 'error' ? state.last : null

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col gap-6 px-4 pt-[max(2rem,env(safe-area-inset-top))] pb-10">
      <header className="flex items-center gap-3">
        <img src="/favicon.svg" alt="" className="size-9" />
        <div className="flex-1">
          <h1 className="text-lg font-semibold tracking-tight">Substrate</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Persistent sandboxes for coding agents
          </p>
        </div>
        {account}
      </header>

      <WorkspacePanel />
      <MacPanel />

      {state.kind === 'error' && (
        <p
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          Can't reach the control API: {state.message}
        </p>
      )}

      {status ? (
        <>
          <HostCard host={status.host} />
          <ControlCard control={status.control} />
        </>
      ) : (
        state.kind === 'loading' && <p className="text-sm text-zinc-500">Loading…</p>
      )}

      {state.kind === 'ok' && (
        <p className="text-center text-xs text-zinc-400 dark:text-zinc-500">
          Updated {state.at.toLocaleTimeString()} · refreshes every 10 s
        </p>
      )}
    </main>
  )
}

function HostCard({ host }: { host: HostStatus }) {
  if (!host.configured) {
    return (
      <Card title="Sandbox host">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          No host configured. This is normal in local development.
        </p>
      </Card>
    )
  }
  const style = stateStyle[host.state]
  return (
    <Card
      title="Sandbox host"
      badge={
        <span className="flex items-center gap-2 text-sm font-medium">
          <span className={`size-2.5 rounded-full ${style.dot}`} />
          {style.label}
        </span>
      }
    >
      <Rows
        rows={[
          ['Instance', host.instanceType],
          ['ID', host.instanceId],
          ['Up since', host.launchedAt ? new Date(host.launchedAt).toLocaleString() : '—'],
        ]}
      />
    </Card>
  )
}

function ControlCard({ control }: { control: Status['control'] }) {
  return (
    <Card
      title="Control box"
      badge={
        <span className="flex items-center gap-2 text-sm font-medium">
          <span className="size-2.5 rounded-full bg-emerald-500" />
          Online
        </span>
      }
    >
      <Rows
        rows={[
          ['Version', control.version],
          ['Region', control.region],
          ['Started', new Date(control.startedAt).toLocaleString()],
        ]}
      />
    </Card>
  )
}

function Card({ title, badge, children }: { title: string; badge?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-4 shadow-xs dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="font-medium">{title}</h2>
        {badge}
      </div>
      {children}
    </section>
  )
}

function Rows({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-zinc-500 dark:text-zinc-400">{k}</dt>
          <dd className="truncate text-right font-mono text-[13px]">{v}</dd>
        </div>
      ))}
    </dl>
  )
}
