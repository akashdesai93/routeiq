import { withSignalCounts, type LightsOf, type RouteCandidate, type RouteLights } from '../core/index.ts'
import { driveSignalSources, loadSignalData, type SignalSources } from '../signalData.ts'

/** The lights of the routes a drive is on, for the stop meter (core/stops.ts). */
export interface RouteLightsCache {
  /** The lights of `route`, or undefined while they are loading (the stop's place is then unknown). */
  readonly lightsOf: LightsOf
  /** Starts loading the lights of `route`, if they are not known yet. Call it when the drive goes onto a route. */
  readonly want: (route: RouteCandidate) => void
}

/** Routes whose lights are kept. A drive is on one route at a time; a few switches fit. */
const KEEP = 8

/**
 * Loads a route's lights from the same signal data, and by the same rules, as
 * its light count (withSignalCounts): the bundled tiles first, then the
 * device cache, and the network only for a tile the bundle does not cover,
 * through the drive's sources, which ask Overpass at most once per tile per
 * session (the check that counted the route asked already). Only tile
 * bounding boxes leave the device, as for the count.
 */
export function createRouteLights(sources: SignalSources = driveSignalSources): RouteLightsCache {
  const known = new Map<string, RouteLights | 'loading'>()
  return {
    lightsOf: (route) => {
      const lights = known.get(route.id)
      return lights === 'loading' ? undefined : lights
    },
    want: (route) => {
      if (known.has(route.id)) return
      known.set(route.id, 'loading')
      while (known.size > KEEP) known.delete(known.keys().next().value!)
      void loadSignalData([route], sources).then(
        (loaded) => {
          const counted = withSignalCounts([route], loaded.data)
          const signals = counted.signalsByRouteId.get(route.id) ?? []
          if (known.get(route.id) === 'loading') {
            known.set(route.id, { alongM: signals.map((s) => s.atDistanceM), coverage: counted.routes[0]!.signalCoverage })
          }
        },
        () => known.delete(route.id),
      )
    },
  }
}
