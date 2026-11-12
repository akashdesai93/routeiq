import { useMemo, type ReactNode } from 'react'
import {
  delayVsTypicalSec,
  formatDelay,
  formatDataMonth,
  formatDistance,
  formatDuration,
  formatSignalCount,
  GOOGLE_MAPS_MAX_WAYPOINTS,
  GOOGLE_MAPS_MAX_WAYPOINTS_MOBILE,
  googleMapsUrl,
  handoffWaypoints,
  routeDelta,
  signalCountNote,
  wazeUrl,
  type RankedRoute,
  type RouteCandidate,
  type RouteDelta,
} from './core/index.ts'
import { Figure } from './Figure.tsx'
import type { SignalsStatus } from './useRoutes.ts'

interface RoutePanelProps {
  /** Routes in rank order, best first (see rankRoutes in src/core/rank.ts). */
  ranked: readonly RankedRoute[]
  selectedId: string | null
  loading: boolean
  error: string | null
  onSelect: (id: string) => void
  /**
   * The user's pointer or focus is on the route list or Start drive: the
   * selection should stay put from here on (see RoutesState.keepSelection).
   */
  onKeepSelection?: () => void
  /** A polite announcement that a side street is now recommended; null or left out for none. */
  sideStreetNotice?: string | null
  /** Routes whose signal count is still loading while the others show theirs. */
  countingRouteIds?: ReadonlySet<string>
  onRetry: () => void
  signalsStatus: SignalsStatus
  /** What signal data is missing; null when none is. */
  signalsError: string | null
  onRetrySignals: () => void
  /** How old the OpenStreetMap signal data is, in milliseconds since 1970. Null or left out when unknown. */
  signalDataDate?: number | null
  /** Starts a live drive to the destination, from the device's position. Left out: no button. */
  onStartDrive?: () => void
  /** False while a live drive cannot start (no token). */
  canStartDrive?: boolean
  /**
   * True when the trip's origin is the device's own position ("Use my location").
   * The Google Maps link then leaves the origin out, so Google starts from its own
   * reading of the device's position and RouteIQ sends the location to no one.
   */
  originIsDeviceLocation?: boolean
  /** Shown under the Start drive button: the development replay controls. */
  startDriveExtra?: ReactNode
  /** Shown under the route list: the simulated drive controls. */
  children?: ReactNode
}

/**
 * Hover text for the signal count: what a count that is not whole means, and
 * the provider's own count. This is the only place the provider's count
 * appears: it is a cross-check, not a second answer.
 */
function signalHoverText(route: RouteCandidate): string | undefined {
  const lines: string[] = []
  const note = signalCountNote(route.signalCount, route.signalCoverage)
  if (note !== null) lines.push(note)
  if (route.providerSignalCount !== null) {
    lines.push(`Cross-check: Mapbox flags ${route.providerSignalCount} signalized intersections on this route.`)
  }
  return lines.length > 0 ? lines.join(' ') : undefined
}

/**
 * Google Maps takes 3 waypoints in a mobile browser and 9 elsewhere. The app
 * hands off to the phone's Maps app, so anything that looks like a phone or
 * tablet gets the mobile limit.
 */
function isMobileBrowser(): boolean {
  if (typeof navigator === 'undefined') return false
  const hinted = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData?.mobile
  if (hinted !== undefined) return hinted
  // iPadOS Safari reports a Mac user agent; a Mac with touch is an iPad.
  const iPad = /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1
  return iPad || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
}

/** Links that open the selected route in Google Maps (pinned by waypoints) and Waze (destination only). */
function HandoffLinks({
  route,
  alternatives,
  fromDevice,
}: {
  route: RouteCandidate
  alternatives: readonly RouteCandidate[]
  fromDevice: boolean
}) {
  const links = useMemo(() => {
    const origin = route.geometry[0]
    const destination = route.geometry.at(-1)
    if (origin === undefined || destination === undefined) return null
    const maxWaypoints = isMobileBrowser() ? GOOGLE_MAPS_MAX_WAYPOINTS_MOBILE : GOOGLE_MAPS_MAX_WAYPOINTS
    const waypoints = handoffWaypoints(route, alternatives, { maxWaypoints })
    return { google: googleMapsUrl(fromDevice ? null : origin, destination, waypoints), waze: wazeUrl(destination) }
  }, [route, alternatives, fromDevice])
  if (links === null) return null
  return (
    <p className="handoff">
      <a href={links.google} target="_blank" rel="noopener">
        Open in Google Maps
      </a>
      {' · '}
      <a href={links.waze} target="_blank" rel="noopener">
        Open in Waze
      </a>
    </p>
  )
}

/**
 * The delta row under the route list (#21, #44): what the recommended route
 * gives against the next one, "−8 min · −2 lights · −3 mi". The words come
 * from core (routeDelta); lights it cannot compare say so, never 0.
 */
