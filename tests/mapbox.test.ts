import { describe, expect, it } from 'vitest'
import { DEFAULT_PROBE_OPTIONS, routeIdFromGeometry, SOUTHPARK, UPTOWN_CHARLOTTE } from '../src/core/index.ts'
import { parseDirections, type DirectionsResult } from '../src/providers/mapbox/adapter.ts'
import { buildDirectionsUrl, fetchDirections, fetchProbeRoute, MAX_VIA_POINTS } from '../src/providers/mapbox/client.ts'
import { fixture } from './helpers/fixtures.ts'

// Hand-written bodies shaped like Directions API v5 responses. No test here touches the network.
const OK = fixture('directions.ok.json') as { code: string; routes: Record<string, unknown>[] }
const FREEWAY = fixture('directions.freeway.json') as { code: string; routes: Record<string, unknown>[] }
const CONGESTION = fixture('directions.congestion.json') as { code: string; routes: Record<string, unknown>[] }
const NO_ROUTE = fixture('directions.noroute.json')
const INVALID_INPUT = fixture('directions.invalidinput.json')

/** A placeholder, not a real token. */
const TOKEN = 'pk.test-token'

function routesOf(result: DirectionsResult) {
  if (!result.ok) throw new Error(`expected routes, got ${result.kind}`)
  return result.routes
}

function failureOf(result: DirectionsResult) {
  if (result.ok) throw new Error('expected a failure')
  return result
}

