import '@fontsource/instrument-serif/400.css'
import { ArrowRight, ArrowUp, Check, CornerUpRight, Radar, Volume2, X } from 'lucide-react'
import { Count, States } from '../../kit'
import { LIGHTS_FAST, LIGHTS_SLOW, SLOW_FAST, SLOW_SLOW, TRIP } from '../trip'
import { TRAVEL, fmtDist, type Scene } from '../scene'
import type { Direction } from './types'
import './clearway.css'

// 1 · Clearway. Calm and premium: warm paper, one ink, one cobalt accent, a
// serif numeral as the only loud thing on each screen. The strip is a single
// fine line. When the app has something to say, the bottom sheet says it.

/** A route as one fine line: every light a ring, slow stretches hatched. */
function Line({ w, lights, slow, quiet }: { w: number; lights: number[]; slow: [number, number][]; quiet?: boolean }) {
  const y = 14
  const x = (t: number) => 6 + t * (w - 12)
  return (
    <svg className="cw-line" data-quiet={quiet || undefined} width={w} height={28} viewBox={`0 0 ${w} 28`} aria-hidden>
      <line x1={6} x2={w - 6} y1={y} y2={y} className="cw-line__road" />
      {slow.map(([a, b]) => (
        <g key={a}>
          <rect x={x(a)} y={y - 6} width={x(b) - x(a)} height={12} rx={6} className="cw-line__slowbg" />
          <rect x={x(a)} y={y - 6} width={x(b) - x(a)} height={12} rx={6} fill="url(#cw-hatch)" className="cw-line__slow" />
        </g>
      ))}
      {lights.map((t) => (
        <circle key={t} cx={x(t)} cy={y} r={3.6} className="cw-line__light" />
      ))}
    </svg>
  )
}

function Hatch() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
      <defs>
        <pattern id="cw-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="2.2" height="5" fill="currentColor" />
        </pattern>
      </defs>
    </svg>
  )
}

function Pick() {
  const { fast, slow } = TRIP
  return (
    <div className="rq-screen cw">
      <Hatch />
      <div className="cw-head">
        <div className="cw-head__from">From {TRIP.from}</div>
        <div className="cw-head__to">{TRIP.to}</div>
      </div>

      <div className="cw-route" data-on>
        <div className="cw-route__tag">
          <span className="cw-radio" data-on>
            <Check size={15} strokeWidth={3} />
          </span>
          {fast.tag}
        </div>
        <div className="cw-route__time">
          <span className="cw-num">{fast.min}</span>
          <span className="cw-unit">min</span>
        </div>
        <div className="cw-route__meta">
          <span>{fast.mi} mi</span>
          <i />
          <span>{fast.lights} lights</span>
        </div>
        <Line w={314} lights={LIGHTS_FAST} slow={SLOW_FAST} />
        <div className="cw-key">
          <span className="cw-key__dot" />
          <span>a traffic light</span>
          <span className="cw-key__slow" />
          <span>slow now</span>
        </div>
      </div>

      <div className="cw-route">
        <div className="cw-route__row">
          <div className="cw-route__time cw-route__time--sm">
            <span className="cw-num">{slow.min}</span>
            <span className="cw-unit">min</span>
          </div>
          <div className="cw-route__side">
            <div className="cw-route__slower">{slow.tag}</div>
            <div className="cw-route__meta">
              <span>{slow.mi} mi</span>
              <i />
              <span>{slow.lights} lights</span>
            </div>
          </div>
        </div>
        <Line w={314} lights={LIGHTS_SLOW} slow={SLOW_SLOW} quiet />
      </div>

      <div className="cw-foot">
        <div className="cw-note">Switches by itself if a faster route holds up.</div>
        <div className="cw-go">
          Start
          <ArrowRight size={22} strokeWidth={2.4} />
        </div>
      </div>
    </div>
  )
}

// The road ahead, in the strip's own coordinates. You sit at x 64; the road
// slides left under you. The trunk runs straight on; the faster route leaves
// it at the turn and climbs away with fewer lights on it.
const Y = 150
const TURN = 236
const TRUNK = `M -260 ${Y} H ${TURN - 40}`
const AHEAD = `M ${TURN - 40} ${Y} H 760`
const BRANCH = `M ${TURN - 40} ${Y} C ${TURN} ${Y} ${TURN + 14} ${Y - 22} ${TURN + 34} ${Y - 50} L ${TURN + 330} ${Y - 464}`
const NEAR = [164] // a light before the turn, on either route
const AHEAD_LIGHTS = [246, 282, 392, 430, 486, 540]
const SLOW = [298, 376]
const BRANCH_LIGHTS: [number, number][] = [[TURN + 88, Y - 125.5]]

const TITLES = ['Watching traffic', 'Faster route spotted', 'Faster route spotted', 'Switching now', 'You’re on the faster route']
const SUBS = [
  'Switches by itself when faster',
  'Checking that it holds · 1 of 2',
  'Held up twice · 2 of 2',
  '“Faster route ahead. Saves 8 minutes.”',
  'Saves 8 min · 2 fewer lights',
]

