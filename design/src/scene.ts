import type { Act } from '../kit'

// One scene state drives the driving screen in every direction.
//  route   which route the driver is on
//  banner  0 quiet · 1 faster route spotted (check 1 of 2) · 2 confirmed twice
//          3 switching (voice announces) · 4 settled on the new route
//  dist    miles to the turn-off
//  go      the road is moving (one long linear transition per loop)
//  cover   the screen is dipped to its own ground while the loop resets
export type Scene = { route: 'slow' | 'fast'; banner: 0 | 1 | 2 | 3 | 4; dist: number; go: boolean; cover: boolean }

export const START: Scene = { route: 'slow', banner: 0, dist: 0.8, go: false, cover: false }
export const DRIVE: Scene = { route: 'fast', banner: 0, dist: 0.8, go: false, cover: false }
export const SWITCH: Scene = { route: 'fast', banner: 3, dist: 0.8, go: false, cover: false }

// Length of the road's travel, in ms: the CSS transition on each strip uses it
export const TRAVEL = 8200

// The hero moment, about 9 seconds: driving → spotted → confirmed twice →
// switch (route redraws, ETA rolls) → miles to the turn count down → settled.
export const script = async (a: Act<Scene>) => {
  a.mark('start')
  // The stage places its first paint with transitions off; start the road after
  await a.wait(360)
  a.put({ go: true })
  await a.wait(900)
  a.mark('found')
  a.put({ banner: 1 })
  await a.wait(1000)
  a.put({ banner: 2 })
  await a.wait(800)
  a.mark('switch')
  a.put({ banner: 3, route: 'fast' })
  await a.wait(1100)
  a.put({ dist: 0.7 })
  await a.wait(800)
  a.put({ dist: 0.6 })
  await a.wait(800)
  a.put({ dist: 0.5 })
  await a.wait(500)
  a.mark('settled')
  a.put({ banner: 4 })
  await a.wait(1900)
  a.mark('reset')
  // Cross-fade into the opening frame held underneath, then swap unseen
  a.put({ cover: true })
  await a.wait(460)
  // Hidden under the cover: put the trip back to its opening picture
  await a.snap({ ...START, cover: true })
  a.put({ cover: false })
  await a.wait(160)
}

// Ten miles and over reads as whole miles, under ten with one decimal
export const fmtDist = (d: number) => (d >= 10 ? String(Math.round(d)) : d.toFixed(1))


// ---------------------------------------------------------------------------
// The merged direction (issues #21, #22). The three explorations above showed
// "saves 8 minutes" beside an ETA that read 35 min before and after in their
// stills. Here the numbers add up: the driver is on the 43 min route, a faster
// one is found (pending), it holds and the app switches (confirmed), and the
// screen shows 43 -> 35 min and 10:24 -> 10:16 while it does.
//  stage   drive      nothing to say
//          pending    a faster route is found and being checked: hollow amber
//                     marker at the turn-off, "Keep my route" offered
//          confirmed  it held twice: the app switches and says so, in the same
//                     words it speaks; "Keep my route" still offered
//          done       settled on the new route
//          declined   the driver pressed Keep my route: the route stays, the app
//                     says so, and that route is not offered again for 10 min
//                     (the engine's noReturnSec = 600) unless the saving doubles
export type MStage = 'drive' | 'pending' | 'confirmed' | 'done' | 'declined'
export type MScene = { route: 'slow' | 'fast'; stage: MStage; dist: number; go: boolean; cover: boolean; more: boolean; again?: boolean }

export const M_START: MScene = { route: 'slow', stage: 'drive', dist: 0.8, go: false, cover: false, more: false }
export const M_DRIVE: MScene = { ...M_START, route: 'fast' }
export const M_PENDING: MScene = { ...M_START, stage: 'pending' }
export const M_CONFIRMED: MScene = { ...M_START, route: 'fast', stage: 'confirmed' }
export const M_MORE: MScene = { ...M_DRIVE, more: true }
export const M_DECLINED: MScene = { ...M_START, stage: 'declined' }
/** The no-return window has passed and the same route is still faster: it is a new offer */
export const M_AGAIN: MScene = { ...M_START, stage: 'pending', again: true }

/** How long a declined route stays unoffered, in minutes (noReturnSec / 60) */
export const NO_RETURN_MIN = 10
export const SPOKEN_KEEP = 'Staying on your route.'

/** The engine's spoken sentence; the banner shows exactly these words. */
export const spoken = (saves: number, miles: number) => `Switching: saves ${saves} minutes, turn in ${miles.toFixed(1)} miles.`

export const mergedScript = async (a: Act<MScene>) => {
  a.mark('start')
  await a.wait(360)
  a.put({ go: true })
  await a.wait(900)
  a.mark('pending')
  a.put({ stage: 'pending' })
  await a.wait(2100)
  a.mark('confirmed')
  a.put({ stage: 'confirmed', route: 'fast' })
  // The spoken sentence names 0.8 miles, so the turn card holds 0.8 while it shows
  await a.wait(2700)
  a.mark('done')
  a.put({ stage: 'done' })
  await a.wait(600)
  a.put({ dist: 0.7 })
  await a.wait(900)
  a.put({ dist: 0.6 })
  await a.wait(900)
  a.mark('reset')
  // Cross-fade into the opening frame held underneath, then swap unseen
  a.put({ cover: true })
  await a.wait(460)
  await a.snap({ ...M_START, cover: true })
  a.put({ cover: false })
  await a.wait(160)
}

// The alternate ending (#43): the switch is announced, the driver presses Keep
// my route, the app goes back to the route they were on and says so.
export const keepScript = async (a: Act<MScene>) => {
  a.mark('start')
  await a.wait(360)
  a.put({ go: true })
  await a.wait(900)
  a.mark('pending')
  a.put({ stage: 'pending' })
  await a.wait(1900)
  a.mark('confirmed')
  a.put({ stage: 'confirmed', route: 'fast' })
  await a.wait(1500)
  a.mark('keep')
  await a.click('keep')
  a.put({ stage: 'declined', route: 'slow' })
  await a.wait(2700)
  a.mark('done')
  a.put({ stage: 'drive' })
  await a.wait(1300)
  a.mark('reset')
  // Cross-fade into the opening frame held underneath, then swap unseen
  a.put({ cover: true })
  await a.wait(460)
  await a.snap({ ...M_START, cover: true })
  a.put({ cover: false })
  await a.wait(160)
}
