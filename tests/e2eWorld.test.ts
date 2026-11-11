import { describe, expect, it } from 'vitest'
import { parseDirections } from '../src/providers/mapbox/adapter.ts'
import { FREE_FLOW, World, along, sideStep, type LngLat } from '../e2e/world/roads.ts'

// The e2e scenarios answer Directions requests from a made-up road network
// (e2e/world/roads.ts). These checks keep that stand-in honest: what it sends
// must go through the real adapter like a Mapbox response does.

const UPTOWN: LngLat = [-80.8431, 35.2271]
const INDIAN_LAND: LngLat = [-80.8561, 35.0015]

describe('e2e road network', () => {
  const world = new World(UPTOWN, INDIAN_LAND)

  it('offers three routes from the trip origin that the real adapter reads, with turns and voice', () => {
    const result = parseDirections(world.directions(UPTOWN, FREE_FLOW, 1))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.routes).toHaveLength(3)
    for (const route of result.routes) {
      expect(route.typicalDurationSec).not.toBeNull()
      expect(route.intersections?.some((i) => i.signal)).toBe(true)
      expect(route.guidance?.length ?? 0).toBeGreaterThan(3)
      expect((route.guidance ?? []).every((g) => !g.synthesized)).toBe(true)
    }
    // Free-flowing, the direct route is the fastest and is offered first.
    expect(world.lastOffered[0]!.name).toBe('A')
  })

  it('offers only the rest of the routes that pass the car, and a way back after a wrong turn', () => {
    const a = world.cornersOf('A')
    const early = along(a, 3000).point
    world.directions(early, FREE_FLOW, 2)
    expect(world.lastOffered.map((r) => r.name).sort()).toEqual(['A', 'B', 'C'])
    const late = along(a, 21_000).point
    world.directions(late, FREE_FLOW, 3)
    expect(world.lastOffered.map((r) => r.name)).toEqual(['A'])
    const off = sideStep(early, along(a, 3000).headingDeg, 300)
    const result = parseDirections(world.directions(off, FREE_FLOW, 4))
    expect(result.ok).toBe(true)
    expect(world.lastOffered.map((r) => r.name)).toEqual(['off-route'])
  })

  it('answers a via request along the road nearest the via, S only when the world has it, NoSegment far from every road', () => {
    const withS = new World(UPTOWN, INDIAN_LAND, { sideStreet: true })
    withS.directions(UPTOWN, FREE_FLOW, 1)
    const offered = withS.lastOffered.map((r) => r.name)
    expect(offered).not.toContain('S')
    const a = withS.cornersOf('A')
    const middle = along(a, 12_950)
    // 500 m to the right of A's middle (west, heading south): 200 m from S, 500 m from A.
    const west = sideStep(middle.point, middle.headingDeg, -500)
    const viaS = withS.through(UPTOWN, west, FREE_FLOW, 1)
    expect(viaS.road).toBe('S')
    const parsed = parseDirections(viaS.answer)
    expect(parsed.ok && parsed.routes).toHaveLength(1)
    // In free flow S is slower than all three of Mapbox's routes.
    expect(viaS.durationSec!).toBeGreaterThan(Math.max(...withS.lastOffered.map((r) => r.durationSec)))
    expect(withS.lastOffered.map((r) => r.name)).toEqual(offered)
    // Without S the same via snaps back onto A.
    expect(world.through(UPTOWN, west, FREE_FLOW, 1).road).toBe('A')
    const far = world.through(UPTOWN, sideStep(middle.point, middle.headingDeg, -5000), FREE_FLOW, 1)
    expect(far.road).toBeNull()
    const noSegment = parseDirections(far.answer)
    expect(!noSegment.ok && noSegment.kind).toBe('no-segment')
  })
})
