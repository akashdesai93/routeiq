import '@fontsource/barlow-condensed/500.css'
import '@fontsource/barlow-condensed/600.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/600.css'
import { ArrowRight, ArrowUp, Check, CornerUpRight, ScanLine, Volume2, X } from 'lucide-react'
import { Count, States } from '../../kit'
import { LIGHTS_FAST, LIGHTS_SLOW, SLOW_FAST, SLOW_SLOW, TRIP } from '../trip'
import { TRAVEL, fmtDist, type Scene } from '../scene'
import type { Direction } from './types'
import './vector.css'

// 3 · Vector. A bold instrument: true black, white figures, one amber signal.
// Condensed numerals sized like a cockpit readout, hairline rules, and the
// strip as a distance tape that runs under you.

function Hatch() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
      <defs>
        <pattern id="vx-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="2.5" height="6" fill="currentColor" />
        </pattern>
      </defs>
    </svg>
  )
}

/** A route as a ruled line: a ring per traffic light, slow stretches hatched */
function Rule({ w, lights, slow }: { w: number; lights: number[]; slow: [number, number][] }) {
  const y = 12
  const x = (t: number) => 5 + t * (w - 10)
  return (
    <svg className="vx-rule" width={w} height={24} viewBox={`0 0 ${w} 24`} aria-hidden>
      <line x1={0} x2={w} y1={y} y2={y} className="vx-rule__line" />
      <line x1={1} x2={1} y1={4} y2={20} className="vx-rule__line" />
      <line x1={w - 1} x2={w - 1} y1={4} y2={20} className="vx-rule__line" />
      {slow.map(([a, b]) => (
        <g key={a}>
          <rect x={x(a)} y={y - 6} width={x(b) - x(a)} height={12} className="vx-rule__slowbg" />
          <rect x={x(a)} y={y - 6} width={x(b) - x(a)} height={12} fill="url(#vx-hatch)" className="vx-rule__slow" />
        </g>
      ))}
      {lights.map((t) => (
        <circle key={t} cx={x(t)} cy={y} r={3.1} className="vx-rule__light" />
      ))}
    </svg>
  )
}

function Pick() {
  const { fast, slow } = TRIP
  return (
    <div className="rq-screen vx vx-pick">
      <Hatch />
      <div className="vx-head">
        <div className="vx-lab">Destination</div>
        <div className="vx-head__to">{TRIP.to}</div>
        <div className="vx-lab">From {TRIP.from}</div>
      </div>

      <div className="vx-route" data-on>
        <div className="vx-route__top">
          <span className="vx-lab">Route 1 · selected</span>
          <span className="vx-flag">
            <Check size={14} strokeWidth={3.4} />
            {fast.tag}
          </span>
        </div>
        <div className="vx-route__body">
          <div className="vx-fig vx-fig--xl">
            {fast.min}
            <span className="u">min</span>
          </div>
          <div className="vx-route__side">
            <div className="vx-fig">
              {fast.mi}
              <span className="u">mi</span>
            </div>
            <div className="vx-fig">
              {fast.lights}
              <span className="u">lights</span>
            </div>
          </div>
        </div>
        <Rule w={338} lights={LIGHTS_FAST} slow={SLOW_FAST} />
      </div>

      <div className="vx-route">
        <div className="vx-route__top">
          <span className="vx-lab">Route 2</span>
          <span className="vx-flag vx-flag--plain">{slow.tag}</span>
        </div>
        <div className="vx-route__body">
          <div className="vx-fig vx-fig--lg">
            {slow.min}
            <span className="u">min</span>
          </div>
          <div className="vx-route__side vx-route__side--row">
            <div className="vx-fig vx-fig--sm">
              {slow.mi}
              <span className="u">mi</span>
            </div>
            <div className="vx-fig vx-fig--sm">
              {slow.lights}
              <span className="u">lights</span>
            </div>
          </div>
        </div>
        <Rule w={338} lights={LIGHTS_SLOW} slow={SLOW_SLOW} />
      </div>

      <div className="vx-legend">
        <span className="vx-legend__light" />
        <span>traffic light</span>
        <span className="vx-legend__slow" />
        <span>slow now</span>
      </div>

      <div className="vx-delta">
        <div>
          <span className="vx-lab">Time</span>
          <div className="vx-fig">
            −{slow.min - fast.min}
            <span className="u">min</span>
          </div>
        </div>
        <div>
          <span className="vx-lab">Lights</span>
          <div className="vx-fig">−{slow.lights - fast.lights}</div>
        </div>
        <div>
          <span className="vx-lab">Distance</span>
          <div className="vx-fig">
            −{slow.mi - fast.mi}
            <span className="u">mi</span>
          </div>
        </div>
      </div>

      <div className="vx-foot">
        <div className="vx-armed">
          <span className="vx-armed__pip" />
          Auto-switch armed · 2 min or more · 2 checks
        </div>
        <div className="vx-go">
          Start
          <ArrowRight size={28} strokeWidth={2.6} />
        </div>
      </div>
    </div>
  )
}

