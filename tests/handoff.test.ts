import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HANDOFF_OPTIONS,
  distanceM,
  GOOGLE_MAPS_MAX_URL_LENGTH,
  GOOGLE_MAPS_MAX_WAYPOINTS,
  GOOGLE_MAPS_MAX_WAYPOINTS_MOBILE,
  googleMapsUrl,
  handoffWaypoints,
  wazeUrl,
  type HandoffWaypoint,
  type LngLat,
  type RouteCandidate,
} from '../src/core/index.ts'
import { at, candidate, type RouteName } from './helpers/driveWorld.ts'
import { fixtureRoutes, lineDistanceM } from './helpers/fixtures.ts'

function world(name: RouteName, durationSec = 1200): RouteCandidate {
  const route = candidate(name, at(0, 0), durationSec)
  if (route === null) throw new Error(`no route ${name}`)
  return route
}

/** A route through the corners (meters east/north of the made-up origin). */
function custom(id: string, corners: readonly (readonly [number, number])[]): RouteCandidate {
  return { ...world('A'), id, geometry: corners.map(([x, y]) => at(x, y)) }
}

/** The main road A with a 500 m detour north between startX and endX. */
const detour = (id: string, startX: number, endX: number) =>
  custom(id, [[0, 0], [startX, 0], [startX, 500], [endX, 500], [endX, 0], [20000, 0]])

function expectWellPlaced(points: readonly HandoffWaypoint[], accepted: RouteCandidate, alternatives: readonly RouteCandidate[] = []) {
  const clear = DEFAULT_HANDOFF_OPTIONS.endpointClearanceM
  for (const p of points) {
    // Every route a point claims to rule out really is away from it.
    for (const id of p.excludesRouteIds) {
      const alt = alternatives.find((r) => r.id === id)
      if (alt !== undefined) expect(lineDistanceM(p.position, alt.geometry)).toBeGreaterThan(DEFAULT_HANDOFF_OPTIONS.sharedToleranceM)
    }
    expect(lineDistanceM(p.position, accepted.geometry)).toBeLessThan(1)
    expect(distanceM(p.position, accepted.geometry[0]!)).toBeGreaterThanOrEqual(clear)
    expect(distanceM(p.position, accepted.geometry.at(-1)!)).toBeGreaterThanOrEqual(clear)
  }
  const along = points.map((p) => p.atDistanceM)
  expect(along).toEqual([...along].sort((a, b) => a - b))
}

/** The waypoints of a Google Maps URL, decoded back to [lng, lat]. */
function urlWaypoints(url: string): LngLat[] {
  const raw = new URL(url).searchParams.get('waypoints')
  if (raw === null) return []
  return raw.split('|').map((pair) => {
    const [lat, lng] = pair.split(',').map(Number)
    return [lng!, lat!] as const
  })
}

/** Twelve alternatives, each leaving A for one detour; detour k is 400 + 70k m long. */
const MANY = Array.from({ length: 12 }, (_, k) => detour(`alt-${String(k).padStart(2, '0')}`, 1000 + 1500 * k, 1000 + 1500 * k + 400 + 70 * k))

