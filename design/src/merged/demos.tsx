import type { FC, ReactNode } from 'react'
import { Stage, Phone } from '../../kit'
import { M_AGAIN, M_CONFIRMED, M_DECLINED, M_DRIVE, M_MORE, M_PENDING, M_START, keepScript, mergedScript, type MScene } from '../scene'
import { TRIP } from '../trip'
import { Delta, Drive, LightsTile, Pick, Plan, RouteCard, TurnCard, type Signals } from './index'
import './demos.css'

const NIGHT = '#0d1014'
const DAY = '#e3e6ea'
const ONE = { w: 488, h: 960, phone: 428 }

function Shot({ w, day, under, children }: { w: number; day?: boolean; under?: ReactNode; children: ReactNode }) {
  return (
    <Phone width={w} dark={!day} wallpaper={day ? DAY : NIGHT} className="rq-phone">
      {under && <div className="rq-under">{under}</div>}
      {children}
    </Phone>
  )
}

const one = (screen: ReactNode, day?: boolean): FC => () => (
  <Stage width={ONE.w} height={ONE.h} unframed className="rq-one">
    {() => (
      <Shot w={ONE.phone} day={day}>
        {screen}
      </Shot>
    )}
  </Stage>
)

const Loop: FC = () => (
  <Stage<MScene> width={ONE.w} height={ONE.h} unframed initial={M_START} poster={M_CONFIRMED} script={mergedScript} className="rq-one">
    {(s) => (
      <Shot w={ONE.phone} under={<Drive s={M_START} />}>
        <Drive s={s} />
      </Shot>
    )}
  </Stage>
)

// #43: the same loop, ending with Keep my route pressed
const KeepLoop: FC = () => (
  <Stage<MScene> width={ONE.w} height={ONE.h} unframed initial={M_START} poster={M_DECLINED} script={keepScript} cursor={{ at: { x: 420, y: 760 }, style: 'touch' }} className="rq-one">
    {(s) => (
      <Shot w={ONE.phone} under={<Drive s={M_START} />}>
        <Drive s={s} />
      </Shot>
    )}
  </Stage>
)

const SHEET = { w: 1700, h: 3160, phone: 348 }

// The three signal states, as the route card, the delta row and the More tile show them
const STATES: { id: Signals; name: string; when: string }[] = [
  { id: 'full', name: 'Full', when: 'Every signal on the route is known.' },
  { id: 'partial', name: 'Partial', when: 'Some stretches have no signal data: a floor, never a guess.' },
  { id: 'unknown', name: 'Unknown', when: 'No signal data at all: say so, never 0.' },
]

function SignalStates() {
  return (
    <div className="mgx-signals mg">
      {STATES.map((st) => (
        <div key={st.id} className="mgx-signals__col">
          <div className="mgx-signals__name">{st.name}</div>
          <div className="mgx-signals__when">{st.when}</div>
          <RouteCard on min={TRIP.fast.min} mi={TRIP.fast.mi} lights={TRIP.fast.lights} signals={st.id} tag={TRIP.fast.tag} />
          <Delta signals={st.id} />
          <div className="mgx-signals__tile">
            <LightsTile signals={st.id} n={TRIP.fast.lights} />
          </div>
        </div>
      ))}
    </div>
  )
}

const Signals_: FC = () => (
  <Stage width={1260} height={520} unframed specimen className="rq-one mgx-stage">
    {() => <SignalStates />}
  </Stage>
)

