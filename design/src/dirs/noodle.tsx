import '@fontsource-variable/bricolage-grotesque'
import { ArrowRight, ArrowUp, Check, CornerUpRight, Navigation2, Volume2, X } from 'lucide-react'
import { Count, States } from '../../kit'
import { LIGHTS_FAST, LIGHTS_SLOW, SLOW_FAST, SLOW_SLOW, TRIP } from '../trip'
import { TRAVEL, fmtDist, type Scene } from '../scene'
import type { Direction } from './types'
import './noodle.css'

// 2 · Noodle. Playful and tactile: the route is a fat noodle and every
// traffic light is a bead on it, so "fewer lights" is something you can count.
// Cream, plum and coral; one friendly voice in the copy.

type P = [number, number]

/** A soft path through points (vertical S-curves), with a way to find a point
 * or cut a piece by how far along it is, 0 to 1. */
function soft(pts: P[]) {
  const samples: P[] = [pts[0]]
  let d = `M ${pts[0][0]} ${pts[0][1]}`
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1]
    const [x1, y1] = pts[i]
    const m = (y0 + y1) / 2
    d += ` C ${x0} ${m} ${x1} ${m} ${x1} ${y1}`
    for (let k = 1; k <= 48; k++) {
      const t = k / 48
      const u = 1 - t
      samples.push([u * u * u * x0 + 3 * u * u * t * x0 + 3 * u * t * t * x1 + t * t * t * x1, u * u * u * y0 + 3 * u * u * t * m + 3 * u * t * t * m + t * t * t * y1])
    }
  }
  const cum = [0]
  for (let i = 1; i < samples.length; i++) cum.push(cum[i - 1] + Math.hypot(samples[i][0] - samples[i - 1][0], samples[i][1] - samples[i - 1][1]))
  const len = cum[cum.length - 1]
  const at = (t: number): P => {
    const want = t * len
    let i = 1
    while (i < cum.length - 1 && cum[i] < want) i++
    const f = (want - cum[i - 1]) / (cum[i] - cum[i - 1] || 1)
    return [samples[i - 1][0] + (samples[i][0] - samples[i - 1][0]) * f, samples[i - 1][1] + (samples[i][1] - samples[i - 1][1]) * f]
  }
  const cut = (a: number, b: number) => {
    const out: P[] = [at(a)]
    samples.forEach((p, i) => cum[i] > a * len && cum[i] < b * len && out.push(p))
    out.push(at(b))
    return 'M ' + out.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L ')
  }
  return { d, at, cut }
}

function Stripes() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
      <defs>
        <pattern id="nd-stripes" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="4" height="9" fill="#2a1a3c" />
        </pattern>
      </defs>
    </svg>
  )
}

// Pick a route: the two routes stand side by side, bottom (you) to top (there)
const A = soft([[87, 250], [52, 190], [118, 128], [58, 66], [87, 12]])
const B = soft([[87, 250], [124, 196], [50, 150], [126, 100], [54, 54], [87, 12]])

function Column({ n, lights, slow }: { n: ReturnType<typeof soft>; lights: number[]; slow: [number, number][] }) {
  return (
    <svg className="nd-col" width={174} height={262} viewBox="0 0 174 262" aria-hidden>
      <path d={n.d} className="nd-col__road" />
      {slow.map(([a, b]) => (
        <path key={a} d={n.cut(a, b)} className="nd-col__slow" />
      ))}
      {lights.map((t) => {
        const [x, y] = n.at(t)
        return <circle key={t} cx={x} cy={y} r={3.4} className="nd-col__bead" />
      })}
    </svg>
  )
}

