// Shared pieces of the performance scripts (docs/performance.md): a timing harness and a
// synthetic Mapbox Directions response. Plain node (22.12+ / 24 runs the .ts imports as they are).
// Nothing here is a real place or a real response: the route is drawn by a formula.
import { performance } from 'node:perf_hooks'
import { gzipSync } from 'node:zlib'
import { alongRouteM, lineFrom } from '../../src/core/index.ts'

/**
 * Times `fn` and answers the median and the 95th percentile of one call, in milliseconds.
 * Each sample is `batch` calls timed together (for calls far below the clock's resolution).
 * `setup(i)` runs outside the timed part and its answer is handed to `fn`.
 */
export function bench(name, fn, { samples = 300, warmup = 30, batch = 1, setup = null } = {}) {
  const input = (i) => (setup === null ? undefined : setup(i))
  for (let i = 0; i < warmup; i++) fn(input(i))
  const times = []
  for (let i = 0; i < samples; i++) {
    const arg = input(i)
    const t0 = performance.now()
    for (let k = 0; k < batch; k++) fn(arg)
    times.push((performance.now() - t0) / batch)
  }
  return { name, ...summarize(times) }
}

export function summarize(times) {
  const sorted = [...times].sort((a, b) => a - b)
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  return { samples: sorted.length, medianMs: at(0.5), p95Ms: at(0.95), maxMs: sorted.at(-1) }
}

const ms = (v) => (v >= 10 ? v.toFixed(1) : v >= 0.1 ? v.toFixed(2) : v.toFixed(4))

/** Prints rows as a table. `budgetMs`, when set, adds an "over budget" flag on the p95. */
export function report(title, rows, budgetMs = null) {
  console.log(`\n${title}`)
  console.log(`${'what'.padEnd(58)} ${'median ms'.padStart(10)} ${'p95 ms'.padStart(10)} ${'max ms'.padStart(10)}  n`)
  for (const r of rows) {
    const flag = budgetMs !== null && r.p95Ms > budgetMs ? `  OVER ${budgetMs} ms` : ''
    console.log(`${r.name.padEnd(58)} ${ms(r.medianMs).padStart(10)} ${ms(r.p95Ms).padStart(10)} ${ms(r.maxMs).padStart(10)}  ${r.samples}${flag}`)
  }
}

