import { formatDistance, formatDuration, type ArrowKind, type LiveState, type LiveView } from './core/index.ts'
import { REPLAY_MULTIPLIERS, type ReplayMultiplier } from './drive/replay.ts'

/** Development controls shown in the drive view during a replay. */
export interface LiveDevControls {
  readonly multiplier: ReplayMultiplier
  readonly setMultiplier: (m: ReplayMultiplier) => void
  readonly whatIfDelaySec: number
  readonly setWhatIfDelaySec: (sec: number) => void
}

interface LiveDriveViewProps {
  state: LiveState
  view: LiveView
  destinationLabel: string
  speechSupported?: boolean
  /** True during a development replay: the view says so. */
  replaying?: boolean
  dev?: LiveDevControls | null
  onKeepPrevious: () => void
  onMute: (muted: boolean) => void
  onEnd: () => void
  /** "Try again" after a failure. */
  onRestart: () => void
}

const ARROW_LABEL: Readonly<Record<ArrowKind, string>> = {
  straight: 'Continue',
  'slight-left': 'Bear left',
  left: 'Turn left',
  'sharp-left': 'Sharp left',
  'slight-right': 'Bear right',
  right: 'Turn right',
  'sharp-right': 'Sharp right',
  uturn: 'Make a U-turn',
  merge: 'Merge',
  roundabout: 'Roundabout',
  depart: 'Head out',
  arrive: 'Arrive',
}

/** Arrow shapes drawn for a left-hand maneuver; the right-hand ones are the same, mirrored. */
const LEFT_PATHS: Readonly<Record<string, string>> = {
  slight: 'M28 42 V26 L14 12 M14 24 V12 H26',
  turn: 'M30 42 V22 Q30 16 24 16 H10 M18 8 L10 16 L18 24',
  sharp: 'M30 42 V14 L14 30 M14 18 V30 H26',
  uturn: 'M32 42 V18 A8 8 0 0 0 16 18 V34 M8 26 L16 34 L24 26',
}
const STRAIGHT = 'M24 42 V10 M12 22 L24 10 L36 22'

function arrowPath(kind: ArrowKind): { d: string; mirrored: boolean; dot?: boolean } {
  switch (kind) {
    case 'slight-left':
      return { d: LEFT_PATHS.slight!, mirrored: false }
    case 'left':
      return { d: LEFT_PATHS.turn!, mirrored: false }
    case 'sharp-left':
      return { d: LEFT_PATHS.sharp!, mirrored: false }
    case 'uturn':
      return { d: LEFT_PATHS.uturn!, mirrored: false }
    case 'slight-right':
      return { d: LEFT_PATHS.slight!, mirrored: true }
    case 'right':
      return { d: LEFT_PATHS.turn!, mirrored: true }
    case 'sharp-right':
      return { d: LEFT_PATHS.sharp!, mirrored: true }
    case 'merge':
      return { d: `${STRAIGHT} M36 42 Q36 30 24 26`, mirrored: false }
    case 'roundabout':
      return { d: 'M24 42 V30 M24 30 A8 8 0 1 1 32 22 H42 M37 17 L42 22 L37 27', mirrored: false }
    case 'arrive':
      return { d: 'M24 24 V42', mirrored: false, dot: true }
    default:
      return { d: STRAIGHT, mirrored: false }
  }
}

/** The arrow of a maneuver. Decoration: the words next to it say the same. */
export function TurnArrow({ kind }: { kind: ArrowKind }) {
  const { d, mirrored, dot } = arrowPath(kind)
  return (
    <svg className="turn-arrow" viewBox="0 0 48 48" width="64" height="64" aria-hidden="true" data-arrow={kind}>
      <g
        transform={mirrored ? 'translate(48 0) scale(-1 1)' : undefined}
        fill="none"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={d} />
        {dot && <circle cx="24" cy="15" r="7" fill="currentColor" stroke="none" />}
      </g>
    </svg>
  )
}

function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/**
 * The full-screen view of a live drive, laid out for a phone held in a
 * mount: the next turn on top, the map in the middle (drawn by MapView,
 * which this component sits around), and at the bottom the arrival time, a
 * quiet status line and two large controls. Presentation only: every word
 * and number comes from core/live.ts (liveView) and the session state.
 */
