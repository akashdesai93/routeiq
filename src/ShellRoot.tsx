import { useState, type FormEvent } from 'react'
import App from './App.tsx'
import { tokenStatus, type TokenStatus } from './config.ts'
import { isNativeShell } from './device/native/index.ts'
import { DriveDiagnosticsPanel } from './DriveDiagnosticsPanel.tsx'
import { readShellToken, saveShellToken, SHELL_TOKEN_PROBLEM } from './shellToken.ts'
import { localTextStore, type TextStore } from './storage/local.ts'

interface TokenScreenProps {
  /** A token is already stored: this is "Change token", and it can be cancelled. */
  replacing: boolean
  onSave: (raw: string) => string | null
  onCancel: () => void
}

/** The shell's "paste your token" screen. Shown once, and again from "Change token". */
export function ShellTokenScreen({ replacing, onSave, onCancel }: TokenScreenProps) {
  const [value, setValue] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    setProblem(onSave(value))
  }
  return (
    <div className="app">
      <header className="bar">
        <strong>RouteIQ</strong>
      </header>
      <main className="notice token-screen">
        <form onSubmit={submit}>
          <label htmlFor="shell-token">
            <strong>Paste your Mapbox public token</strong>
          </label>
          <p>
            It starts with <code>pk.</code> and is kept on this phone only. Use a token without URL restrictions: a restricted one
            does not work inside the app.
          </p>
          <input
            id="shell-token"
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="pk…"
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
          />
          {problem !== null && <p role="alert">{problem}</p>}
          <p className="token-actions">
            <button type="submit">Save token</button>
            {replacing && (
              <button type="button" onClick={onCancel}>
                Cancel
              </button>
            )}
          </p>
        </form>
      </main>
    </div>
  )
}

/** The app inside the iPhone shell, on the token kept on the phone. */
export function ShellApp({ store }: { store: TextStore }) {
  const [status, setStatus] = useState<TokenStatus>(() => readShellToken(store))
  const [changing, setChanging] = useState(false)
  const [diagnostics, setDiagnostics] = useState(false)
  if (status.kind !== 'ok' || changing) {
    return (
      <ShellTokenScreen
        replacing={status.kind === 'ok'}
        onCancel={() => setChanging(false)}
        onSave={(raw) => {
          const saved = saveShellToken(store, raw)
          if (!saved.ok) return SHELL_TOKEN_PROBLEM[saved.kind]
          setStatus({ kind: 'ok', token: saved.token })
          setChanging(false)
          return null
        }}
      />
    )
  }
  const diagnosticsButton = (
    <button type="button" aria-expanded={diagnostics} onClick={() => setDiagnostics((open) => !open)}>
      Drive diagnostics
    </button>
  )
  // A new token is a new app: nothing made with the old one is kept on screen.
  return (
    <>
      <App
        key={status.token}
        status={status}
        driveExtra={diagnosticsButton}
        barExtra={
          <span className="shell-actions">
            {diagnosticsButton}
            <button type="button" className="change-token" onClick={() => setChanging(true)}>
              Change token
            </button>
          </span>
        }
      />
      {/* Beside the app, not in place of it: opening it must not end a drive. */}
      {diagnostics && <DriveDiagnosticsPanel store={store} onClose={() => setDiagnostics(false)} />}
    </>
  )
}

interface RootProps {
  /** The token built in from .env.local, if any. */
  buildStatus?: TokenStatus
  shell?: boolean
  store?: TextStore
}

/**
 * Picks where the Mapbox token comes from. A built-in token (the web app,
 * VITE_MAPBOX_TOKEN) is used as before, in a browser and in the shell alike.
 * Only the shell without one asks for a token on the device.
 */
export function Root({ buildStatus = tokenStatus, shell = isNativeShell(), store }: RootProps) {
  if (buildStatus.kind === 'ok' || !shell) return <App status={buildStatus} />
  return <ShellApp store={store ?? localTextStore()} />
}
