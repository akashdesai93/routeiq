import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_TRIP, formatLatLng, restoreTrip, type LngLat, type Place } from './core/index.ts'
import { tokenStatus, type TokenStatus } from './config.ts'
import { DrivePanel } from './DrivePanel.tsx'
import { MapView } from './map/MapView.tsx'
import type { PinRole } from './map/pins.ts'
import { PlanPanel, type PlaceOrigin } from './PlanPanel.tsx'
import { RoutePanel } from './RoutePanel.tsx'
import { localTextStore, type TextStore } from './storage/local.ts'
import { useDriveSim } from './useDriveSim.ts'
import { usePlaceBook } from './usePlaceBook.ts'
import { useRoutes } from './useRoutes.ts'

const TOKEN_HELP: Record<Exclude<TokenStatus['kind'], 'ok'>, string> = {
  missing:
    'No Mapbox token yet. Copy .env.example to .env.local, paste your public token (starts with pk.), then restart npm run dev.',
  secret:
    'That is a secret token (sk.). Never use it in a browser app. Put a public pk. token in .env.local instead.',
  malformed: 'VITE_MAPBOX_TOKEN does not look like a Mapbox public token (it should start with pk.).',
}

type Pins = Readonly<Record<PinRole, Place>>

/** The built-in trip: what a first visit opens with, and what Reset goes back to. */
const TEST_PINS: Pins = DEFAULT_TRIP

/** Where saved places, recents and the last trip are kept: this browser's localStorage, or memory without it. */
const deviceStore = localTextStore()

/** While a simulated drive is on, the route list and the map are not for picking routes. */
const ignore = () => {}

interface AppProps {
  status?: TokenStatus
  /** Swapped out in tests for a store in memory. */
  placeStore?: TextStore
}

export default function App({ status = tokenStatus, placeStore = deviceStore }: AppProps) {
  const places = usePlaceBook(placeStore)
  // The last trip, when this device has one; otherwise the built-in trip.
  const [pins, setPins] = useState<Pins>(() =>
    places.book.lastTrip === null ? TEST_PINS : restoreTrip(places.book.lastTrip, TEST_PINS),
  )
  const token = status.kind === 'ok' ? status.token : null
  const routing = useRoutes(token, pins.origin.position, pins.destination.position)
  const selectedRoute = routing.routes.find((r) => r.id === routing.selectedId) ?? null
  // The simulated drive (PLAN step 6) starts on the selected route. Changing the trip ends it.
  const sim = useDriveSim(token, pins.destination.position, selectedRoute)
  const stopDrive = sim.stop
  const { rememberTrip, addRecent } = places

  // Keeps the trip for the next visit. The built-in trip is not kept: without a stored
  // trip the app opens with it anyway. (An origin set from the device's position is
  // left out by rememberTrip: see toStoredTrip.)
  useEffect(() => {
    rememberTrip(pins === TEST_PINS ? null : pins)
  }, [pins, rememberTrip])

  // The centre of the map, reported by MapView: search results are biased to it.
  const mapCenter = useRef<LngLat | null>(null)
  const noteCenter = useCallback((center: LngLat) => {
    mapCenter.current = center
  }, [])
  const destinationPosition = pins.destination.position
  const getProximity = useCallback(() => mapCenter.current ?? destinationPosition, [destinationPosition])

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
  const choosePlace = useCallback(
    (role: PinRole, place: Place, from: PlaceOrigin) => {
      stopDrive()
      setPins((current) => ({ ...current, [role]: place }))
      // Recents are destinations that were looked for; a saved place is one tap away already.
      if (role === 'destination' && (from === 'search' || from === 'recent')) addRecent(place)
    },
    [stopDrive, addRecent],
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
            onCenterChange={noteCenter}
          />
          <div className="side">
            <PlanPanel
              pins={pins}
              token={token}
              places={places}
              getProximity={getProximity}
              onPlace={choosePlace}
              onSwap={swap}
              onReset={reset}
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
        </div>
      ) : (
        <main className="notice" role="alert">
          {TOKEN_HELP[status.kind as Exclude<TokenStatus['kind'], 'ok'>]}
        </main>
      )}
    </div>
  )
}
