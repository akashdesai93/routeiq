import type { LngLat } from '../core/index.ts'

/** What the map draws of a simulated drive. Decided elsewhere (useDriveSim.ts); the map only draws it. */
export interface DriveOverlay {
  /** Where the car is. */
  readonly car: LngLat
  /** The route being driven, from the car to the destination. */
  readonly routeAhead: readonly LngLat[]
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
 * A simulated drive as GeoJSON for the map source: the current route as a
 * line (left out when it has fewer than two points), the turn-off point of a
 * switch, and the car last so it is drawn on top. `kind` drives the layer
 * filters. Null gives an empty collection.
 */
export function driveFeatures(drive: DriveOverlay | null): DriveFeatureCollection {
  const features: DriveFeature[] = []
  if (drive !== null) {
    if (drive.routeAhead.length >= 2) {
      features.push({
        type: 'Feature',
        properties: { kind: 'route', pending: false },
        geometry: { type: 'LineString', coordinates: drive.routeAhead.map(([lng, lat]) => [lng, lat]) },
      })
    }
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
