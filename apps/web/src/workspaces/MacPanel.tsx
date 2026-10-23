import { useEffect, useState, type FormEvent } from 'react'
import { NewMacNeeded, VmName, type MacWorkspace, type MacWorkspaceState, type Session } from '@substrate/protocol'
import { macApi, WorkspaceApiError } from './api.ts'
import { TerminalView } from './TerminalView.tsx'
import './workspaces.css'

const stateLabels: Record<MacWorkspaceState, string> = {
  waiting: 'waiting for its Mac', creating: 'creating', running: 'running', failed: 'failed', deleting: 'deleting',
}
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Try again.'
const usd = (n: number) => `$${n.toFixed(2)}`

// macOS workspaces (M10): macOS VMs, two to a Mac. Hidden when the server
// doesn't have them set up.
export function MacPanel() {
  const [workspaces, setWorkspaces] = useState<MacWorkspace[]>([])
  const [available, setAvailable] = useState<boolean | null>(null)
  const [error, setError] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const selectedWorkspace = workspaces.find((w) => w.id === selected)

  useEffect(() => {
    const controller = new AbortController()
    const load = async () => {
      try {
        const next = await macApi.list(controller.signal)
        if (controller.signal.aborted) return
        setWorkspaces(next)
        setAvailable(true)
        setError('')
      } catch (error) {
        if (controller.signal.aborted) return
        if (error instanceof WorkspaceApiError && (error.status === 503 || error.status === 401 || error.status === 404)) setAvailable(false)
        else setError(errorMessage(error))
      }
    }
    void load()
    const timer = setInterval(load, 5_000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [refresh])

  if (!available) return null
  return (
    <section className="workspaces" aria-labelledby="macs-title">
      <div className="workspace-heading">
        <div>
          <h2 id="macs-title">macOS workspaces</h2>
          <p>A macOS VM on a dedicated Mac, for Xcode and anything else Apple-only.</p>
        </div>
        <button className="workspace-button" type="button" aria-expanded={showCreate} onClick={() => setShowCreate((v) => !v)}>
          {showCreate ? 'Cancel' : 'New macOS workspace'}
        </button>
      </div>

      {showCreate && <CreateMacWorkspace onCreated={(workspace) => {
        setWorkspaces((prev) => [...prev.filter((w) => w.id !== workspace.id), workspace])
        setShowCreate(false)
        setSelected(workspace.id)
        setRefresh((n) => n + 1)
      }} />}

      {error && <div className="workspace-error" role="alert">
        <p>Couldn’t refresh macOS workspaces. {error}</p>
        <button type="button" className="workspace-button secondary" onClick={() => setRefresh((n) => n + 1)}>Try again</button>
      </div>}

      {workspaces.length > 0 && (
        <ul className="workspace-list" aria-label="macOS workspaces">
          {workspaces.map((w) => (
            <li key={w.id}>
              <button type="button" className={`workspace-row ${selected === w.id ? 'is-selected' : ''}`} aria-pressed={selected === w.id} onClick={() => setSelected(w.id)}>
                <span className="workspace-row-title"><span className={`status-dot ${w.state === 'running' ? 'is-running' : ''}`} /><strong>{w.name}</strong></span>
                <span className="workspace-row-meta">macOS<span className="workspace-vm-state">{stateLabels[w.state]}</span></span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {selectedWorkspace && <MacSessions key={selectedWorkspace.id} workspace={selectedWorkspace} onDeleted={() => {
        setWorkspaces((prev) => prev.filter((w) => w.id !== selectedWorkspace.id))
        setSelected(null)
      }} />}
    </section>
  )
}

function CreateMacWorkspace({ onCreated }: { onCreated: (workspace: MacWorkspace) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Set when the workspace needs a new Mac: its cost, to say yes to first.
  const [needsMac, setNeedsMac] = useState<{ name: string; cost: NewMacNeeded } | null>(null)

  const create = async (name: string, confirmNewMac: boolean) => {
    setBusy(true)
    setError('')
    try {
      onCreated(await macApi.create({ name, confirmNewMac }))
    } catch (error) {
      const cost = error instanceof WorkspaceApiError ? NewMacNeeded.safeParse(error.body) : null
      if (cost?.success) setNeedsMac({ name, cost: cost.data })
      else setError(errorMessage(error))
      setBusy(false)
    }
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return
    const name = String(new FormData(event.currentTarget).get('name') ?? '').trim()
    if (!VmName.safeParse(name).success) { setError('Use lowercase letters, digits and dashes, starting with a letter or digit.'); return }
    void create(name, false)
  }

  if (needsMac) {
    const { hourlyUsd, minimumHours } = needsMac.cost
    return (
      <div className="workspace-form" role="alertdialog" aria-labelledby="new-mac-title" aria-describedby="new-mac-cost">
        <h3 id="new-mac-title">This needs a new Mac</h3>
        <p id="new-mac-cost" className="workspace-hint">
          Every Mac is full, so this starts another one. AWS bills a Mac for {minimumHours} hours at least:
          about <strong>{usd(hourlyUsd * minimumHours)}</strong> ({usd(hourlyUsd)} an hour), even if you delete the workspace sooner.
          It takes 15 to 30 minutes to be ready.
        </p>
        {error && <p role="alert" className="workspace-error">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <button className="workspace-button" type="button" disabled={busy} onClick={() => void create(needsMac.name, true)}>{busy ? 'Starting a Mac…' : 'Start a new Mac'}</button>
          <button className="workspace-button secondary" type="button" disabled={busy} onClick={() => setNeedsMac(null)}>Back</button>
        </div>
      </div>
    )
  }
  return (
    <form className="workspace-form" onSubmit={submit} aria-label="Create macOS workspace" aria-busy={busy}>
      <fieldset disabled={busy}>
        <label className="workspace-field">Workspace name<input name="name" required maxLength={31} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="e.g. ios-app" /></label>
        <p className="workspace-hint">macOS Sequoia with Homebrew and Claude Code, 4 cores and 6 GB.</p>
        {error && <p role="alert" className="workspace-error">{error}</p>}
        <button className="workspace-button" type="submit">{busy ? 'Creating…' : 'Create macOS workspace'}</button>
      </fieldset>
    </form>
  )
}

function MacSessions({ workspace, onDeleted }: { workspace: MacWorkspace; onDeleted: () => void }) {
  const [sessions, setSessions] = useState<Session[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [busy, setBusy] = useState<'session' | 'delete' | null>(null)
  const [error, setError] = useState('')
  const selected = sessions.find((s) => s.id === active)
  const running = workspace.state === 'running'

  useEffect(() => {
    if (!running) return
    const controller = new AbortController()
    const load = async () => {
      try {
        const list = await macApi.sessions(workspace.id, controller.signal)
        if (controller.signal.aborted) return
        setSessions(list)
        setError('')
        setActive((previous) => previous && list.some((s) => s.id === previous) ? previous : list[0]?.id ?? null)
      } catch (error) {
        if (!controller.signal.aborted) setError(errorMessage(error))
      }
    }
    void load()
    const timer = setInterval(load, 5_000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [workspace.id, running])

  const newTerminal = async () => {
    setBusy('session')
    setError('')
    try {
      const session = await macApi.createSession(workspace.id)
      setSessions((previous) => [...previous.filter((s) => s.id !== session.id), session])
      setActive(session.id)
    } catch (error) { setError(errorMessage(error)) }
    finally { setBusy(null) }
  }

  const remove = async () => {
    if (!confirm(`Delete ${workspace.name}? Everything in it is lost.`)) return
    setBusy('delete')
    setError('')
    try {
      await macApi.remove(workspace.id)
      onDeleted()
    } catch (error) { setError(errorMessage(error)); setBusy(null) }
  }

  return (
    <section className="workspace-sessions" aria-label={`${workspace.name} terminals`}>
      <div className="workspace-heading">
        <h3>{workspace.name}</h3>
        <div className="flex flex-wrap justify-end gap-2">
          <button className="workspace-button secondary" type="button" disabled={!!busy || !running} onClick={newTerminal}>{busy === 'session' ? 'Opening…' : 'New terminal'}</button>
          <button className="workspace-button secondary" type="button" disabled={!!busy || workspace.state === 'deleting'} onClick={remove}>{busy === 'delete' ? 'Deleting…' : 'Delete'}</button>
        </div>
      </div>
      {!running ? <p className="workspace-hint">{
        workspace.state === 'waiting' ? 'Waiting for its Mac to start. A new Mac takes 15 to 30 minutes.'
          : workspace.state === 'creating' ? 'Creating the macOS VM. This takes a few minutes.'
          : workspace.state === 'deleting' ? 'Deleting…'
          : `This workspace failed${workspace.error ? `: ${workspace.error}` : '.'} Delete it and create another.`
      }</p> : sessions.length === 0 && !error ? <p className="workspace-hint">Open a terminal to get started.</p> : null}
      {error && <p role="alert" className="workspace-error">{error}</p>}
      {sessions.length > 0 && <div className="session-picker" role="group" aria-label="Select terminal">
        {sessions.map((session, i) => <button type="button" key={session.id} aria-pressed={session.id === active} onClick={() => setActive(session.id)}>Terminal {i + 1}{session.state === 'exited' ? ' · ended' : ''}</button>)}
      </div>}
      {selected && running && <TerminalView key={selected.id} path={macApi.terminalPath(workspace.id, selected.id)} title={`Terminal ${sessions.indexOf(selected) + 1}`} />}
      {selected && running && <p className="workspace-hint">Closing this tab leaves the terminal running.</p>}
    </section>
  )
}
