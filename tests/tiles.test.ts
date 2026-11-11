import { describe, expect, it } from 'vitest'
import {
  SOUTHPARK,
  signalTilesForRoute,
  TILE_SIZE_DEG,
  tileBounds,
  tileIdAt,
  tilesForRoute,
  UPTOWN_CHARLOTTE,
  type LngLat,
} from '../src/core/index.ts'

describe('tileIdAt', () => {
  it('names a tile by its south-west corner in whole tenths of a degree', () => {
    expect(TILE_SIZE_DEG).toBe(0.1)
    expect(tileIdAt(UPTOWN_CHARLOTTE.position)).toBe('-809_352')
    expect(tileIdAt(SOUTHPARK.position)).toBe('-809_351')
    // North-east, south-east and south-west of the origin.
    expect(tileIdAt([2.3522, 48.8566])).toBe('23_488')
    expect(tileIdAt([151.2093, -33.8568])).toBe('1512_-339')
    expect(tileIdAt([-58.3816, -34.6037])).toBe('-584_-347')
  })

  it('rounds down, not toward zero: negative coordinates are where truncating goes wrong', () => {
    // Charlotte is at negative longitude. Truncating -808.43 gives -808, the tile next door to the east.
    expect(tileIdAt([-80.8431, 35.2271])).not.toBe('-808_352')
    expect(tileIdAt([-80.8431, 35.2271])).toBe('-809_352')
    // Either side of zero is two different tiles, not one double-width tile.
    expect(tileIdAt([0.05, 0.05])).toBe('0_0')
    expect(tileIdAt([-0.05, -0.05])).toBe('-1_-1')
    expect(tileIdAt([-0.05, 0.05])).toBe('-1_0')
    expect(tileIdAt([0, 0])).toBe('0_0')
    expect(tileIdAt([-0, -0])).toBe('0_0')
  })

  it('puts a point on a tile edge in the tile to its east or north, without floating-point drift', () => {
    expect(tileIdAt([-80.8, 35.2])).toBe('-808_352')
    expect(tileIdAt([-80.80001, 35.19999])).toBe('-809_351')
    // Sums that do not land exactly on the tenth they mean.
    expect(0.1 + 0.2).not.toBe(0.3)
    expect(tileIdAt([0.1 + 0.2, 0.1 + 0.2])).toBe('3_3')
    expect(tileIdAt([0.1 - 0.4, 0.7 - 0.8])).toBe('-3_-1')
    // Every edge there is: x tenths of a degree is the west edge of tile x.
    for (let x = -1800; x < 1800; x++) expect(tileIdAt([x / 10, 0])).toBe(`${x}_0`)
    for (let y = -900; y < 900; y++) expect(tileIdAt([0, y / 10])).toBe(`0_${y}`)
    for (let x = -1800; x < 1800; x += 7) expect(tileIdAt([x * 0.1, 0])).toBe(`${x}_0`)
  })

  it('wraps longitude at the antimeridian and stops latitude at the poles', () => {
    expect(tileIdAt([179.95, 0])).toBe('1799_0')
    expect(tileIdAt([-179.95, 0])).toBe('-1800_0')
    // 180 and -180 are the same line.
    expect(tileIdAt([180, 0])).toBe('-1800_0')
    expect(tileIdAt([-180, 0])).toBe('-1800_0')
    expect(tileIdAt([0, 90])).toBe('0_899')
    expect(tileIdAt([0, -90])).toBe('0_-900')
  })
})

describe('tileBounds', () => {
  it('gives the box of a tile, with clean edges', () => {
    expect(tileBounds('-809_352')).toEqual([-80.9, 35.2, -80.8, 35.3])
    expect(tileBounds('0_0')).toEqual([0, 0, 0.1, 0.1])
    expect(tileBounds('-1_-1')).toEqual([-0.1, -0.1, 0, 0])
    expect(tileBounds('1799_899')).toEqual([179.9, 89.9, 180, 90])
  })

  it('agrees with tileIdAt: the south-west corner and the middle of a tile are in it', () => {
    for (const id of ['-809_352', '-808_351', '0_0', '-1_-1', '1512_-339', '-1800_-900', '1799_899', '3_3']) {
      const [west, south, east, north] = tileBounds(id)!
      expect(tileIdAt([west, south])).toBe(id)
      expect(tileIdAt([(west + east) / 2, (south + north) / 2])).toBe(id)
    }
  })

  it('is null for anything that is not a tile id', () => {
    for (const bad of ['', 'x', '-809', '-809_', '_352', '1800_0', '-1801_0', '0_900', '0_-901', '1.5_2', '-809_352_1']) {
      expect(tileBounds(bad), bad).toBeNull()
    }
  })
})