function Pick() {
  const { fast, slow } = TRIP
  return (
    <div className="rq-screen nd nd-pick">
      <Stripes />
      <div className="nd-head">
        <div className="nd-head__from">{TRIP.from} to</div>
        <div className="nd-head__to">{TRIP.to}</div>
      </div>
      <div className="nd-cols">
        <div className="nd-card" data-on>
          <div className="nd-sticker">
            <Check size={16} strokeWidth={3.4} />
            {fast.tag}
          </div>
          <Column n={A} lights={LIGHTS_FAST} slow={SLOW_FAST} />
          <div className="nd-card__text">
            <div className="nd-card__time">
              {fast.min}
              <span className="u">min</span>
            </div>
            <div className="nd-card__meta">
              {fast.lights} lights · {fast.mi} mi
            </div>
          </div>
        </div>
        <div className="nd-card">
          <div className="nd-sticker nd-sticker--plain">{slow.tag}</div>
          <Column n={B} lights={LIGHTS_SLOW} slow={SLOW_SLOW} />
          <div className="nd-card__text">
            <div className="nd-card__time">
              {slow.min}
              <span className="u">min</span>
            </div>
            <div className="nd-card__meta">
              {slow.lights} lights · {slow.mi} mi
            </div>
          </div>
        </div>
      </div>
      <div className="nd-key">
        <span className="nd-key__bead" />
        <span>one bead, one traffic light</span>
        <span className="nd-key__slow" />
        <span>slow bit</span>
      </div>
      <div className="nd-foot">
        <div className="nd-note">If a quicker way holds up mid-drive, I’ll swap you over. No taps.</div>
        <div className="nd-go">
          Let’s roll
          <ArrowRight size={26} strokeWidth={2.8} />
        </div>
      </div>
    </div>
  )
}

// Driving. You sit on a straight piece of noodle; the road slides down under
// you. At the turn the faster route swings right; the old one wanders off left.
const YOU: P = [112, 648]
const TURN: P = [112, 548]
const TRUNK = `M 112 772 L ${TURN[0]} ${TURN[1]}`
const FAST = soft([TURN, [292, 424], [150, 306], [300, 190], [300, 108]])
const OLD = soft([TURN, [46, 440], [86, 316], [44, 200], [44, 108]])
const FAST_BEADS = [0.3, 0.68]
const OLD_BEADS = [0.1, 0.2, 0.52, 0.62, 0.72]
const OLD_SLOW: [number, number] = [0.28, 0.46]

const TITLES = ['', 'Ooh, a quicker way', 'Yep, it holds', 'Swapping you over', 'Done. You’re on it']
const SUBS = ['', 'Double-checking · 1 of 2', 'Checked twice · 2 of 2', '8 minutes back in your pocket', '2 fewer lights, zero taps']

/** Which of the two checks this is, drawn as the disc's own glyph */
function Num({ n }: { n: number }) {
  return (
    <svg className="nd-pop__disc" width={48} height={48} viewBox="0 0 24 24" aria-hidden>
      <text x={12} y={20.5} textAnchor="middle" className="nd-pop__n">
        {n}
      </text>
    </svg>
  )
}

