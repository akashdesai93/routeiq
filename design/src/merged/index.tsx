import '@fontsource/barlow-condensed/500.css'
import '@fontsource/barlow-condensed/600.css'
import { ArrowRight, ArrowUp, Briefcase, Check, ChevronDown, ChevronUp, CircleAlert, Clock, CornerUpRight, House, LocateFixed, Navigation2, Plus, Search, Volume2, X } from 'lucide-react'
import { useRef, type ReactNode } from 'react'
import { Collapse, Count, States } from '../../kit'
import { TRIP } from '../trip'
import { NO_RETURN_MIN, SPOKEN_KEEP, TRAVEL, fmtDist, spoken, type MScene } from '../scene'
import './merged.css'

// The merged direction (issues #21 and #22): Vector's black glass, condensed
// numerals and one amber "news" colour; Clearway's plain sentences; Noodle's
// way of showing why a switch happens. Everything sits over a street map: a
// turn card at the top, a sheet at the bottom. The map here is a drawing of a
// generic street grid in this project's own styling, standing in for the
// native map. No tiles, no network.

export type Signals = 'full' | 'partial' | 'unknown'

/** How a light count reads in each signal state. Never 0 when unsure. */
export function lightsText(state: Signals, n: number, known = 9) {
  if (state === 'full') return `${n} lights`
  if (state === 'partial') return `≥ ${known} lights`
  return 'Lights: unknown'
}
export const lightsHint: Record<Signals, string | null> = {
  full: null,
  partial: 'Some signal data is missing',
  unknown: 'No signal data for this route',
}

// A pattern takes its colour where it is defined, not where it is used, and
// ids are page-wide: night and day each get their own hatch.
const hatch = (day?: boolean) => `url(#mg-hatch${day ? '-day' : ''})`

function Defs({ day }: { day?: boolean }) {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
      <defs>
        <pattern id={`mg-hatch${day ? '-day' : ''}`} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="3" height="7" fill={day ? '#0a0c0f' : '#f2f4f6'} />
        </pattern>
      </defs>
    </svg>
  )
}

// ---------------------------------------------------------------- the map
// Streets for the driving view, in screen points. You drive up the middle
// avenue (x 201); Johnston Rd crosses at y 280.
const HS = [-60, 40, 118, 190, 250, 312, 404, 540, 630, 720, 810, 900, 980]
const VS = [-30, 44, 122, 201, 286, 362, 440]
const JOHNSTON = 312
const AVE = 201

function Streets() {
  return (
    <>
      <rect x={-60} y={-120} width={520} height={1160} className="mg-land" />
      <rect x={215} y={418} width={57} height={108} rx={8} className="mg-park" />
      <rect x={58} y={644} width={50} height={62} rx={8} className="mg-park" />
      <path d="M -60 688 L 460 412" className="mg-st" />
      {HS.map((y) => (
        <line key={`h${y}`} x1={-60} x2={460} y1={y} y2={y} className={y === JOHNSTON ? 'mg-st mg-st--major' : 'mg-st'} />
      ))}
      {VS.map((x) => (
        <line key={`v${x}`} x1={x} x2={x} y1={-120} y2={1040} className={x === AVE ? 'mg-st mg-st--major' : 'mg-st'} />
      ))}
    </>
  )
}

function Ring({ x, y }: { x: number; y: number }) {
  return <circle cx={x} cy={y} r={6} className="mg-signal" />
}

const TRUNK = `M ${AVE} 1000 V ${JOHNSTON}`
const BRANCH = `M ${AVE} ${JOHNSTON} H 470`
const OLD = `M ${AVE} ${JOHNSTON} V -120`
const SLOW = [280, 222]
const YOU = { x: AVE, y: 468 }

