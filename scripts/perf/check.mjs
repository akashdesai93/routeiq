// Per-check cost: what runs when a route answer arrives, once per plan and once every 60 s
// of a drive (docs/performance.md).
//   node scripts/perf/check.mjs
// Synthetic 60 km / 3000-vertex Directions answer with three routes and annotations, and
// the real bundled signal tiles under public/seed/osm-signals. No network.
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import {
  baselineProbe,
  decideReroute,
  findCurrentRoute,
  INITIAL_REROUTE_STATE,
  LIVE_IDLE,
  liveStep,
  mergeProbeRoutes,
  planProbes,
  rankRoutes,
  sameRouteGeometry,
  selectViaPoints,
  signalsOnRoute,
  signalTilesForRoute,
  withSignalCounts,
} from '../../src/core/index.ts'
import { routeFeatures } from '../../src/map/routeFeatures.ts'
import { parseDirections } from '../../src/providers/mapbox/adapter.ts'
import { osmSignalPoints } from '../../src/providers/osm/adapter.ts'
import { bench, fixesAlong, freshFrom, gzipSize, kb, report, summarize, syntheticDirections } from './lib.mjs'

const CHECK_BUDGET_MS = 50
const SEED = new URL('../../public/seed/osm-signals/', import.meta.url)

const body = syntheticDirections()
const text = JSON.stringify(body)
const parsed = parseDirections(body)
if (!parsed.ok) throw new Error(parsed.message)
const routes = parsed.routes
const [a, b, c] = routes

// The signal data of the three routes, from the bundled tiles (a tile without a file has no signals).
const tileIds = [...new Set(routes.flatMap((r) => signalTilesForRoute(r.geometry)))].sort()
const tiles = tileIds.flatMap((id) => {
  try {
    return [JSON.parse(readFileSync(new URL(`${id}.json`, SEED), 'utf8'))]
  } catch {
    return []
  }
})
const data = { primary: osmSignalPoints(tiles), primaryTileIds: new Set(tileIds) }
const counted = withSignalCounts(routes, data)

console.log(`Directions answer: 3 routes x ${a.geometry.length} vertices, ${kb(text.length)} of JSON (${kb(gzipSize(text))} gzipped).`)
console.log(`Signal data: ${tileIds.length} tiles, ${data.primary.length} signal points; counts ${counted.routes.map((r) => r.signalCount).join(', ')}.`)
console.log(`Node ${process.version}, ${process.arch}. Budget: ${CHECK_BUDGET_MS} ms per check on a desktop CPU (phones are 3 to 5 times slower).`)

// A check 2 km into the drive: nearly the whole route is still ahead (the worst case).
const ALONG_M = 2000
const fresh = freshFrom(counted.routes, ALONG_M)
// The same check when the route being driven is NOT among the fresh routes (it gets asked for through via points).
const withoutCurrent = fresh.slice(1)
const observation = (candidates, baseline) => ({ nowSec: 600, route: a, positionAlongM: ALONG_M, speedMps: 15, candidates, baseline })

// The 'routes' event through the state machine: a drive that has just asked for its check.
function drivingState() {
  const fixes = fixesAlong(a.geometry).slice(0, 140)
  let state = liveStep(LIVE_IDLE, { type: 'start', nowMs: fixes[0].timeMs - 1000, destination: a.geometry.at(-1), route: a }).state
  for (const fix of fixes) {
    state = liveStep(state, { type: 'fix', nowMs: fix.timeMs, fix }).state
    if (state.request !== null) return { state, nowMs: fix.timeMs }
  }
  throw new Error('No check became due in the first 140 s.')
}
const asking = drivingState()

