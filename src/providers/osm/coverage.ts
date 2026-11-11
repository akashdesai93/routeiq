import { isValidLngLat, tileBounds, tileIdAt, type BBox, type LngLat } from '../../core/index.ts'

/**
 * Which tiles a set of regional OpenStreetMap extracts covers IN FULL.
 *
 * A regional extract is clipped to a boundary polygon (Geofabrik publishes it
 * next to the extract as a `.poly` file). A tile that pokes outside the
 * boundary holds only the signals on the inside, so it would undercount
 * across the state line; only a tile that lies entirely inside the union of
 * the boundaries may be treated as complete. Pure: used by the build script
 * (scripts/build-signal-tiles.mjs), and tested without any extract.
 */

/** One closed ring of a boundary. `hole` rings (written "!name" in the file) cut area out. */
export interface PolyRing {
  readonly hole: boolean
  /** [lng, lat] corners; the last joins the first whether or not the file repeats it. */
  readonly points: readonly LngLat[]
}

/** One boundary: every ring of one `.poly` file. */
export interface BoundaryPoly {
  readonly name: string
  readonly rings: readonly PolyRing[]
  readonly bbox: BBox
}

/**
 * Reads the Osmosis polygon filter format:
 *
 *   north-carolina        name of the file
 *   1                     name of a ring ("!2" would be a hole)
 *      -7.49E+01  3.51E+01    longitude latitude, one corner per line
 *      ...
 *   END                   end of the ring
 *   END                   end of the file
 *
 * Null for anything that is not one, or that holds no usable ring.
 */
export function parsePoly(text: string): BoundaryPoly | null {
  const lines = text.split(/\r?\n/).map((line) => line.trim())
  const name = lines.shift()
  if (name === undefined || name === '') return null
  const rings: PolyRing[] = []
  let ring: { hole: boolean; points: LngLat[] } | null = null
  for (const line of lines) {
    if (line === '') continue
    if (ring === null) {
      if (line === 'END') break
      ring = { hole: line.startsWith('!'), points: [] }
    } else if (line === 'END') {
      if (ring.points.length < 3) return null
      rings.push(ring)
      ring = null
    } else {
      const [lng, lat, ...rest] = line.split(/\s+/).map(Number)
      if (lng === undefined || lat === undefined || rest.length > 0 || !isValidLngLat([lng, lat])) return null
      ring.points.push([lng, lat])
    }
  }
  if (ring !== null || rings.length === 0) return null
  let west = Infinity
  let south = Infinity
  let east = -Infinity
  let north = -Infinity
  for (const { points } of rings) {
    for (const [lng, lat] of points) {
      west = Math.min(west, lng)
      east = Math.max(east, lng)
      south = Math.min(south, lat)
      north = Math.max(north, lat)
    }
  }
  return { name, rings, bbox: [west, south, east, north] }
}

/** Even-odd rule over every ring: inside an outer ring and not inside a hole. */
export function pointInPoly(poly: BoundaryPoly, [x, y]: LngLat): boolean {
  const [west, south, east, north] = poly.bbox
  if (x < west || x > east || y < south || y > north) return false
  let inside = false
  for (const { points } of poly.rings) {
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [xi, yi] = points[i]!
      const [xj, yj] = points[j]!
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
    }
  }
  return inside
}

/** How far to either side of a boundary line the coverage test looks: about 10 cm. */
const SIDE_STEP_DEG = 1e-6
/** A boundary line inside a tile is tested at points no further apart than this: about 100 m. */
const SAMPLE_STEP_DEG = 1e-3

/**
 * True when every point of the box lies inside at least one of the
 * boundaries. The box is inside the union exactly when its corners are and no
 * piece of the union's edge passes through it; the union's edge is made of
 * pieces of the boundaries' own edges, so every boundary edge that runs
 * through the box is walked, and at each step both sides of it must be inside
 * some boundary. Where two boundaries meet along a shared line (two
 * neighboring states), each side is inside one of them and the box passes;
 * where they leave a gap, or only one of them is there, it fails.
 */
export function boxFullyInside(box: BBox, polys: readonly BoundaryPoly[]): boolean {
  const [west, south, east, north] = box
  const inUnion = (p: LngLat) => polys.some((poly) => pointInPoly(poly, p))
  const probes: LngLat[] = [
    [west, south],
    [west, north],
    [east, south],
    [east, north],
    [(west + east) / 2, (south + north) / 2],
  ]
  // Just inside the corners: a corner that sits exactly on a boundary line can read either way.
  const nudged = probes.map(
    ([x, y]): LngLat => [
      Math.min(east - SIDE_STEP_DEG, Math.max(west + SIDE_STEP_DEG, x)),
      Math.min(north - SIDE_STEP_DEG, Math.max(south + SIDE_STEP_DEG, y)),
    ],
  )
  if (!nudged.every(inUnion)) return false

  for (const poly of polys) {
    const [pw, ps, pe, pn] = poly.bbox
    if (pe < west || pw > east || pn < south || ps > north) continue
    for (const { points } of poly.rings) {
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [ax, ay] = points[j]!
        const [bx, by] = points[i]!
        if (Math.max(ax, bx) < west || Math.min(ax, bx) > east || Math.max(ay, by) < south || Math.min(ay, by) > north) {
          continue
        }
        // Liang-Barsky: the part of the edge a + t (b - a) that lies inside the box.
        const dx = bx - ax
        const dy = by - ay
        let t0 = 0
        let t1 = 1
        const clip = (p: number, q: number): boolean => {
          if (p === 0) return q >= 0
          const t = q / p
          if (p < 0) {
            if (t > t1) return false
            if (t > t0) t0 = t
          } else {
            if (t < t0) return false
            if (t < t1) t1 = t
          }
          return true
        }
        if (!clip(-dx, ax - west) || !clip(dx, east - ax) || !clip(-dy, ay - south) || !clip(dy, north - ay)) continue
        const length = Math.hypot(dx, dy)
        if (length === 0) continue
        const nx = (-dy / length) * SIDE_STEP_DEG
        const ny = (dx / length) * SIDE_STEP_DEG
        const steps = Math.max(1, Math.ceil(((t1 - t0) * length) / SAMPLE_STEP_DEG))
        for (let k = 0; k <= steps; k++) {
          // Half a step in from each end, so a sample never sits on a corner of the boundary.
          const t = t0 + ((t1 - t0) * (k + 0.5)) / (steps + 1)
          const x = ax + dx * t
          const y = ay + dy * t
          for (const side of [1, -1]) {
            const p: LngLat = [x + nx * side, y + ny * side]
            if (p[0] <= west || p[0] >= east || p[1] <= south || p[1] >= north) continue
            if (!inUnion(p)) return false
          }
        }
      }
    }
  }
  return true
}

/**
 * Every tile that lies entirely inside the union of the boundaries, sorted.
 * A tile on the outer edge of the union (it reaches into a neighboring state,
 * or out to sea past the boundary) is left out.
 */
export function fullyCoveredTiles(polys: readonly BoundaryPoly[]): string[] {
  const ids = new Set<string>()
  for (const poly of polys) {
    const [west, south, east, north] = poly.bbox
    const [x0, y0] = tileIdAt([west, south]).split('_').map(Number) as [number, number]
    const [x1, y1] = tileIdAt([east, north]).split('_').map(Number) as [number, number]
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const id = `${x}_${y}`
        if (ids.has(id)) continue
        const bounds = tileBounds(id)
        if (bounds !== null && boxFullyInside(bounds, polys)) ids.add(id)
      }
    }
  }
  return [...ids].sort()
}