function NavMap({ s, day, route = true, youY = YOU.y }: { s: MScene; day?: boolean; route?: boolean; youY?: number }) {
  const news = s.stage === 'pending' || s.stage === 'confirmed'
  const old = s.route === 'slow' ? 'on' : s.stage === 'confirmed' ? 'left' : 'gone'
  const branch = s.route === 'fast' ? (s.stage === 'confirmed' ? 'new' : 'on') : s.stage === 'pending' ? 'pending' : 'hidden'
  const marker = s.stage === 'pending' ? 'hollow' : s.stage === 'confirmed' ? 'solid' : 'none'
  const move = { transitionDuration: s.go ? `${TRAVEL}ms` : '0ms' }
  return (
    <div className="mg-map">
      <svg width={402} height={874} viewBox="0 0 402 874" aria-hidden>
        <g className="mg-run" data-go={s.go || undefined} style={move}>
          <Streets />
          {route && (
            <text x={318} y={JOHNSTON - 11} textAnchor="middle" className="mg-st__name">
              {TRIP.turn.road}
            </text>
          )}
          {route && (
            <>
              <path d={TRUNK} className="mg-rt__case" />
              <g className="mg-old" data-state={old}>
                <path d={OLD} className="mg-rt__case" />
                <path d={OLD} className="mg-rt" />
                <rect x={AVE - 8} y={SLOW[1]} width={16} height={SLOW[0] - SLOW[1]} rx={3} className="mg-slow__bg" />
                <rect x={AVE - 8} y={SLOW[1]} width={16} height={SLOW[0] - SLOW[1]} rx={3} fill={hatch(day)} className="mg-slow" />
                <Ring x={AVE} y={190} />
                <Ring x={AVE} y={118} />
                <Ring x={AVE} y={40} />
              </g>
              <path d={TRUNK} className="mg-rt" />
              <g className="mg-branch" data-state={branch}>
                <path d={BRANCH} pathLength={1} className="mg-rt__case mg-draw" />
                <path d={BRANCH} pathLength={1} className="mg-rt mg-draw mg-branch__line" />
                <path d={BRANCH} pathLength={1} className="mg-draw mg-branch__core" />
                <Ring x={362} y={JOHNSTON} />
              </g>
              <Ring x={AVE} y={404} />
              <circle cx={AVE} cy={JOHNSTON} r={11} className="mg-marker" data-state={marker} />
            </>
          )}
        </g>
      </svg>
      {route && (
        <div className="mg-run mg-run--tags" data-go={s.go || undefined} style={move}>
          <div className="mg-tag" data-show={(old !== 'gone' && (news || s.route === 'slow')) || undefined} style={{ left: AVE + 20, top: (SLOW[0] + SLOW[1]) / 2 - 15 }}>
            Slow
          </div>
        </div>
      )}
      <div className="mg-you" style={{ left: YOU.x, top: youY }}>
        <Navigation2 size={24} strokeWidth={2.4} fill="currentColor" />
      </div>
    </div>
  )
}

// The whole trip at a glance, for Pick a route. A finer grid, two routes.
const FAST_PATH = 'M 84 322 V 232 H 198 V 150 H 300 V 96'
const SLOW_PATH = 'M 84 322 V 232 H 40 V 118 H 236 V 96 H 300'

