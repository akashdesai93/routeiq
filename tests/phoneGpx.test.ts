import { describe, expect, it } from 'vitest'
import {
  buildTrack,
  DEFAULT_GPX_OPTIONS,
  distanceM,
  interpolateTrack,
  main,
  parseArgs,
  parseWaypoints,
  pathFrom,
  pathLengthM,
  toGpx,
  type LngLat,
} from '../scripts/phone/make-gpx.mjs'
import { PRESET_LEAVES_ROUTE_AT_M, PRESETS } from '../scripts/phone/presets.mjs'

// The GPX maker for simulated drives on the phone (docs/phone-sim-location.md). It is pure:
// no network, no clock. The coordinates are public landmarks in Charlotte.

const UPTOWN: LngLat = [-80.8431, 35.2271]
const M_PER_DEGREE_LAT = 111_195

/** A point `northM` meters north and `eastM` meters east of Uptown. */
function offset(northM: number, eastM: number): LngLat {
  return [UPTOWN[0] + eastM / (M_PER_DEGREE_LAT * Math.cos((UPTOWN[1] * Math.PI) / 180)), UPTOWN[1] + northM / M_PER_DEGREE_LAT]
}

/** Meters from a point to the nearest place on a path (flat-plane, fine over a few hundred meters). */
function distanceToPathM(point: LngLat, path: readonly LngLat[]): number {
  const kx = M_PER_DEGREE_LAT * Math.cos((point[1] * Math.PI) / 180)
  let best = Infinity
  for (let i = 1; i < path.length; i++) {
    const ax = (path[i - 1][0] - point[0]) * kx
    const ay = (path[i - 1][1] - point[1]) * M_PER_DEGREE_LAT
    const bx = (path[i][0] - point[0]) * kx
    const by = (path[i][1] - point[1]) * M_PER_DEGREE_LAT
    const lengthSq = (bx - ax) ** 2 + (by - ay) ** 2
    const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, -(ax * (bx - ax) + ay * (by - ay)) / lengthSq))
    best = Math.min(best, Math.hypot(ax + t * (bx - ax), ay + t * (by - ay)))
  }
  return best
}

const steps = (track: readonly LngLat[]) => track.slice(1).map((point, i) => distanceM(track[i], point))

describe('interpolateTrack', () => {
  it('puts a point every 13 m on a straight street by default', () => {
    const track = interpolateTrack([UPTOWN, offset(130, 0)])
    expect(DEFAULT_GPX_OPTIONS.speedMps).toBe(13)
    expect(DEFAULT_GPX_OPTIONS.intervalSec).toBe(1)
    // 130 m at 13 m/s: the start and ten more points.
    expect(track).toHaveLength(11)
    for (const step of steps(track)) expect(step).toBeCloseTo(13, 1)
    expect(track[0]).toEqual(UPTOWN)
    expect(track.at(-1)).toEqual(offset(130, 0))
  })

  it('ends on the last waypoint exactly, with a shorter last step', () => {
    const end = offset(100, 0)
    const track = interpolateTrack([UPTOWN, end])
    // 100 m: seven full steps (91 m), then 9 m.
    expect(track).toHaveLength(9)
    expect(track.at(-1)).toEqual(end)
    const all = steps(track)
    for (const step of all.slice(0, -1)) expect(step).toBeCloseTo(13, 1)
    expect(all.at(-1)).toBeCloseTo(9, 0)
  })

  it('drives around a corner: the distance carries over and no point cuts across', () => {
    // 20 m north, then 200 m east. The second point is due 13 m in, the third 6 m past the corner.
    const corner = offset(20, 0)
    const path = [UPTOWN, corner, offset(20, 200)]
    const track = interpolateTrack(path)
    expect(distanceM(track[1], UPTOWN)).toBeCloseTo(13, 1)
    expect(distanceM(track[2], corner)).toBeCloseTo(6, 1)
    expect(track[2][1]).toBeCloseTo(corner[1], 9)
    for (const point of track) expect(distanceToPathM(point, path)).toBeLessThan(0.01)
    expect(track).toHaveLength(Math.floor(220 / 13) + 2)
  })

  it('passes several short pieces between two points without dropping distance', () => {
    // Ten 4 m pieces: shorter than a step, so most hold no point of their own.
    const path = Array.from({ length: 11 }, (_, i) => offset(i * 4, 0))
    const track = interpolateTrack(path)
    expect(track).toHaveLength(5)
    expect(steps(track).map((step) => Math.round(step))).toEqual([13, 13, 13, 1])
  })

  it('follows the speed and the interval', () => {
    const path = [UPTOWN, offset(0, 300)]
    for (const step of steps(interpolateTrack(path, { speedMps: 25 })).slice(0, -1)) expect(step).toBeCloseTo(25, 1)
    for (const step of steps(interpolateTrack(path, { speedMps: 10, intervalSec: 2 })).slice(0, -1)) expect(step).toBeCloseTo(20, 1)
  })

  it('skips repeated waypoints and stands still for a single one', () => {
    expect(interpolateTrack([UPTOWN, UPTOWN, offset(26, 0), offset(26, 0)])).toHaveLength(3)
    expect(interpolateTrack([UPTOWN])).toEqual([UPTOWN])
    expect(interpolateTrack([UPTOWN, UPTOWN])).toEqual([UPTOWN])
  })

  it('refuses no waypoints, and a speed that is not positive', () => {
    expect(() => interpolateTrack([])).toThrow(RangeError)
    expect(() => interpolateTrack([UPTOWN, offset(50, 0)], { speedMps: 0 })).toThrow(RangeError)
    expect(() => interpolateTrack([UPTOWN, offset(50, 0)], { speedMps: Number.NaN })).toThrow(RangeError)
  })

  it('gives the same track for the same input', () => {
    const path = PRESETS['wrong-turn'].waypoints
    expect(interpolateTrack(path)).toEqual(interpolateTrack(path))
  })
})