function Drive({ s }: { s: Scene }) {
  const r = TRIP[s.route]
  const turning = s.route === 'fast'
  const live = s.banner > 0
  const old = s.route === 'slow' ? 'on' : live ? 'left' : 'gone'
  const fast = s.route === 'fast' ? 'on' : live ? 'found' : 'hidden'
  // The sticker keeps its last words while it leaves
  const say = s.banner || 4
  const slowAt = OLD.at((OLD_SLOW[0] + OLD_SLOW[1]) / 2)
  return (
    <div className="rq-screen nd nd-drive" data-cover={s.cover || undefined}>
      <div className="rq-body">
      <Stripes />
      <svg className="nd-map" width={402} height={874} viewBox="0 0 402 874" aria-hidden>
        <g className="nd-road" data-go={s.go || undefined} style={{ transitionDuration: s.go ? `${TRAVEL}ms` : '0ms' }}>
          <g className="nd-old" data-state={old}>
            <path d={OLD.d} className="nd-road__line" />
            <path d={OLD.cut(...OLD_SLOW)} className="nd-road__slow" />
            {OLD_BEADS.map((t) => {
              const [x, y] = OLD.at(t)
              return <circle key={t} cx={x} cy={y} r={9} className="nd-road__bead" />
            })}
          </g>
          <g className="nd-fast" data-state={fast}>
            <path d={FAST.d} pathLength={1} className="nd-road__line nd-fast__line" />
            {FAST_BEADS.map((t) => {
              const [x, y] = FAST.at(t)
              return <circle key={t} cx={x} cy={y} r={9} className="nd-road__bead" />
            })}
          </g>
          <path d={TRUNK} className="nd-road__line" />
        </g>
      </svg>
      <div className="nd-road nd-road--tags" data-go={s.go || undefined} style={{ transitionDuration: s.go ? `${TRAVEL}ms` : '0ms' }}>
        <div className="nd-tag" data-state={old} style={{ left: slowAt[0] + 34, top: slowAt[1] - 16 }}>
          slow bit
        </div>
      </div>

      <div className="nd-you" style={{ left: YOU[0], top: YOU[1] }}>
        <Navigation2 size={30} strokeWidth={2.6} fill="currentColor" />
      </div>
      <div className="nd-left">
        <span className="nd-left__bead" />
        <span>
          <Count value={r.lights} /> lights to go
        </span>
      </div>

      <div className="nd-turn">
        <span className="nd-turn__icon">
          <States value={turning ? 'turn' : 'up'} states={{ up: <ArrowUp size={46} strokeWidth={2.8} />, turn: <CornerUpRight size={46} strokeWidth={2.8} /> }} />
        </span>
        <div className="nd-turn__text">
          <div className="nd-turn__layer" data-show={!turning || undefined}>
            <div className="nd-turn__big">Straight on</div>
            <div className="nd-turn__road">Cruise for a bit</div>
          </div>
          <div className="nd-turn__layer" data-show={turning || undefined}>
            <div className="nd-turn__big">
              <Count value={s.dist} format={fmtDist} duration={520} />
              <span className="u">mi</span>
            </div>
            <div className="nd-turn__road">{TRIP.turn.road}</div>
          </div>
        </div>
      </div>

      <div className="nd-pop" data-show={live || undefined}>
        <span className="nd-pop__icon">
          <States
            value={say === 3 ? 'voice' : say === 4 ? 'done' : say === 2 ? 'two' : 'one'}
            states={{
              one: <Num n={1} />,
              two: <Num n={2} />,
              voice: <Volume2 className="nd-pop__disc" size={48} strokeWidth={2.6} />,
              done: <Check className="nd-pop__disc" size={48} strokeWidth={3.2} />,
            }}
          />
        </span>
        <span className="nd-pop__text">
          <span className="nd-pop__title">
            <States align="start" value={String(say)} states={Object.fromEntries([1, 2, 3, 4].map((i) => [String(i), TITLES[i]]))} />
          </span>
          <span className="nd-pop__sub">
            <States align="start" value={String(say)} states={Object.fromEntries([1, 2, 3, 4].map((i) => [String(i), SUBS[i]]))} />
          </span>
        </span>
      </div>

      <div className="nd-bar">
        <div className="nd-bar__eta">
          <div className="nd-bar__time">
            <Count value={r.min} />
            <span className="u">min</span>
          </div>
          <div className="nd-bar__meta">
            <span>
              <Count value={r.mi} /> mi · there by
            </span>
            <States align="start" value={s.route} states={{ slow: TRIP.arrive.slow, fast: TRIP.arrive.fast }} />
          </div>
        </div>
        <span className="nd-btn" aria-label="Mute voice">
          <Volume2 size={28} strokeWidth={2.4} />
        </span>
        <span className="nd-btn nd-btn--end" aria-label="End trip">
          <X size={30} strokeWidth={2.8} />
        </span>
      </div>
      </div>
    </div>
  )
}

export const noodle: Direction = {
  id: 'noodle',
  name: 'Noodle',
  idea: 'Playful and tactile: the route is a fat noodle, every traffic light is a bead on it, and the app talks like a friend.',
  palette: 'Cream #FFF3DC, plum #2A1A3C, coral #FF5A36, sunny yellow #FFC83A',
  type: 'Bricolage Grotesque, heavy and round',
  dark: false,
  ground: '#FFF3DC',
  Pick,
  Drive,
}
