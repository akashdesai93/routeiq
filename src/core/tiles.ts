import { isValidLngLat } from './geo.ts'
import type { BBox, LngLat } from './types.ts'

/**
 * Signal data is loaded in square tiles of a tenth of a degree (about 9 km
 * east-west and 11 km north-south at Charlotte), and only for the tiles a
 * route touches. This file is the tile arithmetic: which tile a point is in,
 * the box a tile covers, and the tiles a route needs. Pure.
 *
 * A tile id is "<x>_<y>": the tile's west edge in whole tenths of a degree of
 * longitude and its south edge in whole tenths of a degree of latitude, so
 * "-809_352" covers longitude -80.9 to -80.8 and latitude 35.2 to 35.3. A
 * point on an edge belongs to the tile to its east or north.
 */
export const TILE_SIZE_DEG = 0.1

const TILES_PER_DEGREE = 10
const X_MIN = -180 * TILES_PER_DEGREE
const X_COUNT = 360 * TILES_PER_DEGREE
const Y_MIN = -90 * TILES_PER_DEGREE
const Y_MAX = 90 * TILES_PER_DEGREE - 1

/**
 * Whole tenths of a degree at or below `degrees`: always rounds down, so
 * -80.84 gives -809 (truncating would give -808, the tile next door). The
 * value is first snapped to a whole number of 1e-7 degrees (about a
 * centimeter), which is what keeps a coordinate that sits on a tile edge,
 * such as -80.8, from landing on the wrong side through floating-point error.
 */
function tenthsBelow(degrees: number): number {
  return Math.floor(Math.round(degrees * 1e7) / 1e6)
}

/** Longitude wraps around the antimeridian: 180 is the same line as -180. */
function wrapX(x: number): number {
  return ((((x - X_MIN) % X_COUNT) + X_COUNT) % X_COUNT) + X_MIN
}

function clampY(y: number): number {
  return Math.min(Y_MAX, Math.max(Y_MIN, y))
}

function tileIdOf(x: number, y: number): string {
  return `${wrapX(x)}_${clampY(y)}`
}

/** The id of the tile that holds a point. */
export function tileIdAt([lng, lat]: LngLat): string {
  return tileIdOf(tenthsBelow(lng), tenthsBelow(lat))
}

/** The box a tile covers, [west, south, east, north]. Null for anything that is not a tile id. */
export function tileBounds(tileId: string): BBox | null {
  const match = /^(-?\d+)_(-?\d+)$/.exec(tileId)
  if (match === null) return null
  const x = Number(match[1])
  const y = Number(match[2])
  if (x < X_MIN || x >= X_MIN + X_COUNT || y < Y_MIN || y > Y_MAX) return null
  // Dividing a whole number by ten gives the closest value there is to the edge: -809 -> -80.9.
  return [x / TILES_PER_DEGREE, y / TILES_PER_DEGREE, (x + 1) / TILES_PER_DEGREE, (y + 1) / TILES_PER_DEGREE]
}

const M_PER_DEGREE = (6_371_008.8 * Math.PI) / 180

/** A route segment is walked in pieces no longer than this, so a long one cannot step over a tile. */
const PIECE_DEG = TILE_SIZE_DEG / 2

/**
 * Every tile a route needs signal data for: the tiles the line passes through
 * (long segments included, not only their end points) plus any tile within
 * `marginM` of the line. The margin is what keeps an intersection whose
 * signals straddle a tile edge whole: the caller passes the largest distance
 * at which a signal can still matter to the route.
 *
 * The result can hold a tile the line only comes near (it is built from small
 * boxes around pieces of the line), never fewer than needed. A segment whose
 * ends are more than 180 degrees of longitude apart is taken the short way,
 * across the antimeridian. Invalid points are ignored. Sorted, no repeats.
 */
export function tilesForRoute(geometry: readonly LngLat[], marginM = 0): string[] {
  const line = geometry.filter(isValidLngLat)
  const ids = new Set<string>()
  const margin = Number.isFinite(marginM) && marginM > 0 ? marginM : 0
  const padLat = margin / M_PER_DEGREE

  const addBox = (lngA: number, latA: number, lngB: number, latB: number) => {
    const south = Math.min(latA, latB) - padLat
    const north = Math.max(latA, latB) + padLat
    // A degree of longitude shrinks toward the poles; the floor keeps the padding finite there.
    const widest = Math.max(Math.abs(south), Math.abs(north))
    const padLng = padLat / Math.max(0.01, Math.cos((Math.min(89.9, widest) * Math.PI) / 180))
    const x0 = tenthsBelow(Math.min(lngA, lngB) - padLng)
    const x1 = tenthsBelow(Math.max(lngA, lngB) + padLng)
    const y0 = tenthsBelow(south)
    const y1 = tenthsBelow(north)
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) ids.add(tileIdOf(x, y))
  }

  const first = line[0]
  if (first !== undefined && line.length === 1) addBox(first[0], first[1], first[0], first[1])
  for (let i = 1; i < line.length; i++) {
    const [aLng, aLat] = line[i - 1]!
    const [rawLng, bLat] = line[i]!
    // Past 180 the longitude is left unwrapped here; tileIdOf wraps it.
    const bLng = rawLng - aLng > 180 ? rawLng - 360 : rawLng - aLng < -180 ? rawLng + 360 : rawLng
    const pieces = Math.max(1, Math.ceil(Math.max(Math.abs(bLng - aLng), Math.abs(bLat - aLat)) / PIECE_DEG))
    for (let k = 0; k < pieces; k++) {
      const t0 = k / pieces
      const t1 = (k + 1) / pieces
      addBox(
        aLng + (bLng - aLng) * t0,
        aLat + (bLat - aLat) * t0,
        aLng + (bLng - aLng) * t1,
        aLat + (bLat - aLat) * t1,
      )
    }
  }
  return [...ids].sort()
}