function Drive({ s }: { s: Scene }) {
  const r = TRIP[s.route]
  const turning = s.route === 'fast'
  const live = s.banner > 0
  // The old road shows while you are on it, and through the switch as the road not taken
  const old = s.route === 'slow' ? 'on' : live ? 'left' : 'gone'
  const branch = s.route === 'fast' ? (live ? 'new' : 'on') : live ? 'found' : 'hidden'
  return (
    <div className="rq-screen cw cw-drive" data-live={live || undefined} data-cover={s.cover || undefined}>
      <div className="rq-body">
      <Hatch />
      <div className="cw-turn">
        <div className="cw-turn__layer" data-show={!turning || undefined}>
          <ArrowUp className="cw-turn__arrow" size={52} strokeWidth={2.2} />
          <div className="cw-turn__straight">Straight on</div>
          <div className="cw-turn__road">No turns for a while</div>
        </div>
        <div className="cw-turn__layer" data-show={turning || undefined}>
          <CornerUpRight className="cw-turn__arrow" size={52} strokeWidth={2.2} />
          <div className="cw-turn__dist">
            <span className="cw-num">
              <Count value={s.dist} format={fmtDist} duration={520} />
            </span>
            <span className="cw-unit">mi</span>
          </div>
          <div className="cw-turn__road">{TRIP.turn.road}</div>
        </div>
      </div>

      <div className="cw-strip">
        <svg width={402} height={230} viewBox="0 0 402 230" aria-hidden>
          <g className="cw-road" data-go={s.go || undefined} style={{ transitionDuration: s.go ? `${TRAVEL}ms` : '0ms' }}>
            <g className="cw-old" data-state={old}>
              <path d={AHEAD} className="cw-road__line" />
              <rect x={SLOW[0]} y={Y - 9} width={SLOW[1] - SLOW[0]} height={18} rx={9} className="cw-line__slowbg" />
              <rect x={SLOW[0]} y={Y - 9} width={SLOW[1] - SLOW[0]} height={18} rx={9} fill="url(#cw-hatch)" className="cw-line__slow" />
              <text x={(SLOW[0] + SLOW[1]) / 2} y={Y + 34} textAnchor="middle" className="cw-road__label">
                slow
              </text>
              {AHEAD_LIGHTS.map((x) => (
                <circle key={x} cx={x} cy={Y} r={7} className="cw-road__light" />
              ))}
            </g>
            <path d={TRUNK} className="cw-road__line" />
            <g className="cw-branch" data-state={branch}>
              <path d={BRANCH} pathLength={1} className="cw-road__line cw-branch__line" />
              {BRANCH_LIGHTS.map(([x, y]) => (
                <circle key={x} cx={x} cy={y} r={7} className="cw-road__light" />
              ))}
            </g>
            {NEAR.map((x) => (
              <circle key={x} cx={x} cy={Y} r={7} className="cw-road__light" />
            ))}
          </g>
          <circle cx={64} cy={Y} r={17} className="cw-you__halo" />
          <circle cx={64} cy={Y} r={10} className="cw-you" />
        </svg>
        <div className="cw-strip__cap">
          <Count value={r.lights} /> lights to go
        </div>
      </div>

      <div className="cw-sheet">
        <div className="cw-say">
          <span className="cw-say__icon">
            <States
              value={s.banner === 3 ? 'voice' : s.banner === 4 ? 'done' : 'watch'}
              states={{ watch: <Radar size={26} strokeWidth={2} />, voice: <Volume2 size={26} strokeWidth={2} />, done: <Check size={26} strokeWidth={2.6} /> }}
            />
          </span>
          <span className="cw-say__text">
            <span className="cw-say__title">
              <States align="start" value={TITLES[s.banner]} states={Object.fromEntries([...new Set(TITLES)].map((t) => [t, t]))} />
            </span>
            <span className="cw-say__sub">
              <States align="start" value={String(s.banner)} states={Object.fromEntries(SUBS.map((t, i) => [String(i), t]))} />
            </span>
          </span>
        </div>
        <div className="cw-eta">
          <div className="cw-eta__time">
            <span className="cw-num">
              <Count value={r.min} />
            </span>
            <span className="cw-unit">min</span>
          </div>
          <div className="cw-eta__side">
            <div className="cw-eta__mi">
              <Count value={r.mi} /> mi
            </div>
            <div className="cw-eta__arrive">
              <span>Arrive</span>
              <States align="end" value={s.route} states={{ slow: TRIP.arrive.slow, fast: TRIP.arrive.fast }} />
            </div>
          </div>
        </div>
        <div className="cw-ctrl">
          <span className="cw-btn cw-btn--round" aria-label="Mute voice">
            <Volume2 size={26} strokeWidth={2} />
          </span>
          <span className="cw-btn">
            <X size={22} strokeWidth={2.4} />
            End
          </span>
        </div>
      </div>
      </div>
    </div>
  )
}

export const clearway: Direction = {
  id: 'clearway',
  name: 'Clearway',
  idea: 'Calm and premium: one serif number, lots of air, and a single line that shows the road ahead.',
  palette: 'Warm paper #F4F1EA, ink #15181C, one cobalt accent #2238E8',
  type: 'Instrument Serif numerals, Inter for everything else',
  dark: false,
  ground: '#F4F1EA',
  Pick,
  Drive,
}
