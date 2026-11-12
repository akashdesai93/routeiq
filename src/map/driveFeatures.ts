import { trackedRoute, type LngLat } from '../core/index.ts'

/** What the map draws of a drive (simulated or live). Decided elsewhere (useDriveSim.ts, useLiveDrive.ts); the map only draws it. */
export interface DriveOverlay {
  /** Where the car is. */
  readonly car: LngLat
  /**
   * The whole route being driven, as its geometry array. It stays the same
   * array for as long as the route does, so the map is handed the line only
   * when the route changes (start, a switch, "keep previous"), not on every fix.
   * Empty when there is no route yet.
   */
  readonly route: readonly LngLat[]
  /** How far along `route` the car is, in meters (alongRouteM's meters). The route is drawn from here to the destination. */
  readonly alongM: number
  /**
   * Where a switch leaves the route: `pending` while the switch is still
   * waiting (being confirmed, or held by the cooldown), false once it is made.
   */
  readonly turn: { readonly at: LngLat; readonly pending: boolean } | null
}

export type DriveFeatureKind = 'route' | 'turn' | 'car'

export interface DriveFeature {
  type: 'Feature'
  properties: { kind: DriveFeatureKind; pending: boolean }
  geometry: { type: 'LineString'; coordinates: number[][] } | { type: 'Point'; coordinates: number[] }
}

export interface DriveFeatureCollection {
  type: 'FeatureCollection'
  features: DriveFeature[]
}

/**
 * The route being driven as GeoJSON for its own map source: one line, its
 * usable points (as tracking.ts uses them), left out when it has fewer than
 * two. Handed to the map once per route; the part already driven is hidden
 * with line-trim-offset (routeProgress), so a fix does not re-send the line.
 */
export function driveRouteFeatures(route: readonly LngLat[]): DriveFeatureCollection {
  const { line } = trackedRoute(route)
  if (line.length < 2) return { type: 'FeatureCollection', features: [] }
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { kind: 'route', pending: false },
        geometry: { type: 'LineString', coordinates: line.map(([lng, lat]) => [lng, lat]) },
      },
    ],
  }
}

/**
 * The points of a drive as GeoJSON for the map source set on every fix: the
 * turn-off point of a switch, and the car last so it is drawn on top. A few
 * hundred bytes. `kind` drives the layer filters. Null gives an empty collection.
 */
export function driveMarkerFeatures(drive: DriveOverlay | null): DriveFeatureCollection {
  const features: DriveFeature[] = []
  if (drive !== null) {
    if (drive.turn !== null) {
      features.push({
        type: 'Feature',
        properties: { kind: 'turn', pending: drive.turn.pending },
        geometry: { type: 'Point', coordinates: [drive.turn.at[0], drive.turn.at[1]] },
      })
    }
    features.push({
      type: 'Feature',
      properties: { kind: 'car', pending: false },
      geometry: { type: 'Point', coordinates: [drive.car[0], drive.car[1]] },
    })
  }
  return { type: 'FeatureCollection', features }
}

/** Web Mercator, 0 to 1 on both axes, the plane Mapbox measures line-progress on (geojson-vt). */
function mercator([lng, lat]: LngLat): readonly [number, number] {
  const sin = Math.sin((lat * Math.PI) / 180)
  return [lng / 360 + 0.5, 0.5 - (0.25 * Math.log((1 + sin) / (1 - sin))) / Math.PI]
}

/**
 * For the line driveRouteFeatures draws: the share of it, 0 to 1, that lies
 * before the point `alongM` meters from its start. That is the line-progress
 * Mapbox gives the point, measured on the Mercator plane like Mapbox does,
 * so `line-trim-offset: [0, share]` hides exactly the part already driven.
 * The tables are worked out once per route; each fix is a binary search on
 * the meters tracking.ts already keeps (trackedRoute).
 */
export function routeProgress(route: readonly LngLat[]): (alongM: number) => number {
  const { line, alongM } = trackedRoute(route)
  const n = line.length
  if (n < 2) return () => 0
  const planar = new Float64Array(n)
  let previous = mercator(line[0]!)
  for (let i = 1; i < n; i++) {
    const here = mercator(line[i]!)
    planar[i] = planar[i - 1]! + Math.hypot(here[0] - previous[0], here[1] - previous[1])
    previous = here
  }
  const total = planar[n - 1]!
  const lengthM = alongM[n - 1]!
  if (!(total > 0)) return () => 0
  return (at) => {
    if (!(at > 0)) return 0
    if (at >= lengthM) return 1
    // The last vertex at or before `at`: alongM[lo] <= at < alongM[hi].
    let lo = 0
    let hi = n - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (alongM[mid]! <= at) lo = mid
      else hi = mid
    }
    const segmentM = alongM[hi]! - alongM[lo]!
    const t = segmentM > 0 ? (at - alongM[lo]!) / segmentM : 0
    return Math.min(1, Math.max(0, (planar[lo]! + t * (planar[hi]! - planar[lo]!)) / total))
  }
}