function DeltaRow({ delta, against }: { delta: RouteDelta; against: number }) {
  return (
    <div className="route-delta" role="group" aria-label={`Route 1 against Route ${against}`}>
      <span className="route-delta-cell" data-delta="time">
        {delta.time.figure}
        <span className="unit"> {delta.time.unit}</span>
      </span>
      <span className="route-delta-cell" data-delta="lights">
        {delta.lights === null ? (
          <span className="route-delta-words">Lights: can't compare</span>
        ) : (
          <>
            {delta.lights.figure}
            <span className="unit"> {delta.lights.unit}</span>
          </>
        )}
      </span>
      <span className="route-delta-cell" data-delta="distance">
        {delta.distance.figure}
        <span className="unit"> {delta.distance.unit}</span>
      </span>
    </div>
  )
}

/**
 * Lists the routes in rank order with each one's facts and the reason for its
 * place. Presentation only: the numbers, the order and the wording of the
 * reasons come from src/core. Highlighting follows the selection, not the rank.
 */
export function RoutePanel({
  ranked,
  selectedId,
  loading,
  error,
  onSelect,
  onKeepSelection,
  sideStreetNotice = null,
  countingRouteIds,
  onRetry,
  signalsStatus,
  signalsError,
  onRetrySignals,
  signalDataDate = null,
  onStartDrive,
  canStartDrive = true,
  originIsDeviceLocation = false,
  startDriveExtra,
  children,
}: RoutePanelProps) {
  const dataMonth = formatDataMonth(signalDataDate)
  const candidates = useMemo(() => ranked.map((r) => r.route), [ranked])
  const delta = useMemo(() => (ranked.length < 2 ? null : routeDelta(ranked[0]!.route, ranked[1]!.route)), [ranked])
  return (
    <aside className="panel" aria-label="Routes">
      <h2>Routes</h2>
      {loading && <p role="status">Finding routes…</p>}
      {error && (
        <div className="notice" role="alert">
          <p>{error}</p>
          <button type="button" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
      {/* Always in the page, so a screen reader hears the line when it appears. */}
      <p className="hint side-street-notice" role="status" aria-live="polite">
        {sideStreetNotice}
      </p>
      <ol className="routes" onPointerEnter={onKeepSelection} onFocus={onKeepSelection}>
        {ranked.map(({ route, rank, reasons }) => {
          const counting = signalsStatus === 'loading' || countingRouteIds?.has(route.id) === true
          const note = signalCountNote(route.signalCount, route.signalCoverage)
          return (
          <li key={route.id}>
            <button
              type="button"
              className={route.id === selectedId ? 'route selected' : 'route'}
              aria-pressed={route.id === selectedId}
              onClick={() => onSelect(route.id)}
            >
              {/* Read in this order ("Route 1 Recommended via side streets, 35 min, ..."); laid out with the time leading. */}
              <span className="route-name">
                {`Route ${rank}`}
                {rank === 1 && <span className="route-badge"> Recommended</span>}
                {route.source === 'probe' && ' '}
                {route.source === 'probe' && (
                  <span className="route-source" title="Found by asking for the trip through a point beside the fastest route; Mapbox did not offer it among its own routes.">
                    via side streets
                  </span>
                )}
              </span>
              <span className="route-eta">
                <Figure text={formatDuration(route.durationSec)} unitClass="unit" />
              </span>
              <span className="route-facts">
                <span className="route-distance">{formatDistance(route.distanceM)}</span>{' '}
                <span
                  className="route-signals"
                  data-coverage={counting ? 'counting' : route.signalCoverage}
                  title={counting ? undefined : signalHoverText(route)}
                >
                  {counting
                    ? 'Counting signals…'
                    : formatSignalCount(route.signalCount, route.signalCoverage)}
                </span>
              </span>
              {!counting && note !== null && <span className="route-signal-note">{note}</span>}
              <span className="route-delay">{formatDelay(delayVsTypicalSec(route))}</span>
              <span className="route-reasons">{reasons.join(' · ')}</span>
            </button>
            {route.id === selectedId && <HandoffLinks route={route} alternatives={candidates} fromDevice={originIsDeviceLocation} />}
          </li>
          )
        })}
      </ol>
      {delta !== null && <DeltaRow delta={delta} against={2} />}
      {onStartDrive !== undefined && (
        <div className="start-drive">
          <p className="hint start-drive-note">
            Switches by itself if a faster route holds up, and says so out loud. Works while this page stays in front
            with the screen on. Your location is not stored.
          </p>
          <button
            type="button"
            className="start-drive-button"
            onClick={onStartDrive}
            onPointerEnter={onKeepSelection}
            onFocus={onKeepSelection}
            disabled={!canStartDrive}
          >
            Start drive
          </button>
          {startDriveExtra}
        </div>
      )}
      {children}
      {!loading && !error && ranked.length > 0 && (
        <p className="hint">Times include live traffic. Search for a place or drag a pin to change the trip.</p>
      )}
      {ranked.length > 0 && signalsStatus !== 'loading' && (
        <p className="hint">
          Signals are the signalized intersections on a route; dots mark them on the selected one. Signal
          data: OpenStreetMap{dataMonth === null ? '' : `, ${dataMonth}`} (
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
            © OpenStreetMap contributors
          </a>
          ).
        </p>
      )}
      {signalsStatus === 'partial' && (
        <p className="hint" role="status">
          {signalsError ?? 'Some signal data could not be loaded.'}{' '}
          <button type="button" className="link" onClick={onRetrySignals}>
            Retry signals
          </button>
        </p>
      )}
    </aside>
  )
}
