import { memo, useState, type ReactNode } from 'react'
import {
  formatDistance,
  formatDuration,
  formatSignalCount,
  type ArrowKind,
  type LiveState,
  type LiveView,
  type SignalCoverage,
  type SwitchMoment,
} from './core/index.ts'
import { Figure } from './Figure.tsx'
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
  /** Shown at the end of the More sheet. The iPhone shell puts "Drive diagnostics" here. */
  extra?: ReactNode
  /** The More sheet starts open. For tests: a driver opens it with a tap. */
  initiallyOpen?: boolean
  /** "Keep my route": turns down the switch, pending or made. */
  onKeepPrevious: () => void
  /** "Take it": switches at once to the faster route on offer (#197). */
  onTakeOffer: () => void
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

/** The offered route's turn in words (#197): "Turn left: East Loop", "Turn left", or "Turn-off" when nothing is known. */
function offerTurnLine(arrow: ArrowKind | null, road: string | null): string {
  if (arrow === null) return road ?? 'Turn-off'
  return road === null ? ARROW_LABEL[arrow] : `${ARROW_LABEL[arrow]}: ${road}`
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

interface TurnCardProps {
  /** Null: no maneuver to show, only `line`. */
  arrow: ArrowKind | null
  /** The hero, already in words ("0.8 mi"). Null with no arrow. */
  distance: string | null
  /** The street to turn onto, or a plain sentence. */
  line: string
  /** `line` is a sentence ("Continue straight"), set in the text face; otherwise a street name, condensed. */
  plain: boolean
  /** Read out before `line` by a screen reader ("Turn right"). */
  spokenPrefix: string | null
  secondary: string | null
}

/**
 * The turn card: the distance to the next maneuver as the hero, and under it
 * the street. Given words only, so a clock tick that changes none of them
 * does not render it again.
 */
const TurnCard = memo(function TurnCard({ arrow, distance, line, plain, spokenPrefix, secondary }: TurnCardProps) {
  return (
    <section className="live-top" aria-label="Next turn" aria-live="polite">
      {arrow !== null && <TurnArrow kind={arrow} />}
      <div className="live-turn-text">
        {distance !== null && (
          <span className="live-turn-distance">
            <Figure text={distance} unitClass="live-unit" />
          </span>
        )}
        <span className={plain ? 'live-turn-road live-turn-plain' : 'live-turn-road'}>
          {spokenPrefix !== null && <span className="visually-hidden">{spokenPrefix}: </span>}
          {line}
        </span>
        {secondary !== null && <span className="live-turn-secondary">{secondary}</span>}
      </div>
    </section>
  )
})

/** The voice mark of a banner that is the spoken line. Decoration. */
function SpeakerIcon() {
  return (
    <svg className="live-news-icon" viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 9.5 H7.5 L12 5.5 V18.5 L7.5 14.5 H4 Z" />
        <path d="M15.5 9 Q17.5 12 15.5 15 M18.5 6.5 Q22 12 18.5 17.5" />
      </g>
    </svg>
  )
}

interface NewsProps {
  stage: SwitchMoment['stage']
  title: string
  detail: string | null
}

/**
 * The banner of the switch moment (#84, design #22, #43, #44): an amber
 * outline while a faster route is being confirmed, filled amber once the
 * switch is made (its words are the spoken line), and a calm outline after
 * "Keep my route" or when an offer ends (#197). Amber means news and nothing else.
 */
const News = memo(function News({ stage, title, detail }: NewsProps) {
  return (
    <div className="live-news" data-stage={stage} role="status">
      {/* The speaker marks a banner that was said out loud; the withdrawn one is on screen only. */}
      {stage === 'pending' ? <span className="live-news-ring" aria-hidden="true" /> : stage === 'withdrawn' ? null : <SpeakerIcon />}
      <div className="live-news-text">
        <strong>{title}</strong>
        {detail !== null && <span className="live-news-detail">{detail}</span>}
      </div>
    </div>
  )
})

interface OfferTurnProps {
  /** Null: the offered route's guidance has no maneuver there; no arrow is drawn. */
  arrow: ArrowKind | null
  distance: string
  /** "Turn left: East Loop"; just the verb when it names no road there; "Turn-off" when nothing is known. */
  line: string
}

/**
 * How to take the faster route on offer (#197): its turn-off, as the turn card shows a turn
 * (arrow, distance, road), smaller, inside the pending banner's block. Words only, so a fix
 * that moves the car less than the rounding does not render it again.
 */
const OfferTurn = memo(function OfferTurn({ arrow, distance, line }: OfferTurnProps) {
  return (
    <div className="live-offer-turn" aria-label="Turn for the faster route">
      {arrow !== null && <TurnArrow kind={arrow} />}
      <span className="live-offer-distance">
        <Figure text={distance} unitClass="live-unit" />
      </span>
      <span className="live-offer-road">{line}</span>
    </div>
  )
})

/**
 * "43 min" beside "35 min" reads "43 → 35 min", and "8:37 AM" beside "8:20 AM" reads
 * "8:37 → 8:20 AM": a unit or day half the two share is written once, after the new figure,
 * so the line fits a 375 px phone.
 */
function bare(before: string, after: string): string {
  const unit = / [^\d\s]+$/.exec(after)?.[0]
  return unit !== undefined && before.endsWith(unit) ? before.slice(0, -unit.length) : before
}

/**
 * The time line at the moment of a switch: the old travel time and arrival
 * small, dim and struck through, the new ones beside them, the new time
 * on amber. The figures of the moment the switch was made: they do not tick.
 */
const SwitchEta = memo(function SwitchEta({ beforeLeft, beforeArrive, afterLeft, afterArrive }: {
  beforeLeft: string | null
  beforeArrive: string | null
  afterLeft: string
  afterArrive: string
}) {
  return (
    <p className="live-eta live-eta-switch">
      <span className="live-eta-change">
        {beforeLeft !== null && (
          <>
            <s className="live-eta-old">{bare(beforeLeft, afterLeft)}</s>
            <span className="live-eta-to"> → </span>
          </>
        )}
        <strong className="live-eta-left live-eta-new">
          <Figure text={afterLeft} unitClass="live-unit" />
        </strong>
      </span>
      <span className="live-eta-arrive">
        <span className="live-eta-label">Arrive </span>
        <span className="live-eta-clock">
          {beforeArrive !== null && (
            <>
              <s className="live-eta-old">{bare(beforeArrive, afterArrive)}</s>
              <span className="live-eta-to"> → </span>
            </>
          )}
          <span className="live-eta-now">{afterArrive}</span>
        </span>
      </span>
    </p>
  )
})

/** One line: the time left, large, and the arrival time, smaller and dimmer. */
const EtaLine = memo(function EtaLine({ left, arrive, fallback }: { left: string | null; arrive: string | null; fallback: string }) {
  return (
    <p className="live-eta">
      {left !== null && arrive !== null ? (
        <>
          <strong className="live-eta-left">
            <Figure text={left} unitClass="live-unit" />
          </strong>
          <span className="live-eta-arrive">
            <span className="live-eta-label">Arrive </span>
            <span className="live-eta-clock">{arrive}</span>
          </span>
        </>
      ) : (
        <span className="live-eta-place">{fallback}</span>
      )}
    </p>
  )
})

/**
 * The lights tile, in the three states of the route cards (#44): a full count
 * is a number, a partial one a lower bound that says data is missing,
 * anything else "Unknown". Which state it is comes from formatSignalCount
 * (core), so it is never 0 when unsure.
 */
function lightsTile(count: number | null, coverage: SignalCoverage): { word: string; hint: string | null } {
  if (count === null || formatSignalCount(count, coverage) === 'Signals: unknown') return { word: 'Unknown', hint: null }
  if (coverage === 'partial') return { word: `≥ ${count}`, hint: 'data missing' }
  return { word: String(count), hint: null }
}

interface MoreProps {
  lights: string
  lightsHint: string | null
  distance: string | null
  muted: boolean
  status: string
  replaying: boolean
  dev: LiveDevControls | null
  extra: ReactNode
  onMute: (muted: boolean) => void
}

/** What is behind More: lights, distance, the automatic switch, the voice, and the quiet status line. */
const MoreSheet = memo(function MoreSheet({ lights, lightsHint, distance, muted, status, replaying, dev, extra, onMute }: MoreProps) {
  return (
    <div className="live-more" id="live-more">
      <div className="live-tiles">
        <div className="live-tile" data-tile="lights">
          <span className="live-tile-label">Lights on route</span>
          <span className="live-tile-word">
            {lights}
            {lightsHint !== null && <span className="live-tile-hint"> {lightsHint}</span>}
          </span>
        </div>
        <div className="live-tile" data-tile="distance">
          <span className="live-tile-label">Distance</span>
          <span className="live-tile-word">{distance === null ? '—' : <Figure text={distance} unitClass="live-unit" />}</span>
        </div>
        <div className="live-tile" data-tile="auto-switch">
          <span className="live-tile-label">Auto-switch</span>
          <span className="live-tile-word">On</span>
        </div>
        {/* A switch named by its own words ("Voice On"), so "tap Voice" works with Voice Control (#133). */}
        <button
          type="button"
          role="switch"
          className="live-tile live-voice"
          data-tile="voice"
          aria-checked={!muted}
          onClick={() => onMute(!muted)}
        >
          <span className="live-tile-label">Voice</span>
          <span className="live-tile-word">{muted ? 'Off' : 'On'}</span>
          <span className="live-toggle" aria-hidden="true" />
        </button>
      </div>
      <p className="live-status" role="status">
        {status}
        {replaying && ' · GPS replay (simulated position)'}
      </p>
      {import.meta.env.DEV && dev !== null && replaying && (
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
      {extra !== null && extra !== undefined && <div className="live-extra">{extra}</div>}
    </div>
  )
})

/**
 * The full-screen view of a live drive, laid out for a phone held in a
 * mount, in the approved design (design/README.md, "The merged direction"):
 * black glass on the map (drawn by MapView, which this component sits
 * around), a turn card on top with the distance to the next maneuver as the
 * hero, and a sheet at the bottom with one line (time left, arrival time)
 * and two controls. Everything else is behind More. Presentation only: every
 * word and number comes from core/live.ts (liveView) and the session state.
 *
 * The parts are memoised and take words, not the state: the once-a-second
 * tick renders only the part whose words changed.
 */
export function LiveDriveView({
  state,
  view,
  destinationLabel,
  speechSupported = true,
  replaying = false,
  dev = null,
  extra = null,
  initiallyOpen = false,
  onKeepPrevious,
  onTakeOffer,
  onMute,
  onEnd,
  onRestart,
}: LiveDriveViewProps) {
  const [open, setOpen] = useState(initiallyOpen)
  const { status } = state
  const turn = view.nextTurn
  const moment = view.moment
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

  // The turn card, in words. With a maneuver ahead the hero is always its distance, however
  // far (#45): over a street to turn onto, or "Continue on <road>" when the road carries on.
  let card: TurnCardProps
  if (turn !== null) {
    const straight = turn.arrow === 'straight'
    card = {
      arrow: turn.arrow,
      // While the switch banner shows, the distance its spoken line named (#22).
      distance: view.heldTurnText ?? formatDistance(turn.distanceM),
      line: straight ? (turn.primaryText === '' ? 'Continue straight' : `Continue on ${turn.primaryText}`) : turn.primaryText,
      plain: straight || turn.arrow === 'arrive',
      spokenPrefix: straight ? null : ARROW_LABEL[turn.arrow],
      secondary: turn.secondaryText,
    }
  } else if (status === 'driving' && !view.offRoute && view.remainingM !== null) {
    // A route with no turns listed: straight on for what is left of it.
    card = { arrow: 'straight', distance: formatDistance(view.remainingM), line: 'Continue straight', plain: true, spokenPrefix: null, secondary: null }
  } else {
    card = {
      arrow: null,
      distance: null,
      line:
        status === 'locating'
          ? 'Finding your position…'
          : status === 'planning'
            ? 'Finding a route…'
            : view.offRoute
              ? 'Off the route'
              : `To ${destinationLabel}`,
      plain: true,
      spokenPrefix: null,
      secondary: null,
    }
  }

  const known = view.arrivalAtMs !== null && view.remainingSec !== null
  const lights = lightsTile(state.route?.signalCount ?? null, state.route?.signalCoverage ?? 'none')
  const statusLine =
    status === 'driving'
      ? `${view.statusLine} · ${view.checking ? 'checking now' : view.checkedAgoSec === null ? 'not checked yet' : `checked ${view.checkedAgoSec} s ago`} · ${view.requestsUsed} of ${view.maxRequests} requests`
      : view.statusLine

  return (
    <>
      <TurnCard {...card} />

      <section className="live-bottom" aria-label="Live drive">
        {view.warnings.map((warning) => (
          <p key={warning} className="live-warning" role="status">
            {warning}
          </p>
        ))}
        {!speechSupported && <p className="live-warning">This browser cannot speak: watch the screen for route changes.</p>}
        {/* The switch just made is one block: its banner, its figures and the way to undo it. */}
        <div className={moment?.stage === 'confirmed' ? 'live-moment live-banner' : 'live-moment'}>
          {moment !== null && (
            <News
              stage={moment.stage}
              title={moment.title}
              detail={moment.stage === 'pending' || moment.stage === 'kept' ? moment.detail : null}
            />
          )}
          {moment?.stage === 'pending' && (
            <OfferTurn
              arrow={moment.turn.arrow}
              distance={formatDistance(moment.turn.distanceM)}
              line={offerTurnLine(moment.turn.arrow, moment.turn.primaryText)}
            />
          )}
          {moment?.stage === 'confirmed' ? (
            <SwitchEta
              beforeLeft={moment.before === null ? null : formatDuration(moment.before.sec)}
              beforeArrive={moment.before === null ? null : clockTime(moment.before.arriveAtMs)}
              afterLeft={formatDuration(moment.after.sec)}
              afterArrive={clockTime(moment.after.arriveAtMs)}
            />
          ) : (
            <EtaLine
              left={known ? formatDuration(view.remainingSec!) : null}
              arrive={known ? clockTime(view.arrivalAtMs!) : null}
              fallback={destinationLabel}
            />
          )}
          {moment !== null && moment.canKeep && (
            <div className="live-moment-actions">
              {moment.stage === 'pending' && moment.canTake && (
                <button type="button" className="live-button live-primary live-take" onClick={onTakeOffer}>
                  Take it
                </button>
              )}
              <button type="button" className="live-button live-keep" onClick={onKeepPrevious}>
                Keep my route
              </button>
            </div>
          )}
        </div>
        {/* With More closed the engine's latest word is still there to be read out, just not drawn.
            Without the "checked N s ago" part, so a clock tick changes nothing here. */}
        {!open && (
          <p className="live-status visually-hidden" role="status">
            {view.statusLine}
          </p>
        )}
        {open && (
          <MoreSheet
            lights={lights.word}
            lightsHint={lights.hint}
            distance={view.remainingM === null ? null : formatDistance(view.remainingM)}
            muted={state.muted}
            status={statusLine}
            replaying={replaying}
            dev={dev}
            extra={extra}
            onMute={onMute}
          />
        )}
        <div className="live-controls">
          <button type="button" className="live-button live-more-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? 'Less' : 'More'}
          </button>
          <button type="button" className="live-button live-end" onClick={onEnd}>
            End
          </button>
        </div>
      </section>
    </>
  )
}