// The tape. 400 px to the mile; you sit at y 540 and the tape runs down under
// you. The turn is 0.8 mi ahead: the faster route steps right, the old one
// carries straight on.
const X0 = 42
const X1 = 68
const YOU = 540
const PX = 400
const TURN = YOU - 0.8 * PX // 220
const TICKS = Array.from({ length: 23 }, (_, i) => i) // every 0.1 mi, to 2.2 mi
const TRUNK_LIGHTS = [392, 322, 262]
const OLD_LIGHTS = [188, 92, 52, 6, -44, -86]
const OLD_SLOW = [172, 110]
const FAST_LIGHTS = [130, -30]

const SAY = ['Scanning for faster route', 'Faster route found', 'Confirmed twice', 'Switching · saves 8 min', 'On faster route · saved 8 min']

function Drive({ s }: { s: Scene }) {
  const r = TRIP[s.route]
  const turning = s.route === 'fast'
  const live = s.banner > 0
  const old = s.route === 'slow' ? 'on' : live ? 'left' : 'gone'
  const fast = s.route === 'fast' ? 'on' : live ? 'found' : 'hidden'
  const checks = s.banner >= 2 ? 2 : s.banner
  return (
    <div className="rq-screen vx vx-drive" data-live={live || undefined} data-new={s.banner >= 3 || undefined} data-cover={s.cover || undefined}>
      <div className="rq-body">
      <Hatch />
      <div className="vx-ann">
        <span className="vx-ann__icon">
          <States
            value={s.banner === 3 ? 'voice' : s.banner === 4 ? 'done' : 'scan'}
            states={{ scan: <ScanLine size={24} strokeWidth={2.2} />, voice: <Volume2 size={24} strokeWidth={2.2} />, done: <Check size={24} strokeWidth={2.8} /> }}
          />
        </span>
        <span className="vx-ann__text">
          <States align="start" value={String(s.banner)} states={Object.fromEntries(SAY.map((t, i) => [String(i), t]))} />
        </span>
        <span className="vx-ann__checks" aria-label={`${checks} of 2 checks`}>
          <i data-on={checks >= 1 || undefined} />
          <i data-on={checks >= 2 || undefined} />
        </span>
      </div>

      <div className="vx-tape">
        <svg width={84} height={580} viewBox="0 0 84 580" aria-hidden>
          <g className="vx-run" data-go={s.go || undefined} style={{ transitionDuration: s.go ? `${TRAVEL}ms` : '0ms' }}>
            {TICKS.map((i) => {
              const y = YOU - (i * PX) / 10
              const major = i % 5 === 0
              return (
                <g key={i}>
                  <line x1={major ? 4 : 26} x2={X0} y1={y} y2={y} className="vx-tape__tick" />
                  {major && i > 0 && (
                    <text x={4} y={y - 7} className="vx-tape__num">
                      {(i / 10).toFixed(1)}
                    </text>
                  )}
                </g>
              )
            })}
            <g className="vx-old" data-state={old}>
              <line x1={X0} x2={X0} y1={TURN} y2={-200} className="vx-tape__road" />
              <rect x={X0 - 7} y={OLD_SLOW[1]} width={14} height={OLD_SLOW[0] - OLD_SLOW[1]} className="vx-tape__slowbg" />
              <rect x={X0 - 7} y={OLD_SLOW[1]} width={14} height={OLD_SLOW[0] - OLD_SLOW[1]} fill="url(#vx-hatch)" className="vx-tape__slow" />
              {OLD_LIGHTS.map((y) => (
                <circle key={y} cx={X0} cy={y} r={6.5} className="vx-tape__light" />
              ))}
            </g>
            <line x1={X0} x2={X0} y1={900} y2={TURN} className="vx-tape__road" />
            <g className="vx-fast" data-state={fast}>
              <path d={`M ${X0} ${TURN} L ${X1} ${TURN - 28} V -200`} pathLength={1} className="vx-tape__road vx-fast__line" />
              {FAST_LIGHTS.map((y) => (
                <circle key={y} cx={X1} cy={y} r={6.5} className="vx-tape__light" />
              ))}
            </g>
            {TRUNK_LIGHTS.map((y) => (
              <circle key={y} cx={X0} cy={y} r={6.5} className="vx-tape__light" />
            ))}
            <g className="vx-mark" data-show={turning || undefined}>
              <line x1={X0 - 16} x2={84} y1={TURN} y2={TURN} className="vx-mark__line" />
              <rect x={X0 - 6} y={TURN - 6} width={12} height={12} transform={`rotate(45 ${X0} ${TURN})`} className="vx-mark__dot" />
            </g>
          </g>
          <path d={`M ${X0} ${YOU - 16} L ${X0 + 15} ${YOU + 12} L ${X0} ${YOU + 5} L ${X0 - 15} ${YOU + 12} Z`} className="vx-you" />
        </svg>
      </div>

      <div className="vx-main">
        <div className="vx-next">
          <div className="vx-next__top">
            <span className="vx-lab">Next turn</span>
            <span className="vx-next__arrow">
              <States value={turning ? 'turn' : 'up'} states={{ up: <ArrowUp size={56} strokeWidth={2.4} />, turn: <CornerUpRight size={56} strokeWidth={2.4} /> }} />
            </span>
          </div>
          <div className="vx-next__body">
            <div className="vx-next__layer" data-show={!turning || undefined}>
              <div className="vx-next__straight">Straight</div>
              <div className="vx-next__road">No turn ahead</div>
            </div>
            <div className="vx-next__layer" data-show={turning || undefined}>
              <div className="vx-next__dist">
                <Count value={s.dist} format={fmtDist} duration={520} />
                <span className="u">mi</span>
              </div>
              <div className="vx-next__road">{TRIP.turn.road}</div>
            </div>
          </div>
        </div>

        <div className="vx-cells">
          <div className="vx-cell" data-hot>
            <span className="vx-lab">ETA</span>
            <div className="vx-fig vx-fig--cell">
              <Count value={r.min} />
            </div>
            <span className="vx-lab">min</span>
          </div>
          <div className="vx-cell" data-hot>
            <span className="vx-lab">Lights</span>
            <div className="vx-fig vx-fig--cell">
              <Count value={r.lights} />
            </div>
            <span className="vx-lab">to go</span>
          </div>
          <div className="vx-cell" data-hot>
            <span className="vx-lab">Dist</span>
            <div className="vx-fig vx-fig--cell">
              <Count value={r.mi} />
            </div>
            <span className="vx-lab">mi</span>
          </div>
        </div>

        <div className="vx-rows">
          <div className="vx-row">
            <span className="vx-lab">Arrive</span>
            <span className="vx-row__val">
              <States align="end" value={s.route} states={{ slow: TRIP.arrive.slow, fast: TRIP.arrive.fast }} />
            </span>
          </div>
          <div className="vx-row">
            <span className="vx-lab">Auto-switch</span>
            <span className="vx-row__val">Armed</span>
          </div>
          <div className="vx-row">
            <span className="vx-lab">Voice</span>
            <span className="vx-row__val">On</span>
          </div>
        </div>
      </div>

      <div className="vx-ctrl">
        <span className="vx-btn">
          <Volume2 size={24} strokeWidth={2.2} />
          Mute
        </span>
        <span className="vx-btn">
          <X size={24} strokeWidth={2.4} />
          End
        </span>
      </div>
      </div>
    </div>
  )
}

export const vector: Direction = {
  id: 'vector',
  name: 'Vector',
  idea: 'A bold instrument: black glass, condensed cockpit numerals, one amber signal, and the road as a distance tape.',
  palette: 'True black #050607, white #F2F4F6, one amber signal #FFB000',
  type: 'Barlow Condensed figures, IBM Plex Mono labels',
  dark: true,
  ground: '#050607',
  Pick,
  Drive,
}