describe('parseDirections', () => {
  it('turns each route into a RouteCandidate', () => {
    const routes = routesOf(parseDirections(OK))
    expect(routes).toHaveLength(3)
    const first = routes[0]!
    expect(first.durationSec).toBe(900.4)
    expect(first.typicalDurationSec).toBe(780.1)
    expect(first.distanceM).toBe(9300.5)
    // Mapbox never fills the city signal count; that comes from core/signals.ts.
    expect(routes.map((r) => r.signalCount)).toEqual([null, null, null])
    expect(first.geometry).toHaveLength(5)
    expect(first.geometry[0]).toEqual([-80.8431, 35.2271])
    expect(first.geometry.at(-1)).toEqual([-80.8295, 35.1527])
  })

  it('leaves typical duration null when Mapbox sends none', () => {
    const routes = routesOf(parseDirections(OK))
    expect(routes[1]!.typicalDurationSec).toBe(860)
    expect(routes[2]!.typicalDurationSec).toBeNull()
  })

  it('places maneuvers at the cumulative distance of the steps before them', () => {
    const { maneuvers } = routesOf(parseDirections(OK))[0]!
    expect(maneuvers.map((m) => m.kind)).toEqual([
      'depart',
      'turn left',
      'fork slight right',
      'arrive right',
    ])
    expect(maneuvers.map((m) => m.atDistanceM)).toEqual([0, 800.5, 6800.5, 9300.5])
    expect(maneuvers[1]!.location).toEqual([-80.8436, 35.2201])
  })

  it('keeps counting distance across legs', () => {
    const step = (distance: number, lng: number) => ({
      distance,
      maneuver: { type: 'turn', modifier: 'left', location: [lng, 35.2] },
    })
    const body = {
      code: 'Ok',
      routes: [
        {
          ...OK.routes[0],
          legs: [{ steps: [step(100, -80.84), step(50, -80.83)] }, { steps: [step(25, -80.82)] }],
        },
      ],
    }
    const { maneuvers } = routesOf(parseDirections(body))[0]!
    expect(maneuvers.map((m) => m.atDistanceM)).toEqual([0, 100, 150])
  })

  it('works with a single route and no alternatives', () => {
    const routes = routesOf(parseDirections({ code: 'Ok', routes: [OK.routes[1]] }))
    expect(routes).toHaveLength(1)
    expect(routes[0]!.id).toBe(routesOf(parseDirections(OK))[1]!.id)
  })

  it('tolerates missing legs, steps and odd maneuvers', () => {
    const base = OK.routes[0]!
    const noLegs = routesOf(parseDirections({ code: 'Ok', routes: [{ ...base, legs: undefined }] }))
    expect(noLegs[0]!.maneuvers).toEqual([])

    const odd = {
      ...base,
      legs: [
        null,
        { steps: 'nope' },
        {
          steps: [
            7,
            { distance: 100 },
            { distance: 'far', maneuver: { location: [-80.84, 35.22] } },
            { distance: 40, maneuver: { type: 'turn', modifier: 'right', location: [999, 35] } },
            { distance: -5, maneuver: { type: 'arrive', location: [-80.83, 35.15] } },
          ],
        },
      ],
    }
    const { maneuvers } = routesOf(parseDirections({ code: 'Ok', routes: [odd] }))[0]!
    expect(maneuvers).toEqual([
      { atDistanceM: 100, kind: 'unknown', location: [-80.84, 35.22] },
      { atDistanceM: 140, kind: 'arrive', location: [-80.83, 35.15] },
    ])
  })

  it('drops bad points from a geometry and bad routes from the list', () => {
    const base = OK.routes[0]!
    const line = (coordinates: unknown) => ({ ...base, geometry: { type: 'LineString', coordinates } })
    const body = {
      code: 'Ok',
      routes: [
        line([[-80.84, 35.22], [null, 35.2], [-80.83], 'x', [-80.83, 95], [-80.83, 35.15]]),
        line([]),
        line([[-80.84, 35.22]]),
        { ...base, geometry: 'encoded_polyline_string' },
        { ...base, geometry: undefined },
        { ...base, duration: 'soon' },
        { ...base, distance: -1 },
        null,
      ],
    }
    const routes = routesOf(parseDirections(body))
    expect(routes).toHaveLength(1)
    expect(routes[0]!.geometry).toEqual([
      [-80.84, 35.22],
      [-80.83, 35.15],
    ])
  })

  it('derives each route id from its geometry, not its place in the response', () => {
    const routes = routesOf(parseDirections(OK))
    for (const r of routes) {
      expect(r.id).toBe(routeIdFromGeometry(r.geometry))
      expect(r.id).toMatch(/^route-[0-9a-f]{16}$/)
    }
    expect(new Set(routes.map((r) => r.id)).size).toBe(3)
    // The same routes in another order, as a refetch can return them, keep their ids.
    const reordered = routesOf(parseDirections({ code: 'Ok', routes: [OK.routes[2], OK.routes[0], OK.routes[1]] }))
    expect(reordered.map((r) => r.id)).toEqual([routes[2]!.id, routes[0]!.id, routes[1]!.id])
    // Times change with traffic; the id does not.
    const later = routesOf(parseDirections({ code: 'Ok', routes: [{ ...OK.routes[0], duration: 1234 }] }))
    expect(later[0]!.id).toBe(routes[0]!.id)
  })

  it('keeps ids unique if two routes in one response share a geometry', () => {
    const twins = routesOf(
      parseDirections({ code: 'Ok', routes: [OK.routes[0], OK.routes[1], OK.routes[0], OK.routes[0]] }),
    )
    const id = routeIdFromGeometry(twins[0]!.geometry)
    expect(twins.map((r) => r.id)).toEqual([id, twins[1]!.id, `${id}-2`, `${id}-3`])
  })

  it('counts intersections Mapbox flags as traffic signals, apart from signalCount', () => {
    const routes = routesOf(parseDirections(OK))
    // Two flagged intersections in the steps of the first route; the others carry no intersections at all.
    expect(routes.map((r) => r.providerSignalCount)).toEqual([2, null, null])
    expect(routes[0]!.signalCount).toBeNull()
    // Nothing is known about signals until the signal data has been matched.
    expect(routes.map((r) => r.signalCoverage)).toEqual(['none', 'none', 'none'])
  })

  it('lists every intersection with its location and signal flag, in driving order', () => {
    const at = (lng: number, traffic_signal?: unknown) => ({ location: [lng, 35.2], traffic_signal })
    const step = (intersections: unknown) => ({
      distance: 100,
      maneuver: { type: 'turn', location: [-80.84, 35.2] },
      intersections,
    })
    const listOf = (legs: unknown) =>
      routesOf(parseDirections({ code: 'Ok', routes: [{ ...OK.routes[0], legs }] }))[0]!.intersections

    expect(
      listOf([
        { steps: [step([at(-80.84), at(-80.83, true)]), step([at(-80.82, false)])] },
        { steps: [step([at(-80.81, true)])] },
      ]),
    ).toEqual([
      { location: [-80.84, 35.2], signal: false },
      { location: [-80.83, 35.2], signal: true },
      { location: [-80.82, 35.2], signal: false },
      { location: [-80.81, 35.2], signal: true },
    ])
    // The end of one step is the start of the next: listed once, and flagged if either copy is.
    expect(listOf([{ steps: [step([at(-80.84), at(-80.83)]), step([at(-80.83, true), at(-80.82)])] }])).toEqual([
      { location: [-80.84, 35.2], signal: false },
      { location: [-80.83, 35.2], signal: true },
      { location: [-80.82, 35.2], signal: false },
    ])
    // Only a literal true is a signal; entries without a usable location are left out.
    expect(listOf([{ steps: [step([at(-80.84, 'true'), { traffic_signal: true }, { location: [999, 0] }, 7, null])] }])).toEqual([
      { location: [-80.84, 35.2], signal: false },
    ])
    // Intersections listed but empty is a known "none"; no lists at all is unknown.
    expect(listOf([{ steps: [step([])] }])).toEqual([])
    expect(listOf([{ steps: [{ distance: 100 }] }])).toBeNull()
    expect(listOf(undefined)).toBeNull()
    // The hand-written fixtures: the first route of each carries intersections.
    expect(routesOf(parseDirections(OK)).map((r) => r.intersections?.length ?? null)).toEqual([5, null, null])
    const freeway = routesOf(parseDirections(FREEWAY))[0]!
    expect(freeway.intersections!.filter((i) => i.signal)).toHaveLength(freeway.providerSignalCount!)
  })

  it('counts signal flags across steps and legs, and tells none from no data', () => {
    const at = (lng: number, traffic_signal?: unknown) => ({ location: [lng, 35.2], traffic_signal })
    const step = (intersections: unknown) => ({
      distance: 100,
      maneuver: { type: 'turn', location: [-80.84, 35.2] },
      intersections,
    })
    const count = (legs: unknown) =>
      routesOf(parseDirections({ code: 'Ok', routes: [{ ...OK.routes[0], legs }] }))[0]!.providerSignalCount

    expect(
      count([
        { steps: [step([at(-80.84), at(-80.83, true)]), step([at(-80.82, true)])] },
        { steps: [step([at(-80.81, true)])] },
      ]),
    ).toBe(3)
    // Intersections listed but none flagged: a real zero.
    expect(count([{ steps: [step([at(-80.84), at(-80.83, false)]), step([])] }])).toBe(0)
    // No intersections lists at all (steps=false, or another profile): unknown, not zero.
    expect(count([{ steps: [{ distance: 100, maneuver: { type: 'turn', location: [-80.84, 35.2] } }] }])).toBeNull()
    expect(count([{ steps: [] }])).toBeNull()
    expect(count(undefined)).toBeNull()
    expect(count('legs')).toBeNull()
    // Only a literal true counts.
    expect(count([{ steps: [step([at(-80.84, 'true'), at(-80.83, 1), at(-80.82, null), 7, null, 'x'])] }])).toBe(0)
    // The same flagged point ending one step and starting the next is one signal...
    expect(count([{ steps: [step([at(-80.84), at(-80.83, true)]), step([at(-80.83, true), at(-80.82)])] }])).toBe(1)
    // ...but passing it again later in the route is a second one.
    expect(count([{ steps: [step([at(-80.83, true), at(-80.82), at(-80.83, true)])] }])).toBe(2)
    // A flag without a usable location still counts.
    expect(count([{ steps: [step([{ traffic_signal: true }, { traffic_signal: true, location: [999, 0] }])] }])).toBe(2)
    // Odd legs and steps are skipped, as for maneuvers.
    expect(count([null, { steps: 'nope' }, { steps: [7, step('nope'), step([at(-80.84, true)])] }])).toBe(1)
  })

  it('finds the stretch driven on freeway, ramps tagged motorway_link included', () => {
    const [freeway, surface] = routesOf(parseDirections(FREEWAY))
    // Points are 0.001 degrees of latitude apart, 111.19 m. The on-ramp
    // (motorway_link) starts at point 2; the road leaving point 6 is the
    // off-ramp to a street (tertiary_link), so the span closes there.
    // Point 5 is marked only by classes: ["motorway"]; either field is enough.
    const spans = freeway!.limitedAccessSpansM!
    expect(spans).toHaveLength(1)
    expect(spans[0]![0]).toBeCloseTo(2 * 111.19, 0)
    expect(spans[0]![1]).toBeCloseTo(6 * 111.19, 0)
    // A route with intersection data and no freeway (a trunk road in a tunnel is not one): known to have none.
    expect(surface!.limitedAccessSpansM).toEqual([])
    // The signal flags are still counted as before.
    expect(freeway!.providerSignalCount).toBe(2)
  })

  it('leaves the freeway spans unknown unless the intersection data is exactly as expected', () => {
    const base = FREEWAY.routes[0]!
    const coordinates = (base.geometry as { coordinates: number[][] }).coordinates
    const steps = (base.legs as { steps: { intersections: Record<string, unknown>[] }[] }[])[0]!.steps
    const spansOf = (route: Record<string, unknown>) =>
      routesOf(parseDirections({ code: 'Ok', routes: [route] }))[0]!.limitedAccessSpansM
    const withIntersection = (stepIndex: number, change: Record<string, unknown>) => ({
      ...base,
      legs: [
        {
          steps: steps.map((step, i) =>
            i === stepIndex ? { ...step, intersections: [{ ...step.intersections[0], ...change }] } : step,
          ),
        },
      ],
    })
    expect(spansOf(base)).toHaveLength(1)
    // No steps or intersections (steps=false): unknown. The hand-written OK fixture has no geometry_index.
    expect(spansOf({ ...base, legs: undefined })).toBeNull()
    expect(spansOf({ ...base, legs: [] })).toBeNull()
    expect(spansOf({ ...base, legs: [{ steps: [{ distance: 5 }] }] })).toBeNull()
    expect(routesOf(parseDirections(OK)).map((r) => r.limitedAccessSpansM)).toEqual([null, null, null])
    // A missing, fractional, out-of-range or backward index.
    expect(spansOf(withIntersection(1, { geometry_index: undefined }))).toBeNull()
    expect(spansOf(withIntersection(1, { geometry_index: 2.5 }))).toBeNull()
    expect(spansOf(withIntersection(1, { geometry_index: 99 }))).toBeNull()
    expect(spansOf(withIntersection(3, { geometry_index: 1, location: coordinates[1] }))).toBeNull()
    // An index that does not land on the intersection's own location.
    expect(spansOf(withIntersection(1, { location: [-80.8402, 35.202] }))).toBeNull()
    // A bad point dropped from the line would shift every index after it.
    expect(
      spansOf({ ...base, geometry: { coordinates: [coordinates[0], [999, 0], ...coordinates.slice(1)] } }),
    ).toBeNull()
  })

  it('places later legs after earlier ones and joins a freeway span across a waypoint', () => {
    const point = (i: number) => [-80.84, 35.2 + i * 0.001]
    const at = (leg: number, geometry_index: number, cls: string) => ({
      location: point(leg * 2 + geometry_index),
      geometry_index,
      mapbox_streets_v8: { class: cls },
    })
    const arrive = (leg: number) => ({ location: point(leg * 2 + 2), geometry_index: 2 })
    const route = {
      duration: 60,
      distance: 444,
      geometry: { coordinates: [0, 1, 2, 3, 4].map(point) },
      legs: [
        { steps: [{ intersections: [at(0, 0, 'street'), at(0, 1, 'motorway')] }, { intersections: [arrive(0)] }] },
        // geometry_index starts again at 0 in the second leg, which begins at point 2.
        { steps: [{ intersections: [at(1, 0, 'motorway'), at(1, 1, 'motorway')] }, { intersections: [arrive(1)] }] },
      ],
    }
    const spans = routesOf(parseDirections({ code: 'Ok', routes: [route] }))[0]!.limitedAccessSpansM!
    // On the freeway from point 1. The first leg's arrival point carries no road class, but the
    // second leg leaves the same point on the freeway, so it is one span, to the end of the route.
    expect(spans).toHaveLength(1)
    expect(spans[0]![0]).toBeCloseTo(111.19, 0)
    expect(spans[0]![1]).toBeCloseTo(4 * 111.19, 0)
  })

  it('carries per-segment congestion and duration, one entry per segment of the line', () => {
    const [first] = routesOf(parseDirections(CONGESTION))
    expect(first!.geometry).toHaveLength(5)
    expect(first!.segmentTraffic).toEqual({
      congestion: ['low', 'heavy', 'severe', 'moderate'],
      durationSec: [80.2, 310.5, 402.1, 107.6],
    })
  })

  it('reads congestion it does not know as unknown, and drops a list of the wrong length', () => {
    const routes = routesOf(parseDirections(CONGESTION))
    // "jammed" and null are not Mapbox levels: unknown, never a guess. Two durations for three segments: none.
    expect(routes[1]!.segmentTraffic).toEqual({ congestion: ['low', 'unknown', 'unknown'], durationSec: null })
    // No annotation at all (an older response, or a test): null, not an empty list.
    expect(routes[2]!.segmentTraffic).toBeNull()
    expect(routesOf(parseDirections(OK)).map((r) => r.segmentTraffic)).toEqual([null, null, null])
  })

  it('drops annotations that cannot line up with the geometry', () => {
    const route = CONGESTION.routes[0]! as { geometry: { coordinates: unknown[] }; legs: Record<string, unknown>[] }
    const leg = route.legs[0]!
    const annotation = leg.annotation as Record<string, unknown[]>
    const parse = (r: unknown) => routesOf(parseDirections({ code: 'Ok', routes: [r] }))[0]!.segmentTraffic
    // One entry short.
    expect(parse({ ...route, legs: [{ ...leg, annotation: { ...annotation, congestion: annotation.congestion!.slice(1) } }] })).toEqual({
      congestion: null,
      durationSec: annotation.duration,
    })
    // A duration that is not a number of 0 or more spoils that list only.
    expect(parse({ ...route, legs: [{ ...leg, annotation: { ...annotation, duration: [80.2, -1, 402.1, 107.6] } }] })).toEqual({
      congestion: annotation.congestion,
      durationSec: null,
    })
    // A bad point dropped from the line would shift every entry after it.
    const coordinates = [...route.geometry.coordinates]
    coordinates[2] = ['x', 'y']
    expect(parse({ ...route, geometry: { type: 'LineString', coordinates } })).toBeNull()
    // Not an object, not a list, a leg without one.
    expect(parse({ ...route, legs: [{ ...leg, annotation: 'congestion' }] })).toBeNull()
    expect(parse({ ...route, legs: [{ ...leg, annotation: { congestion: 'heavy', duration: 3 } }] })).toBeNull()
    expect(parse({ ...route, legs: [leg, { steps: [] }] })).toBeNull()
  })

  it('joins the annotations of several legs into one list for the whole line', () => {
    const route = CONGESTION.routes[0]! as { legs: Record<string, unknown>[] }
    const leg = route.legs[0]!
    const legs = [
      { ...leg, annotation: { congestion: ['low', 'heavy'], duration: [80.2, 310.5] } },
      { ...leg, annotation: { congestion: ['severe', 'moderate'], duration: [402.1, 107.6] } },
    ]
    const [only] = routesOf(parseDirections({ code: 'Ok', routes: [{ ...route, legs }] }))
    expect(only!.segmentTraffic).toEqual({
      congestion: ['low', 'heavy', 'severe', 'moderate'],
      durationSec: [80.2, 310.5, 402.1, 107.6],
    })
  })

  it('treats a non-numeric typical duration as missing', () => {
    const routes = routesOf(
      parseDirections({ code: 'Ok', routes: [{ ...OK.routes[0], duration_typical: 'n/a' }] }),
    )
    expect(routes[0]!.typicalDurationSec).toBeNull()
  })

  it('reports NoRoute and an empty route list as no-route', () => {
    expect(failureOf(parseDirections(NO_ROUTE)).kind).toBe('no-route')
    expect(failureOf(parseDirections({ code: 'Ok', routes: [] })).kind).toBe('no-route')
  })

  it('reports NoSegment and other error codes with their message', () => {
    expect(failureOf(parseDirections({ code: 'NoSegment' })).kind).toBe('no-segment')
    const invalid = failureOf(parseDirections(INVALID_INPUT))
    expect(invalid.kind).toBe('api')
    expect(invalid.message).toContain('InvalidInput')
    expect(invalid.message).toContain('Coordinate is invalid')
    expect(failureOf(parseDirections({ code: 'ProfileNotFound' })).message).toContain('ProfileNotFound')
  })

  it('reports anything else as malformed instead of throwing', () => {
    for (const body of [null, undefined, 'Ok', 42, [], {}, { code: 7 }, { code: 'Ok' }, { code: 'Ok', routes: {} }]) {
      expect(failureOf(parseDirections(body)).kind, JSON.stringify(body)).toBe('malformed')
    }
    const unusable = { code: 'Ok', routes: [{ duration: 1, distance: 1 }] }
    expect(failureOf(parseDirections(unusable)).kind).toBe('malformed')
  })
})

