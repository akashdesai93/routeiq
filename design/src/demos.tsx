import type { FC, ReactNode } from 'react'
import { Stage, Phone } from '../kit'
import { DRIVE, START, SWITCH, script, type Scene } from './scene'
import type { Direction } from './dirs/types'
import { clearway } from './dirs/clearway'
import { noodle } from './dirs/noodle'
import { vector } from './dirs/vector'
import { MERGED_DEMOS } from './merged/demos'
import './demos.css'

export const DIRECTIONS: Direction[] = [clearway, noodle, vector]

// One phone, whole, at true iOS points (428 wide draws the screen 1:1).
// `unframed` because this is a design review, not a marketing crop: the owner
// asked to see each screen whole.
const ONE = { w: 488, h: 960, phone: 428 }

// `under` is the loop's opening frame, held beneath the live screen for the reset's cross-fade
function Shot({ d, w, under, children }: { d: Direction; w: number; under?: ReactNode; children: ReactNode }) {
  return (
    <Phone width={w} dark={d.dark} wallpaper={d.ground} className={`rq-phone rq-${d.id}`}>
      {under && <div className="rq-under">{under}</div>}
      {children}
    </Phone>
  )
}

const pick = (d: Direction): FC => () => (
  <Stage width={ONE.w} height={ONE.h} unframed className="rq-one">
    {() => (
      <Shot d={d} w={ONE.phone}>
        <d.Pick />
      </Shot>
    )}
  </Stage>
)

const still = (d: Direction, scene: Scene): FC => () => (
  <Stage<Scene> width={ONE.w} height={ONE.h} unframed initial={scene} className="rq-one">
    {(s) => (
      <Shot d={d} w={ONE.phone}>
        <d.Drive s={s} />
      </Shot>
    )}
  </Stage>
)

const loop = (d: Direction): FC => () => (
  <Stage<Scene> width={ONE.w} height={ONE.h} unframed initial={START} poster={SWITCH} script={script} className="rq-one">
    {(s) => (
      <Shot d={d} w={ONE.phone} under={<d.Drive s={START} />}>
        <d.Drive s={s} />
      </Shot>
    )}
  </Stage>
)

// The comparison: the three directions side by side on the hero moment,
// running the same script in step.
const CMP = { w: 1260, h: 940, phone: 348 }

function Label({ d, n }: { d: Direction; n: number }) {
  return (
    <div className="rq-label">
      <div className="rq-label__name">
        <span className="rq-label__n">{n}</span>
        {d.name}
      </div>
      <div className="rq-label__idea">{d.idea}</div>
    </div>
  )
}

const Compare: FC = () => (
  <Stage<Scene> width={CMP.w} height={CMP.h} unframed specimen initial={START} poster={SWITCH} script={script} className="rq-cmp">
    {(s) => (
      <div className="rq-cmp__row">
        {DIRECTIONS.map((d, i) => (
          <div key={d.id} className="rq-cmp__col">
            <Label d={d} n={i + 1} />
            <Shot d={d} w={CMP.phone} under={<d.Drive s={START} />}>
              <d.Drive s={s} />
            </Shot>
          </div>
        ))}
      </div>
    )}
  </Stage>
)

// Every screen of every direction on one sheet: rows are directions, columns
// are Pick a route, Driving, The switch.
const ALL = { w: 1260, h: 2700, phone: 348 }
const COLS = ['Pick a route', 'Driving', 'The automatic switch']

const CompareAll: FC = () => (
  <Stage width={ALL.w} height={ALL.h} unframed specimen className="rq-all">
    {() => (
      <div className="rq-all__grid">
        {DIRECTIONS.map((d, i) => (
          <div key={d.id} className="rq-all__band">
            <Label d={d} n={i + 1} />
            <div className="rq-cmp__row">
              {[<d.Pick />, <d.Drive s={DRIVE} />, <d.Drive s={SWITCH} />].map((screen, c) => (
                <div key={c} className="rq-cmp__col">
                  <Shot d={d} w={ALL.phone}>
                    {screen}
                  </Shot>
                  <div className="rq-all__cap">{COLS[c]}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    )}
  </Stage>
)

export const DEMOS: Record<string, FC> = { compare: Compare, 'compare-all': CompareAll }
for (const d of DIRECTIONS) {
  DEMOS[`${d.id}-pick`] = pick(d)
  DEMOS[`${d.id}-drive`] = still(d, DRIVE)
  DEMOS[`${d.id}-switch`] = still(d, SWITCH)
  DEMOS[`${d.id}-loop`] = loop(d)
}

// The direction the owner chose (src/merged)
Object.assign(DEMOS, MERGED_DEMOS)
