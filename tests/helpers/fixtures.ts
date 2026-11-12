import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { localProjector, pointToSegment, type LngLat, type RouteCandidate } from '../../src/core/index.ts'
import { parseDirections } from '../../src/providers/mapbox/adapter.ts'

/** A hand-written fixture from tests/fixtures, parsed as JSON. */
export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', name), 'utf8'))
}

/** The routes of a Directions fixture, through the real adapter. Throws when the fixture is not a route answer. */
export function fixtureRoutes(name: string): readonly RouteCandidate[] {
  const result = parseDirections(fixture(name))
  if (!result.ok) throw new Error(`expected routes, got ${result.kind}`)
  return result.routes
}

/** Meters from `point` to the nearest segment of `line`, on a flat plane around the point. Infinity for a line of fewer than two points. */
export function lineDistanceM(point: LngLat, line: readonly LngLat[]): number {
  const project = localProjector(point)
  let best = Infinity
  for (let i = 1; i < line.length; i++) {
    best = Math.min(best, pointToSegment(project(point), project(line[i - 1]!), project(line[i]!)).distanceM)
  }
  return best
}