describe('buildDirectionsUrl', () => {
  const url = buildDirectionsUrl(UPTOWN_CHARLOTTE.position, SOUTHPARK.position, TOKEN)!

  it('puts coordinates in longitude,latitude order, origin first', () => {
    expect(url).toContain(
      'https://api.mapbox.com/directions/v5/mapbox/driving-traffic/-80.8431,35.2271%3B-80.8295,35.1527?',
    )
  })

  it('asks for traffic-aware alternatives with full GeoJSON and steps', () => {
    const query = new URL(url).searchParams
    expect(query.get('alternatives')).toBe('true')
    expect(query.get('geometries')).toBe('geojson')
    expect(query.get('overview')).toBe('full')
    expect(query.get('steps')).toBe('true')
    expect(query.get('access_token')).toBe(TOKEN)
  })

  it('asks for the congestion and travel time of every segment, which needs the full overview', () => {
    const query = new URL(url).searchParams
    expect(query.get('annotations')).toBe('congestion,duration')
    expect(query.get('overview')).toBe('full')
    // The same on a request through via points (a drive check or a side-street probe).
    const via = new URL(buildDirectionsUrl(UPTOWN_CHARLOTTE.position, SOUTHPARK.position, TOKEN, { via: [{ point: [-80.84, 35.19] }], originHeadingDeg: 180 })!)
    expect(via.searchParams.get('annotations')).toBe('congestion,duration')
  })

  it('encodes the token and trims long coordinates', () => {
    const odd = buildDirectionsUrl([-80.84312345678, 35.2], [-80.8, 35.1], 'pk.a b&c=d')!
    expect(odd).toContain('/-80.843123,35.2%3B-80.8,35.1?')
    expect(odd).not.toContain('a b&c=d')
    expect(new URL(odd).searchParams.get('access_token')).toBe('pk.a b&c=d')
  })

  it('is null for a coordinate that is not on the map', () => {
    expect(buildDirectionsUrl([NaN, 35], SOUTHPARK.position, TOKEN)).toBeNull()
    expect(buildDirectionsUrl(UPTOWN_CHARLOTTE.position, [-80, 91], TOKEN)).toBeNull()
  })

  it('sends no bearings for a trip planned from a pin', () => {
    expect(new URL(url).searchParams.has('bearings')).toBe(false)
    expect(url).not.toContain('depart_at')
    const odd = buildDirectionsUrl(UPTOWN_CHARLOTTE.position, SOUTHPARK.position, TOKEN, { originHeadingDeg: NaN })!
    expect(odd).toBe(url)
  })

  it('sends the heading of a moving vehicle for the origin only, and leaves the destination free', () => {
    const moving = (originHeadingDeg: number) =>
      new URL(buildDirectionsUrl(UPTOWN_CHARLOTTE.position, SOUTHPARK.position, TOKEN, { originHeadingDeg })!).searchParams
    // "angle,range" for the origin, then an empty entry for the destination.
    expect(moving(187.4).get('bearings')).toBe('187,45;')
    expect(moving(0).get('bearings')).toBe('0,45;')
    // Mapbox takes 0 to 360; headings are brought into range.
    expect(moving(359.7).get('bearings')).toBe('0,45;')
    expect(moving(-90).get('bearings')).toBe('270,45;')
    expect(moving(450).get('bearings')).toBe('90,45;')
    // Everything else about the request is the same, and the semicolon is encoded.
    const withHeading = buildDirectionsUrl(UPTOWN_CHARLOTTE.position, SOUTHPARK.position, TOKEN, { originHeadingDeg: 187 })!
    expect(withHeading).toContain('bearings=187%2C45%3B')
    expect(withHeading.replace('&bearings=187%2C45%3B', '')).toBe(url)
  })
})

