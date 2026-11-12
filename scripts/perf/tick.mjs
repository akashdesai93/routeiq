// Per-tick cost of a live drive: what runs once a second while driving (docs/performance.md).
//   node scripts/perf/tick.mjs
// A whole 60 km drive is replayed through the pure state machine, one fix and one tick a
// second, on a synthetic 3000-vertex route. Every call is timed on its own.
import { performance } from 'node:perf_hooks'
import {
  alongRouteM,
  armGuidance,
  dueAnnouncement,
  lineFrom,
  LIVE_IDLE,
  liveStep,
  liveView,
  nextTurn,
  trackedRoute,
  trackFix,
} from '../../src/core/index.ts'
import { driveFeatures } from '../../src/map/driveFeatures.ts'
import { parseDirections } from '../../src/providers/mapbox/adapter.ts'
import { bench, fixesAlong, report, summarize, syntheticDirections } from './lib.mjs'

const TICK_BUDGET_MS = 4

const parsed = parseDirections(syntheticDirections())
if (!parsed.ok) throw new Error(parsed.message)
const route = parsed.routes[0]
const fixes = fixesAlong(route.geometry)
const lengthKm = (alongRouteM(route.geometry).at(-1) / 1000).toFixed(1)
console.log(`Route: ${lengthKm} km, ${route.geometry.length} vertices, ${route.guidance.length} maneuvers. Drive: ${fixes.length} fixes at 1 Hz.`)
console.log(`Node ${process.version}, ${process.arch}. Budget: ${TICK_BUDGET_MS} ms per 1 s tick on a desktop CPU (phones are 3 to 5 times slower).`)

// 1. The whole drive through liveStep, with a tick after every fix and no answer to the
//    checks (a check that is never answered keeps one request in flight, so no more go out).
function replay() {
  const fixTimes = []
  const tickTimes = []
  const viewTimes = []
  const overlayTimes = []
  let state = liveStep(LIVE_IDLE, { type: 'start', nowMs: fixes[0].timeMs - 1000, destination: route.geometry.at(-1), route }).state
  for (const fix of fixes) {
    let t0 = performance.now()
    state = liveStep(state, { type: 'fix', nowMs: fix.timeMs, fix }).state
    fixTimes.push(performance.now() - t0)
    if (state.status !== 'driving') break

    t0 = performance.now()
    state = liveStep(state, { type: 'tick', nowMs: fix.timeMs + 500 }).state
    tickTimes.push(performance.now() - t0)

    // What the UI works out from the new state: the view model (useLiveDrive.ts) and the
    // map overlay (App.tsx liveOverlay, then MapView's driveFeatures for setData).
    t0 = performance.now()
    liveView(state, fix.timeMs + 500)
    viewTimes.push(performance.now() - t0)

    t0 = performance.now()
    const ahead = lineFrom(state.route.geometry, state.tracking.alongRouteM)
    const collection = driveFeatures({ car: state.tracking.position, routeAhead: ahead, turn: null })
    JSON.stringify(collection) // setData hands the collection to the map's worker as text
    overlayTimes.push(performance.now() - t0)
  }
  return { fixTimes, tickTimes, viewTimes, overlayTimes, status: state.status }
}
replay() // warm up
const run = replay()
if (run.status !== 'arrived') throw new Error(`The replayed drive ended as "${run.status}", not arrived.`)

// 2. The same pieces on their own, at the start of the route (the longest remaining line).
const tracked = trackedRoute(route.geometry)
let tracking = null
const trackRows = bench('trackFix (one fix, 3000-vertex route)', (fix) => { tracking = trackFix(tracking, tracked, fix) }, {
  samples: fixes.length - 40,
  warmup: 30,
  setup: (i) => fixes[i],
})
const cursor = armGuidance(route.guidance, 0, true)
const rows = [
  { name: "liveStep 'fix' (tracking + guidance + poll gate)", ...summarize(run.fixTimes) },
  { name: "liveStep 'tick' (banners + poll gate)", ...summarize(run.tickTimes) },
  trackRows,
  bench('dueAnnouncement', () => dueAnnouncement(route.guidance, cursor, 20_000), { batch: 200 }),
  bench('nextTurn', () => nextTurn(route.guidance, 20_000), { batch: 200 }),
  bench('armGuidance', () => armGuidance(route.guidance, 20_000, false), { batch: 200 }),
  { name: 'liveView (the drive view model)', ...summarize(run.viewTimes) },
  { name: 'map overlay: lineFrom + driveFeatures + stringify', ...summarize(run.overlayTimes) },
  bench('lineFrom alone (rest of the route, from 1 km in)', () => lineFrom(route.geometry, 1000)),
]
report('Per-tick work, per call', rows, TICK_BUDGET_MS)

const at = (times, q) => summarize(times)[q]
const total = (q) => at(run.fixTimes, q) + at(run.tickTimes, q) + at(run.viewTimes, q) + at(run.overlayTimes, q)
console.log(`\nOne second of driving (fix + tick + view + overlay): median ${total('medianMs').toFixed(2)} ms, p95 ${total('p95Ms').toFixed(2)} ms.`)

// 3. What one fix allocates: the overlay copies the rest of the route twice.
const ahead = lineFrom(route.geometry, 1000)
const text = JSON.stringify(driveFeatures({ car: ahead[0], routeAhead: ahead, turn: null }))
console.log(`Overlay handed to the map per fix at the start of the drive: ${ahead.length} points, ${(text.length / 1024).toFixed(1)} kB of GeoJSON.`)
