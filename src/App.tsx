import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  CURRENT_LOCATION_ID,
  DEFAULT_TRIP,
  formatLatLng,
  lineFrom,
  restoreTrip,
  type LngLat,
  type Place,
  type RouteCandidate,
  type RouteSignal,
} from './core/index.ts'
import { tokenStatus, type TokenStatus } from './config.ts'
import { isNativeShell } from './device/native/index.ts'
import { DrivePanel } from './DrivePanel.tsx'
import { cruiseSpeedMps } from './drive/simulation.ts'
import { LiveDriveView } from './LiveDriveView.tsx'
import { DEFAULT_REPLAY_SETUP, replayPlanOf, type ReplaySetup } from './drive/replaySetup.ts'
import { ReplayPanel } from './ReplayPanel.tsx'
import { DEFAULT_TEST_DRIVE_SETUP, type TestDriveSetup } from './drive/testDrive.ts'
import { TestDrivePanel } from './TestDrivePanel.tsx'
import { useLiveDrive } from './useLiveDrive.ts'
import type { DriveOverlay } from './map/driveFeatures.ts'
import { MapView } from './map/LazyMapView.tsx'
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
const NO_ROUTES: readonly RouteCandidate[] = []
const NO_SIGNALS: readonly RouteSignal[] = []

interface AppProps {
  status?: TokenStatus
  /** Swapped out in tests for a store in memory. */
  placeStore?: TextStore
  /** Shown in the top bar, after the name. The iPhone shell puts its "Change token" button here. */
  barExtra?: ReactNode
  /** Shown in the drive view's More sheet. The top bar is hidden during a drive, so the iPhone shell puts "Drive diagnostics" here too. */
  driveExtra?: ReactNode
}

