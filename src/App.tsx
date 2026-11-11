import { useCallback, useMemo, useState, type CSSProperties } from 'react'
import { DEFAULT_TRIP, formatLatLng, type LngLat, type Place } from './core/index.ts'
import { tokenStatus, type TokenStatus } from './config.ts'
import { DrivePanel } from './DrivePanel.tsx'
import { MapView } from './map/MapView.tsx'
import { PIN_COLOR, PIN_NAME, PIN_ROLES, type PinRole } from './map/pins.ts'
import { RoutePanel } from './RoutePanel.tsx'
import { useDriveSim } from './useDriveSim.ts'
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

/** While a simulated drive is on, the route list and the map are not for picking routes. */
const ignore = () => {}

export default function App({ status = tokenStatus }: { status?: TokenStatus }) {
  const [pins, setPins] = useState<Pins>(TEST_PINS)
  const token = status.kind === 'ok' ? status.token : null
  const routing = useRoutes(token, pins.origin.position, pins.destination.position)
  const selectedRoute = routing.routes.find((r) => r.id === routing.selectedId) ?? null
  // The simulated drive (PLAN step 6) starts on the selected route. Changing the trip ends it.
  const sim = useDriveSim(token, pins.destination.position, selectedRoute)
  const stopDrive = sim.stop

  const movePin = useCallback(
    (role: PinRole, position: LngLat) => {
      const dropped: Place = {
        id: `${role}-pin`,
        label: `Dropped pin (${formatLatLng(position)})`,
        position,
      }
      stopDrive()
      setPins((current) => ({ ...current, [role]: dropped }))
    },
    [stopDrive],
  )
  const swap = () => {
    stopDrive()
    setPins((p) => ({ origin: p.destination, destination: p.origin }))
  }
  const reset = () => {
    stopDrive()
    setPins(TEST_PINS)
  }

  // During a drive the list and the map show what the last check returned from the
  // car's position, with the route being driven selected; before the first check,
  // and with no drive on, they show the routes of the trip.
  const view = sim.view
  const driving = view !== null
  const polled = view !== null && view.candidates !== null ? view : null
  const car = view?.car
  const routeAhead = view?.routeAhead
  const turn = view?.turn
  const driveOverlay = useMemo(
    () => (car === undefined || routeAhead === undefined ? null : { car, routeAhead, turn: turn ?? null }),
    [car, routeAhead, turn],
  )

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
            routes={polled?.candidates ?? routing.routes}
            selectedRouteId={polled !== null ? polled.currentCandidateId : routing.selectedId}
            signals={polled !== null ? polled.signals : routing.selectedSignals}
            drive={driveOverlay}
            onPinMove={movePin}
            onSelectRoute={driving ? ignore : routing.select}
          />
          <RoutePanel
            ranked={polled !== null ? polled.ranked : routing.ranked}
            selectedId={polled !== null ? polled.currentCandidateId : routing.selectedId}
            loading={routing.loading}
            error={routing.error}
            onSelect={driving ? ignore : routing.select}
            onRetry={routing.retry}
            signalsStatus={routing.signalsStatus}
            signalsError={routing.signalsError}
            onRetrySignals={routing.retrySignals}
            signalDataDate={routing.signalDataDate}
          >
            <DrivePanel sim={sim} showWhatIf={import.meta.env.DEV} />
          </RoutePanel>
        </div>
      ) : (
        <main className="notice" role="alert">
          {TOKEN_HELP[status.kind as Exclude<TokenStatus['kind'], 'ok'>]}
        </main>
      )}
    </div>
  )
}
