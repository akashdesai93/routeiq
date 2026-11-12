import { describe, expect, it } from 'vitest'
import { alongRouteM, lineFrom, type LngLat } from '../src/core/index.ts'
import { DRIVE_ROUTE_LAYER, DRIVE_ROUTE_SOURCE, DRIVE_SOURCE, driveLayers, type DriveMap } from '../src/map/driveLayers.ts'
import type { DriveOverlay } from '../src/map/driveFeatures.ts'

// #94: the live drive handed the map the whole rest of the route on every fix (about 66 kB of
// GeoJSON a second on a 60 km trip) to move one dot. What the drive layers hand the map now,
// counted over a minute of fixes: the route line only when the route changes, the car per fix.

/** A recorder in place of the Mapbox map: what each source was set to, and each trim. */
function recorder() {
  const sets: Record<string, { calls: number; bytes: number }> = {}
  const trims: [number, number][] = []
  const map: DriveMap = {
    getSource: (id) => ({
      setData: (data) => {
        const entry = (sets[id] ??= { calls: 0, bytes: 0 })
        entry.calls++
        entry.bytes += JSON.stringify(data).length
      },
    }),
    setPaintProperty: (layer, name, value) => {
      expect([layer, name]).toEqual([DRIVE_ROUTE_LAYER, 'line-trim-offset'])
      trims.push(value)
    },
  }
  return { map, sets, trims }
}

/** A 60 km road south from Uptown Charlotte, 3000 vertices, gently winding (a long trip, as in docs/performance.md). */
function longRoad(eastM = 0): LngLat[] {
  const line: LngLat[] = []
  for (let i = 0; i < 3000; i++) {
    const southM = i * 20
    const sideM = eastM + 30 * Math.sin(i / 25)
    line.push([-80.8431 + sideM / 91_000, 35.2271 - southM / 111_200])
  }
  return line
}

describe('drive layers on the map (#94)', () => {
  const route = longRoad()
  const other = longRoad(400)
  const turn = { at: route[1500]!, pending: false }

  /** One minute at 1 Hz and 15 m/s: on `route`, a switch to `other` at 30 s, and "keep previous" at 45 s. */
  const minute = (): DriveOverlay[] =>
    Array.from({ length: 60 }, (_, s) => {
      const alongM = 2000 + 15 * s
      const on = s >= 30 && s < 45 ? other : route
      const car = lineFrom(on, alongM)[0]!
      return { car, route: on, alongM, turn: s >= 30 && s < 45 ? turn : null }
    })

  it('sets the route line only when the route changes, and the car on each fix in under 1 kB', () => {
    const { map, sets, trims } = recorder()
    const layers = driveLayers(map)
    const fixes = minute()
    for (const drive of fixes) layers.update(drive)

    // Start, the switch, "keep previous": three times in a minute (0.05 a second), not 60.
    expect(sets[DRIVE_ROUTE_SOURCE]?.calls).toBe(3)
    expect(sets[DRIVE_SOURCE]?.calls).toBe(60)
    expect(sets[DRIVE_SOURCE]!.bytes / 60).toBeLessThanOrEqual(1024)
    // The part behind the car is trimmed off: one small paint change a fix, growing along each route.
    expect(trims).toHaveLength(60)
    for (const [start, end] of trims) {
      expect(start).toBe(0)
      expect(end).toBeGreaterThan(0)
      expect(end).toBeLessThan(0.1)
    }
    expect(trims[29]![1]).toBeGreaterThan(trims[0]![1])

    // Before #94 each fix handed over the rest of the route: about 3000 points, 60-odd kB.
    const before = JSON.stringify(lineFrom(route, fixes[0]!.alongM)).length
    expect(before).toBeGreaterThan(50 * 1024)
  })

  it('hands over nothing when nothing moved, and clears the map when the drive ends', () => {
    const { map, sets, trims } = recorder()
    const layers = driveLayers(map)
    const drive: DriveOverlay = { car: route[100]!, route, alongM: alongRouteM(route)[100]!, turn: null }
    layers.update(null)
    expect(sets).toEqual({})
    layers.update(drive)
    layers.update({ ...drive })
    layers.update({ ...drive })
    expect(sets[DRIVE_ROUTE_SOURCE]?.calls).toBe(1)
    expect(sets[DRIVE_SOURCE]?.calls).toBe(1)
    expect(trims).toHaveLength(1)

    layers.update(null)
    expect(sets[DRIVE_ROUTE_SOURCE]?.calls).toBe(2)
    expect(sets[DRIVE_SOURCE]?.calls).toBe(2)
    expect(trims.at(-1)).toEqual([0, 0])
  })

  it('a position with no route yet: only the car, whatever empty line comes with it', () => {
    const { map, sets } = recorder()
    const layers = driveLayers(map)
    layers.update({ car: route[0]!, route: [], alongM: 0, turn: null })
    layers.update({ car: route[1]!, route: [], alongM: 0, turn: null })
    expect(sets[DRIVE_ROUTE_SOURCE]).toBeUndefined()
    expect(sets[DRIVE_SOURCE]?.calls).toBe(2)
  })
})
