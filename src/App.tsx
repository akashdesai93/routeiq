import { useCallback, useState, type CSSProperties } from 'react'
import { DEFAULT_TRIP, formatLatLng, type LngLat, type Place } from './core/index.ts'
import { tokenStatus, type TokenStatus } from './config.ts'
import { MapView } from './map/MapView.tsx'
import { PIN_COLOR, PIN_NAME, PIN_ROLES, type PinRole } from './map/pins.ts'
import { RoutePanel } from './RoutePanel.tsx'
import { useRoutes } from './useRoutes.ts'

const TOKEN_HELP: Record<Exclude<TokenStatus['kind'], 'ok'>, string> = {
  missing:
    'No Mapbox token yet. Copy .env.example to .env.local, paste your public token (starts with pk.), then restart npm run dev.',
  secret:
    'That is a secret token (sk.). Never use it in a browser app. Put a public pk. token in .env.local instead.',
  malformed: 'VITE_MAPBOX_TOKEN does not look like a Mapbox public token (it should start with pk.).',
}

type Pins = Readonly<Record<PinRole, Place>>

const TEST_PINS: Pins = DEFAULT_TRIP

export default function App({ status = tokenStatus }: { status?: TokenStatus }) {
  const [pins, setPins] = useState<Pins>(TEST_PINS)
  const token = status.kind === 'ok' ? status.token : null
  const routing = useRoutes(token, pins.origin.position, pins.destination.position)

  const movePin = useCallback((role: PinRole, position: LngLat) => {
    const dropped: Place = {
      id: `${role}-pin`,
      label: `Dropped pin (${formatLatLng(position)})`,
      position,
    }
    setPins((current) => ({ ...current, [role]: dropped }))
  }, [])
  const swap = () => setPins((p) => ({ origin: p.destination, destination: p.origin }))
  const reset = () => setPins(TEST_PINS)

  return (
    <div className="app">
      <header className="bar">
        <strong>RouteIQ</strong>
        <span className="legend">
          {PIN_ROLES.map((role) => (
            <span key={role} className="dot" style={{ '--pin': PIN_COLOR[role] } as CSSProperties}>
              {PIN_NAME[role]}: {pins[role].label}
            </span>
          ))}
        </span>
        {token !== null && (
          <span className="actions">
            <button type="button" onClick={swap}>
              Swap
            </button>
            <button type="button" onClick={reset}>
              Reset to test points
            </button>
          </span>
        )}
      </header>
      {token !== null ? (
        <div className="main">
          <MapView
            token={token}
            pins={pins}
            routes={routing.routes}
            selectedRouteId={routing.selectedId}
            signals={routing.selectedSignals}
            onPinMove={movePin}
            onSelectRoute={routing.select}
          />
          <RoutePanel
            ranked={routing.ranked}
            selectedId={routing.selectedId}
            loading={routing.loading}
            error={routing.error}
            onSelect={routing.select}
            onRetry={routing.retry}
            signalsStatus={routing.signalsStatus}
            signalsError={routing.signalsError}
            onRetrySignals={routing.retrySignals}
            signalDataDate={routing.signalDataDate}
          />
        </div>
      ) : (
        <main className="notice" role="alert">
          {TOKEN_HELP[status.kind as Exclude<TokenStatus['kind'], 'ok'>]}
        </main>
      )}
    </div>
  )
}