describe('handoffWaypoints', () => {
  it('puts one point just after each split, on the accepted route, in driving order', () => {
    const a = world('A')
    const others = [world('B'), world('C')]
    const points = handoffWaypoints(a, others)
    expect(points).toHaveLength(2)
    expectWellPlaced(points, a, others)
    // B leaves A at 5 km, C at 8 km; each point sits a little past its split.
    expect(points[0]!.atDistanceM).toBeGreaterThan(5000)
    expect(points[0]!.atDistanceM).toBeLessThan(5300)
    expect(points[0]!.excludesRouteIds.map((id) => id.split('-')[0])).toEqual(['B'])
    expect(points[1]!.excludesRouteIds.map((id) => id.split('-')[0])).toEqual(['C'])
    expect(points[1]!.atDistanceM).toBeGreaterThan(8000)
    expect(points[1]!.atDistanceM).toBeLessThan(8300)
    expect(points[0]!.decisivenessM).toBeGreaterThan(points[1]!.decisivenessM)
  })

  it('uses one point for alternatives that leave at the same place', () => {
    const b = world('B')
    const others = [world('A'), world('C'), world('D'), world('BA')]
    const points = handoffWaypoints(b, others)
    expectWellPlaced(points, b, others)
    // A and C both leave B at its 5 km corner: one point rules out both.
    const first = points[0]!
    expect(first.atDistanceM).toBeLessThan(5300)
    expect(first.excludesRouteIds.map((id) => id.split('-')[0]).sort()).toEqual(expect.arrayContaining(['A', 'C']))
    // D and BA leave further along the north road and get their own points.
    expect(points.length).toBeGreaterThanOrEqual(2)
    expect(points.length).toBeLessThanOrEqual(GOOGLE_MAPS_MAX_WAYPOINTS_MOBILE)
  })

  it('keeps to 3 waypoints for mobile and 9 elsewhere, choosing the most decisive splits', () => {
    const a = world('A')
    const mobile = handoffWaypoints(a, MANY, { maxWaypoints: GOOGLE_MAPS_MAX_WAYPOINTS_MOBILE })
    expect(mobile).toHaveLength(3)
    expect(mobile.flatMap((p) => p.excludesRouteIds)).toEqual(['alt-09', 'alt-10', 'alt-11'])
    expectWellPlaced(mobile, a, MANY)
    // The default is the mobile limit.
    expect(handoffWaypoints(a, MANY)).toEqual(mobile)

    const desktop = handoffWaypoints(a, MANY, { maxWaypoints: GOOGLE_MAPS_MAX_WAYPOINTS })
    expect(desktop).toHaveLength(9)
    expect(desktop.flatMap((p) => p.excludesRouteIds)).toEqual(
      ['03', '04', '05', '06', '07', '08', '09', '10', '11'].map((k) => `alt-${k}`),
    )
    expectWellPlaced(desktop, a, MANY)
    // Never more than Google's nine, whatever is asked.
    expect(handoffWaypoints(a, MANY, { maxWaypoints: 20 })).toHaveLength(9)
    expect(handoffWaypoints(a, MANY, { maxWaypoints: 0 })).toEqual([])
  })

  it('puts no point near the origin or destination', () => {
    const a = world('A')
    // Detours inside the first and last 450 m, and one starting 100 m out.
    const nearEnds = [detour('start', 50, 450), detour('end', 19550, 19950)]
    expect(handoffWaypoints(a, nearEnds)).toEqual([])
    const early = handoffWaypoints(a, [detour('early', 100, 1000)])
    expect(early).toHaveLength(1)
    expect(early[0]!.atDistanceM).toBeGreaterThanOrEqual(DEFAULT_HANDOFF_OPTIONS.endpointClearanceM)
    expect(early[0]!.atDistanceM).toBeLessThanOrEqual(DEFAULT_HANDOFF_OPTIONS.endpointClearanceM + DEFAULT_HANDOFF_OPTIONS.sampleStepM)
    expectWellPlaced(early, a)
    // E loops north near the end; its point stays clear of the destination.
    const late = handoffWaypoints(a, [world('E')])
    expect(late).toHaveLength(1)
    expectWellPlaced(late, a)
  })

  it('gives no waypoints for identical routes or no alternatives', () => {
    const a = world('A')
    expect(handoffWaypoints(a, [])).toEqual([])
    expect(handoffWaypoints(a, [a])).toEqual([])
    expect(handoffWaypoints(a, [{ ...world('A'), id: 'same-roads' }])).toEqual([])
  })

  it('never puts a point in a short shared gap, where the alternative still is', () => {
    const a = world('A')
    // X leaves A at 1000 m for a 160 m spur, is back on A from 1160 to 1250 m, then leaves for 650 m.
    const x = custom('X', [[0, 0], [1000, 0], [1000, 400], [1160, 400], [1160, 0], [1250, 0], [1250, 400], [1900, 400], [1900, 0], [20000, 0]])
    const points = handoffWaypoints(a, [x])
    expect(points).toHaveLength(1)
    expect(points[0]!.excludesRouteIds).toEqual(['X'])
    expectWellPlaced(points, a, [x])
    expect(points[0]!.atDistanceM).toBeGreaterThan(1250)
  })

  it('rules out every alternative before spending a second point on one', () => {
    const a = world('A')
    // X has three long detours; Y one shorter one. Three points: two for X, one for Y.
    const x = custom('X', [
      [0, 0], [2000, 0], [2000, 500], [5000, 500], [5000, 0], [7000, 0], [7000, 500], [10000, 500],
      [10000, 0], [12000, 0], [12000, 500], [15000, 500], [15000, 0], [20000, 0],
    ])
    const y = detour('Y', 16000, 17000)
    const points = handoffWaypoints(a, [x, y], { maxWaypoints: 3 })
    expect(points).toHaveLength(3)
    expect(points.flatMap((p) => p.excludesRouteIds).sort()).toEqual(['X', 'X', 'Y'])
    expectWellPlaced(points, a, [x, y])
  })

  it('ignores divergences shorter than minDivergenceM', () => {
    const a = world('A')
    expect(handoffWaypoints(a, [detour('blip', 5000, 5200)])).toEqual([])
  })

  it('is deterministic and does not depend on the order of the alternatives', () => {
    const a = world('A')
    const once = handoffWaypoints(a, MANY, { maxWaypoints: 9 })
    expect(handoffWaypoints(a, MANY, { maxWaypoints: 9 })).toEqual(once)
    expect(handoffWaypoints(a, [...MANY].reverse(), { maxWaypoints: 9 })).toEqual(once)
  })

  it('pins the recorded Mapbox routes', () => {
    const routes = fixtureRoutes('directions.ok.json')
    for (const accepted of routes) {
      const points = handoffWaypoints(accepted, routes)
      expect(points.length).toBeLessThanOrEqual(GOOGLE_MAPS_MAX_WAYPOINTS_MOBILE)
      expectWellPlaced(points, accepted)
      expect(handoffWaypoints(accepted, [...routes].reverse())).toEqual(points)
    }
  })
})

