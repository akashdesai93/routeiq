import type { ReactNode } from 'react'
import {
  delayVsTypicalSec,
  formatDelay,
  formatDataMonth,
  formatDistance,
  formatDuration,
  formatSignalCount,
  signalCountNote,
  type RankedRoute,
  type RouteCandidate,
} from './core/index.ts'
import type { SignalsStatus } from './useRoutes.ts'

interface RoutePanelProps {
  /** Routes in rank order, best first (see rankRoutes in src/core/rank.ts). */
  ranked: readonly RankedRoute[]
  selectedId: string | null
  loading: boolean
  error: string | null
  onSelect: (id: string) => void
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
  onRetry,
  signalsStatus,
  signalsError,
  onRetrySignals,
  signalDataDate = null,
  onStartDrive,
  canStartDrive = true,
  startDriveExtra,
  children,
}: RoutePanelProps) {
  const dataMonth = formatDataMonth(signalDataDate)
  return (
    <aside className="panel" aria-label="Routes">
      <h2>Routes</h2>
      {onStartDrive !== undefined && (
        <div className="start-drive">
          <button type="button" className="start-drive-button" onClick={onStartDrive} disabled={!canStartDrive}>
            Start drive
          </button>
          <p className="hint">
            Follows your location to the destination, checks for faster routes as you go and switches by itself, out
            loud. Works while this page stays in front with the screen on. Your location is not stored.
          </p>
          {startDriveExtra}
        </div>
      )}
      {loading && <p role="status">Finding routes…</p>}
      {error && (
        <div className="notice" role="alert">
          <p>{error}</p>
          <button type="button" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
      <ol className="routes">
        {ranked.map(({ route, rank, reasons }) => (
          <li key={route.id}>
            <button
              type="button"
              className={route.id === selectedId ? 'route selected' : 'route'}
              aria-pressed={route.id === selectedId}
              onClick={() => onSelect(route.id)}
            >
              <span className="route-name">
                {`Route ${rank}`}
                {rank === 1 && <span className="route-badge"> Recommended</span>}
              </span>
              <span className="route-eta">{formatDuration(route.durationSec)}</span>
              <span className="route-distance">{formatDistance(route.distanceM)}</span>
              <span className="route-signals" title={signalsStatus === 'loading' ? undefined : signalHoverText(route)}>
                {signalsStatus === 'loading'
                  ? 'Counting signals…'
                  : formatSignalCount(route.signalCount, route.signalCoverage)}
              </span>
              <span className="route-delay">{formatDelay(delayVsTypicalSec(route))}</span>
              <span className="route-reasons">{reasons.join(' · ')}</span>
            </button>
          </li>
        ))}
      </ol>
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
          ). Inside Charlotte, gaps are filled from City of Charlotte (CDOT) open data, used non-commercially
          (CC BY-NC-SA 4.0).
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