// #44: the three signal states while driving. The More tile and the pending
// banner are the only driving surfaces that mention lights.
const DRIVING_SIGNALS: FC = () => (
  <Stage width={1300} height={1760} unframed specimen className="rq-all mgx-sheet">
    {() => (
      <div className="mgx-sheet__grid mgx-sheet__grid--tight">
        {[M_MORE, M_PENDING].map((scene, r) => (
          <div key={r} className="mgx-sheet__row">
            {STATES.map((st) => (
              <div key={st.id} className="mgx-sheet__col">
                <Shot w={SHEET.phone}>
                  <Drive s={scene} signals={st.id} />
                </Shot>
                <div className="mgx-sheet__cap">
                  {st.name} · {r === 0 ? 'More sheet' : 'pending switch'}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    )}
  </Stage>
)

// #45: what the turn card says, and what the voice says with it
const CARDS: { when: string; turn?: boolean; dist: number; line: string; voice: string }[] = [
  { when: 'No turn soon, road name not known', dist: TRIP.straight.dist, line: 'Continue straight', voice: 'Continue for 12 miles.' },
  { when: 'No turn soon, road name known', dist: TRIP.straight.dist, line: `Continue on ${TRIP.turn.road}`, voice: 'Continue on Johnston Road for 12 miles.' },
  { when: 'A turn ahead', turn: true, dist: TRIP.turn.dist, line: TRIP.turn.road, voice: 'In 0.8 miles, turn right onto Johnston Road.' },
]

const TurnCards: FC = () => (
  <Stage width={1300} height={330} unframed specimen className="rq-one mgx-stage">
    {() => (
      <div className="mgx-cards mg">
        {CARDS.map((c) => (
          <div key={c.when} className="mgx-cards__col">
            <div className="mgx-signals__when">{c.when}</div>
            <TurnCard turn={c.turn} dist={c.dist} line={c.line} />
            <div className="mgx-cards__voice">Voice: “{c.voice}”</div>
          </div>
        ))}
      </div>
    )}
  </Stage>
)

// Everything on one sheet
const ROWS: [string, ReactNode, boolean?][][] = [
  [
    ['Plan', <Plan />],
    ['Pick a route', <Pick />],
    ['Driving', <Drive s={M_DRIVE} />],
    ['More, behind a tap', <Drive s={M_MORE} />],
  ],
  [
    ['Switch, pending', <Drive s={M_PENDING} />],
    ['Switch, confirmed', <Drive s={M_CONFIRMED} />],
    ['Driving in daylight', <Drive s={M_DRIVE} day />, true],
    ['Switch in daylight', <Drive s={M_CONFIRMED} day />, true],
  ],
  [
    ['No turn soon (#45)', <Drive s={M_START} />],
    ['Keep my route pressed (#43)', <Drive s={M_DECLINED} />],
    ['Offered again after 10 min (#43)', <Drive s={M_AGAIN} />],
    ['Partial light data, pending (#44)', <Drive s={M_PENDING} signals="partial" />],
  ],
]

const Compare: FC = () => (
  <Stage width={SHEET.w} height={SHEET.h} unframed specimen className="rq-all mgx-sheet">
    {() => (
      <div className="mgx-sheet__grid">
        <div className="mgx-sheet__head">
          <div className="mgx-sheet__title">RouteIQ · the merged direction</div>
          <div className="mgx-sheet__sub">Black glass and condensed numerals over the real map, one amber for news, plain sentences.</div>
        </div>
        {ROWS.map((row, i) => (
          <div key={i} className="mgx-sheet__row">
            {row.map(([label, screen, day]) => (
              <div key={label} className="mgx-sheet__col">
                <Shot w={SHEET.phone} day={day}>
                  {screen}
                </Shot>
                <div className="mgx-sheet__cap">{label}</div>
              </div>
            ))}
          </div>
        ))}
        <div className="mgx-sheet__band">
          <div className="mgx-sheet__cap">Traffic-light data: the three states</div>
          <SignalStates />
        </div>
      </div>
    )}
  </Stage>
)

export const MERGED_DEMOS: Record<string, FC> = {
  'merged-plan': one(<Plan />),
  'merged-pick': one(<Pick />),
  'merged-drive': one(<Drive s={M_DRIVE} />),
  'merged-more': one(<Drive s={M_MORE} />),
  'merged-switch-pending': one(<Drive s={M_PENDING} />),
  'merged-switch': one(<Drive s={M_CONFIRMED} />),
  'merged-drive-day': one(<Drive s={M_DRIVE} day />, true),
  'merged-switch-day': one(<Drive s={M_CONFIRMED} day />, true),
  'merged-loop': Loop,
  'merged-declined': one(<Drive s={M_DECLINED} />),
  'merged-again': one(<Drive s={M_AGAIN} />),
  'merged-loop-keep': KeepLoop,
  'merged-signals-driving': DRIVING_SIGNALS,
  'merged-turn-cards': TurnCards,
  'merged-straight': one(<Drive s={M_START} />),
  'merged-straight-day': one(<Drive s={M_START} day />, true),
  'merged-partial-pending': one(<Drive s={M_PENDING} signals="partial" />),
  'merged-partial-more': one(<Drive s={M_MORE} signals="partial" />),
  'merged-unknown-more': one(<Drive s={M_MORE} signals="unknown" />),
  'merged-signals': Signals_,
  'merged-compare': Compare,
}