describe('googleMapsUrl', () => {
  const origin = at(0, 0)
  const destination = at(20000, 0)

  it('builds a Maps URLs directions link with encoded commas and pipes', () => {
    const points = handoffWaypoints(world('A'), [world('B'), world('C')])
    const url = googleMapsUrl(origin, destination, points)
    expect(url.startsWith('https://www.google.com/maps/dir/?api=1&origin=')).toBe(true)
    expect(url).toContain('&travelmode=driving')
    expect(url).toContain('%2C')
    expect(url).toContain('%7C')
    const query = url.split('?')[1]!
    expect(query).not.toMatch(/[,|]/)
    const params = new URL(url).searchParams
    expect(params.get('origin')).toBe(`${origin[1].toFixed(6)},${origin[0].toFixed(6)}`)
    expect(params.get('destination')).toBe(`${destination[1].toFixed(6)},${destination[0].toFixed(6)}`)
    const back = urlWaypoints(url)
    expect(back).toHaveLength(2)
    back.forEach((p, i) => expect(distanceM(p, points[i]!.position)).toBeLessThan(0.5))
  })

  it('leaves out waypoints when there are none', () => {
    const url = googleMapsUrl(origin, destination, [])
    expect(url).not.toContain('waypoints')
    expect(url).toBe(
      `https://www.google.com/maps/dir/?api=1&origin=${origin[1].toFixed(6)}%2C${origin[0].toFixed(6)}` +
        `&destination=${destination[1].toFixed(6)}%2C${destination[0].toFixed(6)}&travelmode=driving`,
    )
  })

  it('leaves the origin out when it is null, so Google starts from the device itself', () => {
    const url = googleMapsUrl(null, destination, [])
    expect(url).toBe(
      `https://www.google.com/maps/dir/?api=1&destination=${destination[1].toFixed(6)}%2C${destination[0].toFixed(6)}&travelmode=driving`,
    )
  })

  it('stays within 2,048 characters, dropping the least decisive waypoints first', () => {
    const nine = handoffWaypoints(world('A'), MANY, { maxWaypoints: 9 })
    const full = googleMapsUrl(origin, destination, nine)
    expect(full.length).toBeLessThanOrEqual(GOOGLE_MAPS_MAX_URL_LENGTH)
    expect(urlWaypoints(full)).toHaveLength(9)

    // A tighter cap: room for about four waypoints.
    const cap = googleMapsUrl(origin, destination, []).length + '&waypoints='.length + 4 * 30
    const short = googleMapsUrl(origin, destination, nine, { maxUrlLength: cap })
    expect(short.length).toBeLessThanOrEqual(cap)
    const kept = urlWaypoints(short)
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThan(9)
    // The kept ones are the most decisive, still in driving order.
    const expected = [...nine]
      .sort((x, y) => y.decisivenessM - x.decisivenessM)
      .slice(0, kept.length)
      .sort((x, y) => x.atDistanceM - y.atDistanceM)
    kept.forEach((p, i) => expect(distanceM(p, expected[i]!.position)).toBeLessThan(0.5))

    // A cap too small for any waypoint still gives the plain directions link.
    expect(googleMapsUrl(origin, destination, nine, { maxUrlLength: 10 })).toBe(googleMapsUrl(origin, destination, []))
  })

  it('never sends more than nine waypoints', () => {
    const twelve: HandoffWaypoint[] = MANY.map((alt, k) => ({
      position: at(1000 + 1500 * k, 0),
      atDistanceM: 1000 + 1500 * k,
      decisivenessM: k,
      excludesRouteIds: [alt.id],
    }))
    const kept = urlWaypoints(googleMapsUrl(origin, destination, twelve))
    expect(kept).toHaveLength(9)
    expect(distanceM(kept[0]!, at(1000 + 1500 * 3, 0))).toBeLessThan(0.5)
  })
})

describe('wazeUrl', () => {
  it('navigates to the destination only, latitude first', () => {
    expect(wazeUrl([-80.843124, 35.227085])).toBe('https://waze.com/ul?ll=35.227085%2C-80.843124&navigate=yes')
    expect(wazeUrl([-80.8, 35.2])).toBe('https://waze.com/ul?ll=35.200000%2C-80.800000&navigate=yes')
  })
})