describe('tilesForRoute', () => {
  it('lists the tiles the line is in, sorted, each once', () => {
    expect(tilesForRoute([UPTOWN_CHARLOTTE.position, SOUTHPARK.position])).toEqual(['-809_351', '-809_352'])
    const back = [SOUTHPARK.position, UPTOWN_CHARLOTTE.position, SOUTHPARK.position]
    expect(tilesForRoute(back)).toEqual(['-809_351', '-809_352'])
    expect(tilesForRoute([[-80.85, 35.25], [-80.84, 35.26]])).toEqual(['-809_352'])
  })

  it('includes the tiles a long segment crosses, not only the ones its ends are in', () => {
    // Two points 40 km apart: five tiles in a row.
    expect(tilesForRoute([[-80.95, 35.25], [-80.55, 35.25]])).toEqual([
      '-806_352',
      '-807_352',
      '-808_352',
      '-809_352',
      '-810_352',
    ])
    // A long diagonal: every tile a point of the line falls in is listed.
    const a: LngLat = [-81.03, 35.02]
    const b: LngLat = [-80.31, 35.77]
    const tiles = new Set(tilesForRoute([a, b]))
    for (let i = 0; i <= 5000; i++) {
      const t = i / 5000
      expect(tiles.has(tileIdAt([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]))).toBe(true)
    }
    // And not the whole bounding box: the corners far from the line are left out.
    expect(tiles.has(tileIdAt([-81.03, 35.75]))).toBe(false)
    expect(tiles.has(tileIdAt([-80.31, 35.03]))).toBe(false)
  })

  it('adds the neighboring tile when the line runs within the margin of an edge', () => {
    // North along a road 18 m east of the tile edge at longitude -80.8.
    const road: LngLat[] = [[-80.7998, 35.21], [-80.7998, 35.29]]
    expect(tilesForRoute(road)).toEqual(['-808_352'])
    expect(tilesForRoute(road, 10)).toEqual(['-808_352'])
    expect(tilesForRoute(road, 130)).toEqual(['-808_352', '-809_352'])
    // A margin that is negative or not a number is no margin.
    expect(tilesForRoute(road, -500)).toEqual(['-808_352'])
    expect(tilesForRoute(road, NaN)).toEqual(['-808_352'])
    // The signal rules reach 60 + 30 + 40 m, so that is the margin signal data is loaded with.
    expect(signalTilesForRoute(road)).toEqual(['-808_352', '-809_352'])
    expect(signalTilesForRoute(road, { clusterRadiusM: 0, toleranceM: 5, intersectionRadiusM: 5 })).toEqual(['-808_352'])
    // A corner: within the margin of two edges means four tiles.
    expect(tilesForRoute([[-80.7999, 35.2001], [-80.7998, 35.2002]], 130)).toEqual([
      '-808_351',
      '-808_352',
      '-809_351',
      '-809_352',
    ])
  })

  it('takes a segment across the antimeridian the short way', () => {
    // 11 km across the 180 degree line, not 359.9 degrees around the world.
    expect(tilesForRoute([[179.95, 10.05], [-179.95, 10.05]])).toEqual(['-1800_100', '1799_100'])
    expect(tilesForRoute([[-179.95, 10.05], [179.95, 10.05]])).toEqual(['-1800_100', '1799_100'])
    // The margin wraps too.
    expect(tilesForRoute([[179.9995, 10.05], [179.9996, 10.05]], 130)).toEqual(['-1800_100', '1799_100'])
    // Just short of half way round is still taken as drawn.
    expect(tilesForRoute([[-80, 0.05], [80, 0.05]]).length).toBeGreaterThan(1500)
  })

  it('ignores invalid points and handles empty and single-point lines', () => {
    expect(tilesForRoute([])).toEqual([])
    expect(tilesForRoute([[NaN, 35]])).toEqual([])
    expect(tilesForRoute([UPTOWN_CHARLOTTE.position])).toEqual(['-809_352'])
    expect(tilesForRoute([UPTOWN_CHARLOTTE.position, [999, 0], [NaN, NaN], SOUTHPARK.position])).toEqual([
      '-809_351',
      '-809_352',
    ])
  })
})