describe('buildDirectionsUrl with via points (the travel time of one particular path)', () => {
  // Made-up points between the two landmarks.
  const via = [
    { point: [-80.84, 35.2] as [number, number], bearingDeg: 181.6 },
    { point: [-80.835, 35.17] as [number, number] },
  ]
  const url = buildDirectionsUrl(UPTOWN_CHARLOTTE.position, SOUTHPARK.position, TOKEN, { originHeadingDeg: 170, via })!
  const query = new URL(url).searchParams

  it('sends them as coordinates between the origin and the destination, in order', () => {
    expect(url).toContain('/driving-traffic/-80.8431,35.2271%3B-80.84,35.2%3B-80.835,35.17%3B-80.8295,35.1527?')
  })

  it('names only the first and the last coordinate as waypoints, so the answer is one leg', () => {
    expect(query.get('waypoints')).toBe('0;3')
  })

  it('asks for that path only, and gives each point its heading when it has one', () => {
    expect(query.get('alternatives')).toBe('false')
    expect(query.get('bearings')).toBe('170,45;182,45;;')
    expect(query.get('steps')).toBe('true')
  })

  it('leaves out points that are not coordinates, and never sends more than 25 coordinates', () => {
    const odd = buildDirectionsUrl(UPTOWN_CHARLOTTE.position, SOUTHPARK.position, TOKEN, { via: [{ point: [NaN, 35] }, via[1]!] })!
    expect(new URL(odd).searchParams.get('waypoints')).toBe('0;2')
    expect(new URL(odd).searchParams.has('bearings')).toBe(false)
    const many = Array.from({ length: 40 }, (_, i) => ({ point: [-80.84, 35.2 - i * 0.001] as [number, number] }))
    const capped = buildDirectionsUrl(UPTOWN_CHARLOTTE.position, SOUTHPARK.position, TOKEN, { via: many })!
    expect(MAX_VIA_POINTS).toBe(23)
    expect(new URL(capped).searchParams.get('waypoints')).toBe('0;24')
    expect(capped.split('?')[0]!.split('%3B')).toHaveLength(25)
    // No via points: the request is the one it always was.
    expect(buildDirectionsUrl(UPTOWN_CHARLOTTE.position, SOUTHPARK.position, TOKEN, { via: [] })).toBe(
      buildDirectionsUrl(UPTOWN_CHARLOTTE.position, SOUTHPARK.position, TOKEN),
    )
  })
})

