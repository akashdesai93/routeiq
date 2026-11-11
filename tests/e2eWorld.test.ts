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
})