function Overview({ day }: { day?: boolean }) {
  const lines = Array.from({ length: 22 }, (_, i) => -40 + i * 26)
  return (
    <div className="mg-map">
      <svg width={402} height={420} viewBox="0 0 402 420" aria-hidden>
        <rect x={-10} y={-10} width={422} height={440} className="mg-land" />
        <rect x={210} y={170} width={66} height={52} rx={6} className="mg-park" />
        <rect x={104} y={66} width={40} height={40} rx={6} className="mg-park" />
        {lines.map((v) => (
          <g key={v}>
            <line x1={v} x2={v} y1={-10} y2={430} className="mg-st mg-st--fine" />
            <line x1={-10} x2={412} y1={v} y2={v} className="mg-st mg-st--fine" />
          </g>
        ))}
        <path d="M -10 380 L 412 196" className="mg-st mg-st--fine" />
        <path d={SLOW_PATH} className="mg-rt__case mg-rt__case--thin" />
        <path d={SLOW_PATH} className="mg-rt mg-rt--alt" />
        <rect x={34} y={150} width={12} height={52} rx={3} className="mg-slow__bg" />
        <rect x={34} y={150} width={12} height={52} rx={3} fill={hatch(day)} className="mg-slow mg-slow--alt" />
        <path d={FAST_PATH} className="mg-rt__case mg-rt__case--thin" />
        <path d={FAST_PATH} className="mg-rt mg-rt--thin" />
        <circle cx={84} cy={322} r={8} className="mg-origin" />
        <rect x={291} y={87} width={18} height={18} rx={4} className="mg-dest" />
      </svg>
      <div className="mg-place" style={{ left: 102, top: 311 }}>
        {TRIP.from}
      </div>
      <div className="mg-place mg-place--end" style={{ right: 402 - 284, top: 85 }}>
        {TRIP.to}
      </div>
      <div className="mg-bubble" style={{ left: 208, top: 172 }}>
        {TRIP.fast.min} min
      </div>
      <div className="mg-bubble mg-bubble--alt" style={{ left: 56, top: 104 }}>
        {TRIP.slow.min} min
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- parts
function Fig({ children, unit, size }: { children: ReactNode; unit?: string; size?: 'xl' | 'lg' | 'md' | 'sm' }) {
  return (
    <span className="mg-fig" data-size={size}>
      <span className="n">{children}</span>
      {unit && <span className="u">{unit}</span>}
    </span>
  )
}

function Btn({ children, kind, wide, target }: { children: ReactNode; kind?: 'primary' | 'quiet'; wide?: boolean; target?: string }) {
  return (
    <span className="mg-btn" data-kind={kind} data-wide={wide || undefined} data-target={target}>
      {children}
    </span>
  )
}

/** A light count in any of the three signal states */
export function Lights({ state, n, known }: { state: Signals; n: number; known?: number }) {
  return (
    <span className="mg-lights" data-state={state}>
      {state !== 'full' && <CircleAlert size={16} strokeWidth={2.4} />}
      {lightsText(state, n, known)}
    </span>
  )
}

// ---------------------------------------------------------------- Plan (home)
const RECENTS = ['Uptown Charlotte', 'SouthPark', 'Charlotte Douglas Airport', 'Indian Land SC']

export function Plan({ day }: { day?: boolean }) {
  return (
    <div className="rq-screen mg" data-day={day || undefined}>
      <Defs day={day} />
      <NavMap s={{ route: 'fast', stage: 'drive', dist: 0, go: false, cover: false, more: false }} day={day} route={false} youY={236} />
      <div className="mg-sheet mg-sheet--plan">
        <div className="mg-search">
          <Search size={24} strokeWidth={2.4} />
          <span>Where to?</span>
        </div>
        <div className="mg-from">
          <LocateFixed size={18} strokeWidth={2.2} />
          <span>From: my location</span>
        </div>
        <div className="mg-chips">
          <span className="mg-chip">
            <House size={20} strokeWidth={2.2} />
            <span className="mg-chip__text">
              <b>Home</b>
              <i>Add</i>
            </span>
            <Plus size={20} strokeWidth={2.4} />
          </span>
          <span className="mg-chip">
            <Briefcase size={20} strokeWidth={2.2} />
            <span className="mg-chip__text">
              <b>Work</b>
              <i>Add</i>
            </span>
            <Plus size={20} strokeWidth={2.4} />
          </span>
        </div>
        <div className="mg-label">Recent</div>
        <div className="mg-recents">
          {RECENTS.map((r) => (
            <div key={r} className="mg-recent">
              <Clock size={20} strokeWidth={2.2} />
              <span>{r}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- Pick a route
export function RouteCard({ on, min, mi, lights, signals = 'full', known, tag }: { on?: boolean; min: number; mi: number; lights: number; signals?: Signals; known?: number; tag: string }) {
  return (
    <div className="mg-route" data-on={on || undefined}>
      <div className="mg-route__main">
        <Fig size={on ? 'xl' : 'lg'} unit="min">
          {min}
        </Fig>
        <div className="mg-route__side">
          <span className="mg-route__tag">
            {on && <Check size={17} strokeWidth={3} />}
            {tag}
          </span>
          <span className="mg-route__meta">
            <span>{mi} mi</span>
            <Lights state={signals} n={lights} known={known} />
          </span>
        </div>
      </div>
      {lightsHint[signals] && <div className="mg-route__hint">{lightsHint[signals]}</div>}
    </div>
  )
}

/** Fastest against the alternative: time first, lights second, distance last */
export function Delta({ signals = 'full' }: { signals?: Signals }) {
  const { fast, slow } = TRIP
  return (
    <div className="mg-delta">
      <div>
        <Fig size="md" unit="min">
          −{slow.min - fast.min}
        </Fig>
      </div>
      <div>
        {signals === 'full' ? (
          <Fig size="md" unit="lights">
            −{slow.lights - fast.lights}
          </Fig>
        ) : (
          <span className="mg-delta__na">Lights: can’t compare</span>
        )}
      </div>
      <div>
        <Fig size="md" unit="mi">
          −{slow.mi - fast.mi}
        </Fig>
      </div>
    </div>
  )
}

export function Pick({ day }: { day?: boolean }) {
  const { fast, slow } = TRIP
  return (
    <div className="rq-screen mg" data-day={day || undefined}>
      <Defs day={day} />
      <Overview day={day} />
      <div className="mg-sheet mg-sheet--pick">
        <RouteCard on min={fast.min} mi={fast.mi} lights={fast.lights} tag={fast.tag} />
        <RouteCard min={slow.min} mi={slow.mi} lights={slow.lights} tag={slow.tag} />
        <Delta />
        <div className="mg-note">Switches by itself if a faster route holds up.</div>
        <Btn kind="primary" wide>
          Start
          <ArrowRight size={24} strokeWidth={2.6} />
        </Btn>
      </div>
    </div>
  )
}

/** "Lights to go" in the More sheet, in any signal state */
export function LightsTile({ signals, n, known = 9 }: { signals: Signals; n: number; known?: number }) {
  return (
    <div className="mg-tile">
      <span className="mg-tile__label">Lights to go</span>
      {signals === 'full' && <Fig size="md">{n}</Fig>}
      {signals === 'partial' && (
        <span className="mg-tile__floor">
          <span className="mg-tile__word">≥ {known}</span>
          <span className="mg-tile__hint">data missing</span>
        </span>
      )}
      {signals === 'unknown' && <span className="mg-tile__word">Unknown</span>}
    </div>
  )
}

/** The turn card on its own, for the wording sheet (#45) */
export function TurnCard({ turn, dist, line }: { turn?: boolean; dist: number; line: string }) {
  return (
    <div className="mg-turn mg-turn--static">
      <span className="mg-turn__arrow">{turn ? <CornerUpRight size={60} strokeWidth={2.6} /> : <ArrowUp size={60} strokeWidth={2.6} />}</span>
      <div>
        <div className="mg-turn__big">
          <span>{fmtDist(dist)}</span>
          <span className="u">mi</span>
        </div>
        <div className={turn ? 'mg-turn__road' : 'mg-turn__road mg-turn__road--plain'}>{line}</div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- Driving and the switch
export function Drive({ s, day, signals = 'full', known = 9 }: { s: MScene; day?: boolean; signals?: Signals; known?: number }) {
  const r = TRIP[s.route]
  const turning = s.route === 'fast'
  const offer = s.stage === 'pending' || s.stage === 'confirmed'
  const news = offer || s.stage === 'declined'
  const was = s.stage === 'confirmed'
  // The banner keeps its last words while it closes
  const last = useRef<'pending' | 'confirmed' | 'declined'>('confirmed')
  if (news) last.current = s.stage as 'pending' | 'confirmed' | 'declined'
  const say = last.current
  return (
    <div className="rq-screen mg mg-drive" data-day={day || undefined} data-stage={s.stage} data-cover={s.cover || undefined}>
      <div className="rq-body">
        <Defs day={day} />
        <NavMap s={s} day={day} />

        <div className="mg-turn">
          <span className="mg-turn__arrow">
            <States value={turning ? 'turn' : 'up'} states={{ up: <ArrowUp size={60} strokeWidth={2.6} />, turn: <CornerUpRight size={60} strokeWidth={2.6} /> }} />
          </span>
          <div className="mg-turn__text">
            <div className="mg-turn__layer" data-show={!turning || undefined}>
              <div className="mg-turn__big">
                <span>{fmtDist(TRIP.straight.dist)}</span>
                <span className="u">mi</span>
              </div>
              <div className="mg-turn__road mg-turn__road--plain">Continue straight</div>
            </div>
            <div className="mg-turn__layer" data-show={turning || undefined}>
              <div className="mg-turn__big">
                <Count value={s.dist} format={fmtDist} duration={520} />
                <span className="u">mi</span>
              </div>
              <div className="mg-turn__road">{TRIP.turn.road}</div>
            </div>
          </div>
        </div>

        <div className="mg-sheet mg-sheet--drive">
            <Collapse open={news}>
            <div className="mg-newswrap">
            <div className="mg-news" data-stage={say}>
              <span className="mg-news__icon">
                <States value={say === 'pending' ? 'ring' : 'voice'} states={{ ring: <span className="mg-news__ring" />, voice: <Volume2 size={26} strokeWidth={2.4} /> }} />
              </span>
              <span className="mg-news__text">
                <States
                  align="start"
                  value={say}
                  states={{
                    pending: (
                      <span className="mg-news__two">
                        <b>{s.again ? 'Still faster. Checking again.' : 'Checking a faster route'}</b>
                        <span>
                          Would save {TRIP.saves} min · {signals === 'full' ? `${TRIP.slow.lights - TRIP.fast.lights} fewer lights` : 'lights: can’t compare'}
                        </span>
                      </span>
                    ),
                    confirmed: <b className="mg-news__spoken">{spoken(TRIP.saves, TRIP.turn.dist)}</b>,
                    declined: (
                      <span className="mg-news__two">
                        <b>{SPOKEN_KEEP}</b>
                        <span>Won’t offer that route again for {NO_RETURN_MIN} min.</span>
                      </span>
                    ),
                  }}
                />
              </span>
            </div>
            </div>
          </Collapse>

          <div className="mg-eta">
            <div className="mg-eta__time">
              <span className="mg-was" data-show={was || undefined}>
                <span className="mg-was__old">{TRIP.slow.min}</span>
                <ArrowRight size={26} strokeWidth={2.6} />
              </span>
              <span className="mg-eta__now" data-new={was || undefined}>
                <Fig size="lg" unit="min">
                  <Count value={r.min} />
                </Fig>
              </span>
            </div>
            <div className="mg-eta__arrive">
              <span className="mg-eta__label">Arrive</span>
              <span className="mg-eta__clock">
                <span className="mg-was mg-was--sm" data-show={was || undefined}>
                  <span className="mg-was__old">{TRIP.arrive.slow}</span>
                  <ArrowRight size={18} strokeWidth={2.6} />
                </span>
                <States align="end" value={s.route} states={{ slow: TRIP.arrive.slow, fast: TRIP.arrive.fast }} />
              </span>
            </div>
          </div>

          <Collapse open={offer}>
            <div className="mg-keep">
              <Btn wide target="keep">
                Keep my route
              </Btn>
            </div>
          </Collapse>

          <Collapse open={s.more}>
            <div className="mg-more">
              <LightsTile signals={signals} n={r.lights} known={known} />
              <div className="mg-tile">
                <span className="mg-tile__label">Distance</span>
                <Fig size="md" unit="mi">
                  {r.mi}
                </Fig>
              </div>
              <div className="mg-tile">
                <span className="mg-tile__label">Auto-switch</span>
                <span className="mg-tile__row">
                  <span className="mg-tile__word">On</span>
                  <span className="mg-toggle" data-on />
                </span>
              </div>
              <div className="mg-tile">
                <span className="mg-tile__label">Voice</span>
                <span className="mg-tile__row">
                  <span className="mg-tile__word">On</span>
                  <span className="mg-toggle" data-on />
                </span>
              </div>
            </div>
          </Collapse>

          <div className="mg-ctrl">
            <Btn kind="quiet">
              {s.more ? <ChevronDown size={24} strokeWidth={2.6} /> : <ChevronUp size={24} strokeWidth={2.6} />}
              {s.more ? 'Less' : 'More'}
            </Btn>
            <Btn kind="quiet">
              <X size={24} strokeWidth={2.6} />
              End
            </Btn>
          </div>
        </div>
      </div>
    </div>
  )
}