describe('fetchDirections', () => {
  const where = { origin: UPTOWN_CHARLOTTE.position, destination: SOUTHPARK.position, token: TOKEN }

  /** Stands in for fetch: records the call and answers with a canned response. */
  function fakeFetch(status: number, body: unknown) {
    const calls: { url: string; signal: AbortSignal | null }[] = []
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), signal: init?.signal ?? null })
      const text = typeof body === 'string' ? body : JSON.stringify(body)
      return Promise.resolve(new Response(text, { status }))
    }) as typeof fetch
    return { fetchImpl, calls }
  }

  it('requests the built URL, passes the signal on, and returns routes', async () => {
    const { fetchImpl, calls } = fakeFetch(200, OK)
    const controller = new AbortController()
    const result = await fetchDirections({ ...where, signal: controller.signal, fetchImpl })
    expect(routesOf(result)).toHaveLength(3)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(buildDirectionsUrl(where.origin, where.destination, TOKEN))
    expect(calls[0]!.signal).toBe(controller.signal)
  })

  it('passes the heading of a moving vehicle on to the request', async () => {
    const { fetchImpl, calls } = fakeFetch(200, OK)
    const result = await fetchDirections({ ...where, originHeadingDeg: 187, fetchImpl })
    expect(result.ok).toBe(true)
    expect(new URL(calls[0]!.url).searchParams.get('bearings')).toBe('187,45;')
  })

  it('passes a 200 NoRoute body through as no-route', async () => {
    const { fetchImpl } = fakeFetch(200, NO_ROUTE)
    expect(failureOf(await fetchDirections({ ...where, fetchImpl })).kind).toBe('no-route')
  })

  it('explains 401 and 403 as token problems', async () => {
    const unauthorized = failureOf(
      await fetchDirections({ ...where, ...fakeFetch(401, { message: 'Not Authorized - Invalid Token' }) }),
    )
    expect(unauthorized.kind).toBe('token')
    expect(unauthorized.message).toContain('rejected the token')
    const forbidden = failureOf(
      await fetchDirections({ ...where, ...fakeFetch(403, { message: 'Forbidden' }) }),
    )
    expect(forbidden.kind).toBe('token')
    expect(forbidden.message).toContain('http://localhost:5173')
  })

  it('explains 429 as rate limiting', async () => {
    const limited = failureOf(await fetchDirections({ ...where, ...fakeFetch(429, { message: 'Too Many Requests' }) }))
    expect(limited).toMatchObject({
      kind: 'rate-limit',
      message: 'Mapbox is rate limiting route requests (429). Wait a minute, then try again.',
    })
  })

  it('keeps Mapbox’s explanation for a 422 and is generic for a 500', async () => {
    const invalid = failureOf(await fetchDirections({ ...where, ...fakeFetch(422, INVALID_INPUT) }))
    expect(invalid.kind).toBe('api')
    expect(invalid.message).toContain('Coordinate is invalid')
    const down = failureOf(await fetchDirections({ ...where, ...fakeFetch(500, 'Internal Server Error') }))
    expect(down.kind).toBe('api')
    expect(down.message).toContain('HTTP 500')
  })

  it('reports a 200 that is not JSON as malformed', async () => {
    const result = await fetchDirections({ ...where, ...fakeFetch(200, '<html>proxy login</html>') })
    expect(failureOf(result).kind).toBe('malformed')
  })

  it('reports a network failure without leaking the request', async () => {
    const fetchImpl = (() => Promise.reject(new TypeError(`Failed to fetch ${TOKEN}`))) as typeof fetch
    const result = failureOf(await fetchDirections({ ...where, fetchImpl }))
    expect(result).toMatchObject({ kind: 'network', message: 'Could not reach Mapbox. Check your internet connection and try again.' })
    expect(result.message).not.toContain(TOKEN)
  })

  it('reports an aborted request as aborted, before or during the fetch', async () => {
    const controller = new AbortController()
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })) as typeof fetch
    const pending = fetchDirections({ ...where, signal: controller.signal, fetchImpl })
    controller.abort()
    expect(failureOf(await pending)).toMatchObject({ kind: 'aborted', message: 'Route request cancelled.' })

    // Aborted while the response was already on its way: still not a result to show.
    const late = fetchDirections({ ...where, signal: controller.signal, ...fakeFetch(200, OK) })
    expect(failureOf(await late).kind).toBe('aborted')
  })

  it('never shows the token, even if Mapbox echoes it back', async () => {
    const echo = { code: 'InvalidInput', message: `Bad query: access_token=${TOKEN}` }
    const result = failureOf(await fetchDirections({ ...where, ...fakeFetch(422, echo) }))
    expect(result.message).not.toContain(TOKEN)
    expect(result.message).toContain('[token]')
  })

  it('does not call fetch for an invalid coordinate', async () => {
    const { fetchImpl, calls } = fakeFetch(200, OK)
    const result = await fetchDirections({ ...where, origin: [NaN, NaN], fetchImpl })
    expect(failureOf(result).kind).toBe('malformed')
    expect(calls).toHaveLength(0)
  })
})