export default function App({ status = tokenStatus, placeStore = deviceStore, barExtra = null, driveExtra = null }: AppProps) {
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

  // The live drive: the same engine fed by the device's position. In development a
  // replayed drive can stand in for the GPS (the browser pane has none); it starts at
  // the origin pin. A live drive never moves a pin, and its position is never kept.
  const [replaySetup, setReplaySetup] = useState<ReplaySetup>(DEFAULT_REPLAY_SETUP)
  const replaySpeedMps = selectedRoute === null ? 15 : cruiseSpeedMps(selectedRoute)
  const originPosition = pins.origin.position
  const replay = useMemo(
    () =>
      import.meta.env.DEV && replaySetup.enabled
        ? { origin: originPosition, plan: replayPlanOf(replaySetup, replaySpeedMps), multiplier: replaySetup.multiplier }
        : null,
    [replaySetup, replaySpeedMps, originPosition],
  )
  // Inside the iPhone shell: a test drive, where a made-up car moved by the app's native code stands in
  // for the GPS, so reroutes and the voice can be tried at home with the phone locked.
  const inShell = isNativeShell()
  const [testDriveSetup, setTestDriveSetup] = useState<TestDriveSetup>(DEFAULT_TEST_DRIVE_SETUP)
  const testDrive = useMemo(
    () => (inShell && testDriveSetup.enabled ? { origin: originPosition, preset: testDriveSetup.preset, multiplier: testDriveSetup.multiplier } : null),
    [inShell, testDriveSetup, originPosition],
  )
  const setWhatIfDelaySec = sim.setWhatIfDelaySec
  const clearWhatIf = useCallback(() => setWhatIfDelaySec(0), [setWhatIfDelaySec])
  const live = useLiveDrive({
    token,
    destination: pins.destination.position,
    route: selectedRoute,
    rerouteOptions: sim.rerouteOptions,
    settings: sim.settings,
    whatIfDelaySec: sim.whatIfDelaySec,
    onWhatIfSpent: clearWhatIf,
    replay,
    testDrive,
  })
  const startLive = () => {
    stopDrive()
    live.start()
  }

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
  const simOverlay = useMemo(
    () => (car === undefined || routeAhead === undefined ? null : { car, routeAhead, turn: turn ?? null }),
    [car, routeAhead, turn],
  )

  // The live drive draws through the same overlay: the car where the tracker has it,
  // the rest of the route being driven, and the turn-off of a switch.
  const liveTracking = live.state.tracking
  const liveRoute = live.state.route
  const liveTurn = live.state.turn
  const liveFix = live.state.lastFix
  const liveOverlay = useMemo((): DriveOverlay | null => {
    if (liveTracking !== null && liveRoute !== null) {
      return { car: liveTracking.position, routeAhead: lineFrom(liveRoute.geometry, liveTracking.alongRouteM), turn: liveTurn }
    }
    if (liveFix !== null) return { car: [liveFix.lng, liveFix.lat], routeAhead: [], turn: null }
    return null
  }, [liveTracking, liveRoute, liveTurn, liveFix])
  const liveCar = liveOverlay?.car
  const liveHeading = liveTracking?.headingDeg ?? 0
  const liveStatus = live.state.status
  const follow = useMemo(
    () => (liveStatus === 'arrived' || liveStatus === 'failed' || liveCar === undefined ? null : { center: liveCar, bearingDeg: liveHeading }),
    [liveStatus, liveCar, liveHeading],
  )
  const liveCandidates = live.state.candidates

  return (
    <div className={live.active ? 'app live' : 'app'}>
      <header className="bar">
        <strong>RouteIQ</strong>
        {barExtra}
      </header>
      {token !== null ? (
        <div className="main">
          <MapView
            token={token}
            pins={pins}
            routes={live.active ? (liveCandidates ?? NO_ROUTES) : (polled?.candidates ?? routing.routes)}
            selectedRouteId={live.active ? null : polled !== null ? polled.currentCandidateId : routing.selectedId}
            signals={live.active ? NO_SIGNALS : polled !== null ? polled.signals : routing.selectedSignals}
            drive={live.active ? liveOverlay : simOverlay}
            follow={live.active ? follow : null}
            onPinMove={movePin}
            onSelectRoute={driving || live.active ? ignore : routing.select}
            onCenterChange={noteCenter}
          />
          {/* A test drive (the iPhone shell): the positions are made up, and the screen says so for as long as it runs. */}
          {live.active && live.simulated && <span className="sim-badge">SIMULATED GPS</span>}
          {live.active && (
            <LiveDriveView
              state={live.state}
              view={live.view}
              destinationLabel={pins.destination.label}
              speechSupported={live.speechSupported}
              replaying={live.replaying}
              extra={driveExtra}
              dev={
                import.meta.env.DEV
                  ? {
                      multiplier: replaySetup.multiplier,
                      setMultiplier: (multiplier) => setReplaySetup((s) => ({ ...s, multiplier })),
                      whatIfDelaySec: sim.whatIfDelaySec,
                      setWhatIfDelaySec: sim.setWhatIfDelaySec,
                    }
                  : null
              }
              onKeepPrevious={live.keepPrevious}
              onMute={live.setMuted}
              onEnd={live.end}
              onRestart={startLive}
            />
          )}
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
            onKeepSelection={driving ? ignore : routing.keepSelection}
            sideStreetNotice={polled !== null ? null : routing.sideStreetNotice}
            countingRouteIds={polled !== null ? undefined : routing.countingRouteIds}
            onRetry={routing.retry}
            signalsStatus={routing.signalsStatus}
            signalsError={routing.signalsError}
            onRetrySignals={routing.retrySignals}
            signalDataDate={routing.signalDataDate}
            onStartDrive={startLive}
            canStartDrive={live.canStart && !routing.tokenRejected}
            originIsDeviceLocation={pins.origin.id === CURRENT_LOCATION_ID}
            startDriveExtra={
              import.meta.env.DEV || inShell ? (
                <>
                  {import.meta.env.DEV && <ReplayPanel setup={replaySetup} onChange={setReplaySetup} />}
                  {inShell && <TestDrivePanel setup={testDriveSetup} onChange={setTestDriveSetup} />}
                </>
              ) : null
            }
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