describe('pathFrom and buildTrack', () => {
  const path = [UPTOWN, offset(100, 0), offset(100, 100)]

  it('starts a path part of the way along', () => {
    const rest = pathFrom(path, 150)
    expect(pathLengthM(rest)).toBeCloseTo(50, 0)
    expect(distanceM(rest[0], offset(100, 50))).toBeLessThan(0.1)
    expect(pathFrom(path, 0)).toEqual(path)
    expect(pathFrom(path, 5000)).toEqual([offset(100, 100)])
  })

  it('stands at the start for the hold, then sets off', () => {
    const track = buildTrack(path, { holdSec: 5 })
    expect(track.slice(0, 6)).toEqual(Array(6).fill(UPTOWN))
    expect(distanceM(track[6], UPTOWN)).toBeCloseTo(13, 1)
    expect(track).toHaveLength(5 + interpolateTrack(path).length)
  })

  it('cuts the track after the seconds asked for', () => {
    // 30 seconds is 31 points: 0 s to 30 s.
    expect(buildTrack(PRESETS['wrong-turn'].waypoints, { maxSec: 30 })).toHaveLength(31)
    expect(buildTrack(path, { maxSec: 10_000 })).toHaveLength(interpolateTrack(path).length)
  })
})

describe('presets', () => {
  const route = PRESETS['uptown-to-southpark'].waypoints

  it('all start in Uptown and end at SouthPark', () => {
    for (const { waypoints } of Object.values(PRESETS)) {
      expect(distanceM(waypoints[0], UPTOWN)).toBeLessThan(30)
      expect(distanceM(waypoints.at(-1)!, [-80.8295, 35.1527])).toBeLessThan(60)
    }
    expect(pathLengthM(route) / 1000).toBeCloseTo(10.15, 1)
  })

  it('wrong-turn leaves the route for a parallel street and comes back', () => {
    const track = interpolateTrack(PRESETS['wrong-turn'].waypoints)
    const off = track.map((point) => distanceToPathM(point, route) > 50)
    const firstOff = off.indexOf(true)
    const lastOff = off.lastIndexOf(true)
    // One excursion, starting where the constant says, and long enough to be noticed.
    expect(off.slice(firstOff, lastOff + 1).every(Boolean)).toBe(true)
    expect(Math.abs(firstOff * 13 - PRESET_LEAVES_ROUTE_AT_M['wrong-turn'])).toBeLessThan(120)
    const offM = (lastOff - firstOff) * 13
    expect(offM).toBeGreaterThan(500)
    expect(offM).toBeLessThan(900)
    expect(Math.max(...track.map((point) => distanceToPathM(point, route)))).toBeLessThan(300)
    expect(distanceToPathM(track.at(-1)!, route)).toBeLessThan(1)
  })

  it('turn-around drives past the turn, comes back the same way and carries on', () => {
    const waypoints = PRESETS['turn-around'].waypoints
    expect(pathLengthM(waypoints) - pathLengthM(route)).toBeCloseTo(900, -2)
    const track = interpolateTrack(waypoints)
    const off = track.map((point) => distanceToPathM(point, route) > 50)
    expect(Math.abs(off.indexOf(true) * 13 - PRESET_LEAVES_ROUTE_AT_M['turn-around'])).toBeLessThan(120)
    // The farthest point is the turning point, about 450 m from the route's turn.
    const farthest = Math.max(...track.map((point) => distanceToPathM(point, route)))
    expect(farthest).toBeGreaterThan(300)
    expect(farthest).toBeLessThan(460)
  })
})