const N = { samples: 120, warmup: 15 }
const rows = [
  bench('JSON.parse of the answer', () => JSON.parse(text), N),
  bench('parseDirections (adapter, 3 routes)', () => parseDirections(body), N),
  bench('signalTilesForRoute (3 routes)', () => routes.map((r) => signalTilesForRoute(r.geometry)), N),
  bench('osmSignalPoints (tiles to points)', () => osmSignalPoints(tiles), N),
  bench('withSignalCounts (3 routes)', () => withSignalCounts(routes, data), N),
  bench('signalsOnRoute (1 route)', () => signalsOnRoute(a.geometry, data.primary), N),
  bench('rankRoutes (3 routes)', () => rankRoutes(counted.routes), { batch: 50 }),
  bench('findCurrentRoute (current among 3 fresh)', () => findCurrentRoute(a, ALONG_M, fresh), N),
  bench('findCurrentRoute (current not among them)', () => findCurrentRoute(a, ALONG_M, withoutCurrent), N),
  bench('baselineProbe (current among them: no request)', () => baselineProbe(a, ALONG_M, fresh), N),
  bench('baselineProbe (not among them: via points)', () => baselineProbe(a, ALONG_M, withoutCurrent), N),
  bench('decideReroute (current among 3 fresh)', () => decideReroute(INITIAL_REROUTE_STATE, observation(fresh)), N),
  bench('decideReroute (not among them, with baseline)', () => decideReroute(INITIAL_REROUTE_STATE, observation(withoutCurrent, [fresh[0]])), N),
  bench("liveStep 'routes' (the check's answer)", () => liveStep(asking.state, { type: 'routes', nowMs: asking.nowMs + 800, requestId: asking.state.request.id, routes: fresh }), N),
  bench('routeFeatures + stringify (map setData, 3 routes)', () => JSON.stringify(routeFeatures(fresh, null)), N),
]
report('One check during a drive, per call', rows, CHECK_BUDGET_MS)

// The whole check as src/drive/freshRoutes.ts and the runner do it, without the network.
function wholeCheck(candidatesOf) {
  const times = []
  for (let i = 0; i < 80; i++) {
    const t0 = performance.now()
    const answer = parseDirections(JSON.parse(text))
    const got = candidatesOf(answer.routes)
    baselineProbe(a, ALONG_M, got)
    const ids = [...new Set(answer.routes.flatMap((r) => signalTilesForRoute(r.geometry)))]
    const signalData = { primary: osmSignalPoints(tiles), primaryTileIds: new Set(ids) }
    const withCounts = withSignalCounts(answer.routes, signalData)
    liveStep(asking.state, { type: 'routes', nowMs: asking.nowMs + 800, requestId: asking.state.request.id, routes: got })
    JSON.stringify(routeFeatures(withCounts.routes, null))
    if (i >= 10) times.push(performance.now() - t0)
  }
  return summarize(times)
}
report(
  'The whole check (parse + adapter + baseline + signals + decision + map data)',
  [
    { name: 'current route among the fresh routes', ...wholeCheck(() => fresh) },
    { name: 'current route not among them', ...wholeCheck(() => withoutCurrent) },
  ],
  CHECK_BUDGET_MS,
)

// A plan: the same answer, then the side-street probes.
const probed = [b, c].map((r, i) => ({ ...r, id: `probe-${i}`, geometry: r.geometry.map(([lng, lat]) => [lng + 0.00002, lat]) }))
const planRows = [
  bench('selectViaPoints', () => selectViaPoints(counted.routes), N),
  bench('planProbes (budget of 2)', () => planProbes(counted.routes), N),
  bench('sameRouteGeometry (2 routes of 3000 vertices)', () => sameRouteGeometry(a.geometry, b.geometry), N),
  bench('mergeProbeRoutes (3 routes + 2 probed)', () => mergeProbeRoutes(counted.routes, probed), N),
  bench('mergeProbeRoutes (3 routes + 2 new side streets)', () => mergeProbeRoutes([a], [b, c]), N),
]
report('A plan (once per trip), per call', planRows, CHECK_BUDGET_MS)

// How the de-duplication of probed routes grows with the length of the trip.
const sweep = [[15, 750], [30, 1500], [60, 3000], [120, 6000]].map(([km, vertices]) => {
  const answer = parseDirections(syntheticDirections({ lengthKm: km, vertices }))
  const again = answer.routes.slice(1).map((r, i) => ({ ...r, id: `probe-${i}`, geometry: r.geometry.map(([lng, lat]) => [lng + 0.00002, lat]) }))
  return bench(`mergeProbeRoutes, ${km} km / ${vertices} vertices, 2 probes back on known routes`, () => mergeProbeRoutes(answer.routes, again), { samples: 12, warmup: 2 })
})
report('mergeProbeRoutes by trip length (runs inside a React render, src/useRoutes.ts)', sweep, CHECK_BUDGET_MS)
