import type { LngLat } from '../core/index.ts'
import { driveMarkerFeatures, driveRouteFeatures, routeProgress, type DriveFeatureCollection, type DriveOverlay } from './driveFeatures.ts'

/** The source with the route being driven: one line, set when the route changes. Needs `lineMetrics` for the trim. */
export const DRIVE_ROUTE_SOURCE = 'drive-route'
/** The source with the car and the turn-off point: set on every fix, a few hundred bytes. */
export const DRIVE_SOURCE = 'drive'
/** The line layer of the route being driven; the part behind the car is trimmed off. */
export const DRIVE_ROUTE_LAYER = 'drive-route'
/** Its white casing, drawn under it from the same source and trimmed with it. */
export const DRIVE_ROUTE_CASE_LAYER = 'drive-route-case'
/** Every layer of the route line: each gets the same trim. */
export const DRIVE_ROUTE_LAYERS = [DRIVE_ROUTE_CASE_LAYER, DRIVE_ROUTE_LAYER] as const

/** The few calls of a Mapbox map the drive layers make (a mapboxgl.Map has them). */
export interface DriveMap {
  getSource(id: string): { setData(data: DriveFeatureCollection): unknown } | undefined | null
  setPaintProperty(layer: string, name: 'line-trim-offset', value: [number, number]): unknown
}

const NO_ROUTE: readonly LngLat[] = []

/**
 * Keeps the drive layers of one map in step with the drive, handing the map
 * only what changed: the route line when the route changes, the trim of the
 * part behind the car when the car moves along it, and the car and turn-off
 * points when they move. Before this, the whole rest of the route (about
 * 66 kB for a 60 km trip) was set on every fix (#94). The map's sources
 * start empty, as MapView adds them.
 */
export function driveLayers(map: DriveMap): { update(drive: DriveOverlay | null): void } {
  let route = NO_ROUTE
  let progress = routeProgress(NO_ROUTE)
  let trim = 0
  let markers = JSON.stringify(driveMarkerFeatures(null))
  return {
    update(drive) {
      const nextRoute = drive?.route ?? NO_ROUTE
      if (nextRoute !== route && !(nextRoute.length === 0 && route.length === 0)) {
        route = nextRoute
        progress = routeProgress(route)
        map.getSource(DRIVE_ROUTE_SOURCE)?.setData(driveRouteFeatures(route))
      }
      const nextTrim = drive === null ? 0 : progress(drive.alongM)
      if (nextTrim !== trim) {
        trim = nextTrim
        for (const layer of DRIVE_ROUTE_LAYERS) map.setPaintProperty(layer, 'line-trim-offset', [0, trim])
      }
      const points = driveMarkerFeatures(drive)
      const nextMarkers = JSON.stringify(points)
      if (nextMarkers !== markers) {
        markers = nextMarkers
        map.getSource(DRIVE_SOURCE)?.setData(points)
      }
    },
  }
}