describe('fetchProbeRoute (side-street probes)', () => {
  const via = [-80.84, 35.18] as const
  const where = { origin: UPTOWN_CHARLOTTE.position, via, destination: SOUTHPARK.position, token: TOKEN }

  function answer(status: number, body: unknown) {
    const urls: string[] = []
    const fetchImpl = ((input: RequestInfo | URL) => {
      urls.push(String(input))
      return Promise.resolve(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }))
    }) as typeof fetch
    return { fetchImpl, urls }
  }

  it('asks driving-traffic for origin, via, destination with the via as a silent waypoint, and returns one route', async () => {
    const { fetchImpl, urls } = answer(200, OK)
    const route = await fetchProbeRoute({ ...where, fetchImpl })
    expect(route).not.toBeNull()
    expect(urls).toHaveLength(1)
    const url = new URL(urls[0]!)
    expect(url.pathname).toContain('/directions/v5/mapbox/driving-traffic/')
    expect(decodeURIComponent(url.pathname).split('/').at(-1)!.split(';')).toHaveLength(3)
    expect(url.searchParams.get('waypoints')).toBe('0;2')
    expect(url.searchParams.get('alternatives')).toBe('false')
    expect(url.searchParams.get('steps')).toBe('true')
    // No radius asked for: no radiuses parameter, every coordinate snaps as far as it must.
    expect(url.searchParams.has('radiuses')).toBe(false)
  })

  it('limits how far the via may snap with one radiuses entry per coordinate, the ends unlimited', async () => {
    const { fetchImpl, urls } = answer(200, OK)
    await fetchProbeRoute({ ...where, viaRadiusM: DEFAULT_PROBE_OPTIONS.viaRadiusM, fetchImpl })
    const url = new URL(urls[0]!)
    expect(url.searchParams.get('radiuses')).toBe('unlimited;250;unlimited')
    expect(url.searchParams.get('radiuses')!.split(';')).toHaveLength(decodeURIComponent(url.pathname).split('/').at(-1)!.split(';').length)
    // Mapbox needs a radius greater than 0: a tiny one is sent as 1 m, never "0".
    const tiny = answer(200, OK)
    await fetchProbeRoute({ ...where, viaRadiusM: 0.2, fetchImpl: tiny.fetchImpl })
    expect(new URL(tiny.urls[0]!).searchParams.get('radiuses')).toBe('unlimited;1;unlimited')
    // A radius that is not a positive number is no limit at all, so the parameter is left out.
    for (const viaRadiusM of [0, -5, Number.NaN]) {
      const bad = answer(200, OK)
      await fetchProbeRoute({ ...where, viaRadiusM, fetchImpl: bad.fetchImpl })
      expect(new URL(bad.urls[0]!).searchParams.has('radiuses')).toBe(false)
    }
  })

  it('drops NoSegment, NoRoute, HTTP, network and abort failures as null, never throwing', async () => {
    const noSegment = { code: 'NoSegment', message: 'Could not find a matching segment for input coordinates' }
    expect(await fetchProbeRoute({ ...where, ...answer(200, noSegment) })).toBeNull()
    expect(await fetchProbeRoute({ ...where, ...answer(200, NO_ROUTE) })).toBeNull()
    expect(await fetchProbeRoute({ ...where, ...answer(429, { message: 'Too Many Requests' }) })).toBeNull()
    expect(await fetchProbeRoute({ ...where, ...answer(500, 'down') })).toBeNull()
    const offline = (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch
    expect(await fetchProbeRoute({ ...where, fetchImpl: offline })).toBeNull()
    const controller = new AbortController()
    controller.abort()
    expect(await fetchProbeRoute({ ...where, signal: controller.signal, ...answer(200, OK) })).toBeNull()
  })

  it('makes no request for a via that is not a coordinate (it would come back as the plain route)', async () => {
    const { fetchImpl, urls } = answer(200, OK)
    expect(await fetchProbeRoute({ ...where, via: [Number.NaN, 35.18], fetchImpl })).toBeNull()
    expect(urls).toHaveLength(0)
  })
})