export const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`
export const gzipSize = (text) => gzipSync(text).length

/** A small deterministic random number generator (mulberry32): the same numbers on every run. */
export function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const M_PER_DEGREE = 111_195
const START = [-80.8431, 35.2271]
const round6 = (v) => Math.round(v * 1e6) / 1e6

/**
 * A made-up road: `vertices` points over `lengthM` meters, starting in Charlotte and winding
 * south-south-west (inside the bundled NC/SC signal tiles). `bump` moves a stretch of it
 * sideways, which is how the alternatives differ from the first route.
 */
function line({ lengthM, vertices, bump = null }) {
  const step = lengthM / (vertices - 1)
  const mPerDegLng = M_PER_DEGREE * Math.cos((START[1] * Math.PI) / 180)
  let x = 0
  let y = 0
  const out = []
  for (let i = 0; i < vertices; i++) {
    const s = i * step
    const heading = ((200 + 25 * Math.sin((2 * Math.PI * s) / 7000) + 10 * Math.sin((2 * Math.PI * s) / 1300)) * Math.PI) / 180
    let px = x
    let py = y
    if (bump !== null && s > bump.fromM && s < bump.toM) {
      // A smooth sideways bulge: zero at both ends, `offsetM` in the middle.
      const k = Math.sin((Math.PI * (s - bump.fromM)) / (bump.toM - bump.fromM)) ** 2 * bump.offsetM
      px += Math.cos(heading) * k
      py -= Math.sin(heading) * k
    }
    out.push([round6(START[0] + px / mPerDegLng), round6(START[1] + py / M_PER_DEGREE)])
    x += Math.sin(heading) * step
    y += Math.cos(heading) * step
  }
  return out
}

const TURNS = [
  ['turn', 'left'],
  ['turn', 'right'],
  ['fork', 'slight left'],
  ['continue', 'straight'],
  ['off ramp', 'slight right'],
  ['merge', 'slight left'],
]

/** One route of the response, shaped like Mapbox sends it with the parameters src/providers/mapbox/client.ts asks for. */
function route(coordinates, { durationSec, stepM, intersectionEvery, freeway, jam }) {
  const along = alongRouteM(coordinates)
  const distance = along.at(-1)
  const perMeter = durationSec / distance
  const congestion = []
  const duration = []
  for (let i = 0; i < coordinates.length - 1; i++) {
    const mid = (along[i] + along[i + 1]) / 2
    congestion.push(jam !== null && mid >= jam[0] && mid <= jam[1] ? 'heavy' : i % 37 === 0 ? 'moderate' : 'low')
    duration.push(Math.round((along[i + 1] - along[i]) * perMeter * 10) / 10)
  }
  const steps = []
  const perStep = Math.max(2, Math.round(stepM / (distance / (coordinates.length - 1))))
  for (let from = 0, n = 0; from < coordinates.length - 1; from += perStep, n++) {
    const to = Math.min(coordinates.length - 1, from + perStep)
    const [type, modifier] = n === 0 ? ['depart', undefined] : TURNS[n % TURNS.length]
    const name = `Made-up Road ${n + 1}`
    const next = `Made-up Road ${n + 2}`
    const lengthM = along[to] - along[from]
    const intersections = []
    for (let i = from; i < to; i += intersectionEvery) {
      const onFreeway = along[i] >= freeway[0] && along[i] <= freeway[1]
      intersections.push({
        location: coordinates[i],
        geometry_index: i,
        bearings: [20, 110, 200, 290],
        entry: [false, true, true, true],
        in: 0,
        out: 2,
        is_urban: !onFreeway,
        admin_index: 0,
        mapbox_streets_v8: { class: onFreeway ? 'motorway' : 'primary' },
        ...(onFreeway ? { classes: ['motorway'] } : {}),
        ...(!onFreeway && (i / intersectionEvery) % 5 === 0 ? { traffic_signal: true } : {}),
      })
    }
    steps.push({
      name,
      mode: 'driving',
      driving_side: 'right',
      weight: Math.round(lengthM * perMeter * 11) / 10,
      distance: Math.round(lengthM * 10) / 10,
      duration: Math.round(lengthM * perMeter * 10) / 10,
      geometry: { type: 'LineString', coordinates: coordinates.slice(from, to + 1) },
      maneuver: {
        type,
        ...(modifier === undefined ? {} : { modifier }),
        instruction: n === 0 ? `Drive south on ${name}.` : `Turn ${modifier} onto ${name}.`,
        location: coordinates[from],
        bearing_before: 200,
        bearing_after: 205,
      },
      intersections,
      bannerInstructions: [
        {
          distanceAlongGeometry: Math.round(lengthM),
          primary: { text: next, type: 'turn', modifier: 'left', components: [{ text: next, type: 'text' }] },
          sub: null,
        },
      ],
      voiceInstructions: [lengthM, 400, 60]
        .filter((d) => d <= lengthM)
        .map((d) => ({
          distanceAlongGeometry: Math.round(d),
          announcement: `In ${Math.round(d)} meters, turn left onto ${next}.`,
          ssmlAnnouncement: `<speak><amazon:effect name="drc"><prosody rate="1.08">In ${Math.round(d)} meters, turn left onto ${next}.</prosody></amazon:effect></speak>`,
        })),
    })
  }
  steps.push({
    name: 'Made-up Road End',
    mode: 'driving',
    distance: 0,
    duration: 0,
    geometry: { type: 'LineString', coordinates: [coordinates.at(-1), coordinates.at(-1)] },
    maneuver: { type: 'arrive', instruction: 'You have arrived at your destination.', location: coordinates.at(-1) },
    intersections: [{ location: coordinates.at(-1), geometry_index: coordinates.length - 1, bearings: [20], entry: [true], in: 0 }],
    bannerInstructions: [],
    voiceInstructions: [],
  })
  return {
    weight_name: 'auto',
    weight: Math.round(durationSec * 11) / 10,
    duration: durationSec,
    duration_typical: Math.round(durationSec * 0.93),
    distance: Math.round(distance * 10) / 10,
    geometry: { type: 'LineString', coordinates },
    legs: [{ summary: 'Made-up Road 1, Made-up Road 2', weight: durationSec, duration: durationSec, distance, annotation: { congestion, duration }, steps, admins: [{ iso_3166_1: 'US' }] }],
  }
}

/**
 * A Directions response for a long drive: three routes of `lengthKm` with `vertices` points
 * each (60 km and 3000 by default, a vertex every 20 m), a step about every 1.5 km, an
 * intersection every 200 m, a freeway stretch, a jam, banner and voice instructions, and the
 * per-segment `congestion` and `duration` annotations. The second and third routes leave the
 * first for 20 km each. The shape follows the Directions API v5 response; the sizes of a real
 * answer depend on the roads.
 */
export function syntheticDirections({ lengthKm = 60, vertices = 3000, routes = 3 } = {}) {
  const lengthM = lengthKm * 1000
  const shape = { stepM: 1500, intersectionEvery: 10, freeway: [lengthM * 0.55, lengthM * 0.75], jam: [lengthM * 0.13, lengthM * 0.18] }
  const bumps = [null, { fromM: lengthM * 0.25, toM: lengthM * 0.58, offsetM: 900 }, { fromM: lengthM * 0.5, toM: lengthM * 0.83, offsetM: -1100 }]
  const speeds = [16.5, 15.8, 15.2]
  return {
    code: 'Ok',
    uuid: 'synthetic-not-a-real-response',
    waypoints: [
      { name: 'Made-up Road 1', location: START, distance: 1.2 },
      { name: 'Made-up Road End', location: START, distance: 2.1 },
    ],
    routes: bumps.slice(0, routes).map((bump, i) => route(line({ lengthM, vertices, bump }), { ...shape, durationSec: Math.round(lengthM / speeds[i]) })),
  }
}

/**
 * What a check made `alongM` meters into the drive gets back: the same routes, each from the
 * car's position to the destination, as RouteCandidates. Stands in for a fresh Directions
 * answer without a network.
 */
export function freshFrom(candidates, alongM) {
  return candidates.map((c, i) => {
    const total = alongRouteM(c.geometry).at(-1)
    const at = Math.min(alongM, total - 100)
    const left = (total - at) / total
    const shift = (spans) => (spans === null ? null : spans.filter(([, b]) => b > at).map(([a, b]) => [Math.max(0, a - at), b - at]))
    return {
      ...c,
      id: `fresh-${i}-${Math.round(at)}`,
      geometry: lineFrom(c.geometry, at),
      durationSec: c.durationSec * left,
      typicalDurationSec: c.typicalDurationSec === null ? null : c.typicalDurationSec * left,
      distanceM: total - at,
      limitedAccessSpansM: shift(c.limitedAccessSpansM),
      maneuvers: c.maneuvers.filter((m) => m.atDistanceM >= at).map((m) => ({ ...m, atDistanceM: m.atDistanceM - at })),
      guidance: (c.guidance ?? []).filter((g) => g.atDistanceM >= at).map((g) => ({ ...g, atDistanceM: g.atDistanceM - at, announcements: g.announcements.map((a) => ({ ...a, atDistanceM: Math.max(0, a.atDistanceM - at) })) })),
      segmentTraffic: null,
    }
  })
}

/** Position fixes of a drive along `geometry` at `speedMps`, one a second, with a few meters of GPS noise. */
export function fixesAlong(geometry, { speedMps = 15, noiseM = 4, startMs = 1_000_000, seed = 7 } = {}) {
  const along = alongRouteM(geometry)
  const total = along.at(-1)
  const random = rng(seed)
  const fixes = []
  let i = 0
  for (let s = 0, t = 0; s < total; s += speedMps, t++) {
    while (i < along.length - 2 && along[i + 1] < s) i++
    const span = along[i + 1] - along[i]
    const k = span > 0 ? (s - along[i]) / span : 0
    const lng = geometry[i][0] + (geometry[i + 1][0] - geometry[i][0]) * k
    const lat = geometry[i][1] + (geometry[i + 1][1] - geometry[i][1]) * k
    fixes.push({
      lng: lng + ((random() - 0.5) * 2 * noiseM) / (M_PER_DEGREE * Math.cos((lat * Math.PI) / 180)),
      lat: lat + ((random() - 0.5) * 2 * noiseM) / M_PER_DEGREE,
      accuracyM: 5 + random() * 5,
      speedMps,
      headingDeg: 200,
      timeMs: startMs + t * 1000,
    })
  }
  return fixes
}