describe('toGpx', () => {
  it('writes one timed point per second, latitude and longitude the right way round', () => {
    const gpx = toGpx([UPTOWN, offset(13, 0), offset(26, 0)], { name: 'a <test> & more' })
    const points = [...gpx.matchAll(/<trkpt lat="([-\d.]+)" lon="([-\d.]+)"><time>([^<]+)<\/time><\/trkpt>/g)]
    expect(points).toHaveLength(3)
    expect(points[0].slice(1)).toEqual(['35.227100', '-80.843100', '2026-01-01T00:00:00.000Z'])
    expect(points.map((point) => point[3].slice(17, 19))).toEqual(['00', '01', '02'])
    expect(gpx).toContain('<name>a &lt;test&gt; &amp; more</name>')
    expect(gpx.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1"')).toBe(true)
  })

  it('refuses a start time that is not a date', () => {
    expect(() => toGpx([UPTOWN], { startTime: 'soon' })).toThrow(RangeError)
  })
})

describe('the command line', () => {
  it('reads waypoints, longitude first', () => {
    expect(parseWaypoints('-80.8431,35.2271;-80.8295,35.1527')).toEqual([UPTOWN, [-80.8295, 35.1527]])
    expect(parseWaypoints('-80.8431,35.2271')).toHaveProperty('error')
    expect(parseWaypoints('35.2271,-80.8431;1,2,3')).toHaveProperty('error')
    // Latitude first by mistake: -80.8 is no latitude... but 35.2 is a fine longitude, so only the range catches it.
    expect(parseWaypoints('35.2271,-180.5;0,0')).toHaveProperty('error')
  })

  it('wants a preset or waypoints, not both and not neither', () => {
    expect(parseArgs([])).toHaveProperty('error')
    expect(parseArgs(['--preset', 'wrong-turn', '--waypoints', '0,0;1,1'])).toHaveProperty('error')
    expect(parseArgs(['--preset', 'nowhere'])).toHaveProperty('error')
    expect(parseArgs(['--preset', 'wrong-turn', '--speed', 'fast'])).toHaveProperty('error')
    expect(parseArgs(['--preset', 'wrong-turn', '--speed', '500'])).toHaveProperty('error')
    expect(parseArgs(['--preset', 'wrong-turn', '--speed', '20', '--hold', '60', '--from-m', '4400', '--seconds', '90'])).toMatchObject({
      preset: 'wrong-turn',
      speedMps: 20,
      holdSec: 60,
      fromM: 4400,
      maxSec: 90,
    })
  })

  it('prints the GPX and nothing else on standard output', async () => {
    const out: string[] = []
    const notes: string[] = []
    const code = await main(['--preset', 'wrong-turn', '--seconds', '30'], { log: (line) => notes.push(line), write: (text) => out.push(text) })
    expect(code).toBe(0)
    expect(notes).toEqual([])
    expect(out.join('').match(/<trkpt /g)).toHaveLength(31)
    expect(await main(['--nonsense'], { log: (line) => notes.push(line), write: () => {} })).toBe(2)
    expect(notes[0]).toContain('Usage:')
  })
})