export function LiveDriveView({
  state,
  view,
  destinationLabel,
  speechSupported = true,
  replaying = false,
  dev = null,
  onKeepPrevious,
  onMute,
  onEnd,
  onRestart,
}: LiveDriveViewProps) {
  const { status } = state
  const turn = view.nextTurn
  const banner = state.switchBanner
  const summary = state.summary

  if (status === 'arrived' && summary !== null) {
    return (
      <section className="live-summary" aria-label="Drive summary">
        <h2>You have arrived</h2>
        <p className="live-summary-place">{destinationLabel}</p>
        <p className="live-summary-time">Trip time {formatDuration(summary.tripSec)}</p>
        {summary.switches.length === 0 ? (
          <p>RouteIQ stayed on the first route: no faster one held up.</p>
        ) : (
          <>
            <p>
              RouteIQ changed route {summary.switches.length === 1 ? 'once' : `${summary.switches.length} times`}:
            </p>
            <ol className="live-summary-switches">
              {summary.switches.map((s) => (
                <li key={s.atMs}>
                  {clockTime(s.atMs)}: {s.reason.replace(/^Switching: /, '')}
                </li>
              ))}
            </ol>
          </>
        )}
        {summary.declined > 0 && (
          <p>You kept the previous route {summary.declined === 1 ? 'once' : `${summary.declined} times`}.</p>
        )}
        <p className="hint">Route requests used: {summary.requestsUsed}.</p>
        <button type="button" className="live-button live-primary" onClick={onEnd}>
          Done
        </button>
      </section>
    )
  }

  if (status === 'failed') {
    return (
      <section className="live-summary" aria-label="Live drive">
        <h2>The drive could not start</h2>
        <p role="alert">{state.message}</p>
        <div className="live-controls">
          <button type="button" className="live-button live-primary" onClick={onRestart}>
            Try again
          </button>
          <button type="button" className="live-button" onClick={onEnd}>
            Close
          </button>
        </div>
      </section>
    )
  }

  return (
    <>
      <section className="live-top" aria-label="Next turn" aria-live="polite">
        {turn !== null ? (
          <>
            <TurnArrow kind={turn.arrow} />
            <div className="live-turn-text">
              <span className="live-turn-distance">{formatDistance(turn.distanceM)}</span>
              <span className="live-turn-road">
                <span className="visually-hidden">{ARROW_LABEL[turn.arrow]}: </span>
                {turn.primaryText}
              </span>
              {turn.secondaryText !== null && <span className="live-turn-secondary">{turn.secondaryText}</span>}
            </div>
          </>
        ) : (
          <div className="live-turn-text">
            <span className="live-turn-road">
              {status === 'locating'
                ? 'Finding your position…'
                : status === 'planning'
                  ? 'Finding a route…'
                  : view.offRoute
                    ? 'Off the route'
                    : `To ${destinationLabel}`}
            </span>
          </div>
        )}
      </section>

      <section className="live-bottom" aria-label="Live drive">
        {banner !== null && (
          <div className="live-banner" role="status">
            <strong>{banner.text}</strong>
            {banner.canKeep && (
              <button type="button" className="live-button live-keep" onClick={onKeepPrevious}>
                Keep previous route
              </button>
            )}
          </div>
        )}
        {view.warnings.map((warning) => (
          <p key={warning} className="live-warning" role="status">
            {warning}
          </p>
        ))}
        {!speechSupported && <p className="live-warning">This browser cannot speak: watch the screen for route changes.</p>}
        <p className="live-eta">
          {view.arrivalAtMs !== null && view.remainingSec !== null && view.remainingM !== null ? (
            <>
              <strong>{clockTime(view.arrivalAtMs)}</strong>
              <span>{formatDuration(view.remainingSec)}</span>
              <span>{formatDistance(view.remainingM)}</span>
            </>
          ) : (
            <span>{destinationLabel}</span>
          )}
        </p>
        <p className="live-status" role="status">
          {view.statusLine}
          {status === 'driving' && (
            <>
              {' · '}
              {view.checking ? 'checking now' : view.checkedAgoSec === null ? 'not checked yet' : `checked ${view.checkedAgoSec} s ago`}
              {' · '}
              {view.requestsUsed} of {view.maxRequests} requests
            </>
          )}
          {replaying && ' · GPS replay (simulated position)'}
        </p>
        {dev !== null && replaying && (
          <div className="live-dev" role="group" aria-label="Replay controls (development)">
            {REPLAY_MULTIPLIERS.map((m) => (
              <button key={m} type="button" aria-pressed={dev.multiplier === m} onClick={() => dev.setMultiplier(m)}>
                {m}×
              </button>
            ))}
            <button type="button" aria-pressed={dev.whatIfDelaySec > 0} onClick={() => dev.setWhatIfDelaySec(dev.whatIfDelaySec > 0 ? 0 : 600)}>
              What-if +10 min{dev.whatIfDelaySec > 0 ? ' (on)' : ''}
            </button>
          </div>
        )}
        <div className="live-controls">
          <button type="button" className="live-button" aria-pressed={state.muted} onClick={() => onMute(!state.muted)}>
            {state.muted ? 'Unmute' : 'Mute'}
          </button>
          <button type="button" className="live-button live-end" onClick={onEnd}>
            End
          </button>
        </div>
      </section>
    </>
  )
}
