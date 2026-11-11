import type { LngLat } from './types.ts'

/** Coordinates are compared at 1e-6 degrees (about 0.1 m), the precision Mapbox sends. */
const QUANTUM_PER_DEGREE = 1e6

function fnv1a(values: readonly number[], seed: number): number {
  let h = seed
  for (const v of values) {
    // Four bytes per 32-bit value, low byte first.
    for (let shift = 0; shift < 32; shift += 8) {
      h ^= (v >>> shift) & 0xff
      h = Math.imul(h, 0x01000193)
    }
  }
  return h >>> 0
}

/**
 * Deterministic 64-bit fingerprint of a polyline, as 16 hex digits: the same
 * points in the same order always give the same string, on any machine.
 * Two FNV-1a passes with different seeds; for identity only, not for security.
 */
export function geometryHash(geometry: readonly LngLat[]): string {
  const values: number[] = [geometry.length]
  for (const [lng, lat] of geometry) {
    values.push(Math.round(lng * QUANTUM_PER_DEGREE) | 0, Math.round(lat * QUANTUM_PER_DEGREE) | 0)
  }
  const hex = (n: number) => n.toString(16).padStart(8, '0')
  return hex(fnv1a(values, 0x811c9dc5)) + hex(fnv1a(values, 0x9747b28c))
}

/**
 * Route id from its geometry, so a route that comes back point for point in a
 * later response (a retry now, polling in PLAN step 6) keeps its id. A hash
 * is exact by nature: the same roads with slightly different points get a new
 * id. sameRouteGeometry in select.ts answers "is this the same path?" then.
 */
export function routeIdFromGeometry(geometry: readonly LngLat[]): string {
  return `route-${geometryHash(geometry)}`
}
