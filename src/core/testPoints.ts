import type { Place } from './types.ts'

/**
 * Public landmarks and intersections used as fixed test coordinates.
 * Deliberately not anyone's home or work address.
 */
export const UPTOWN_CHARLOTTE: Place = {
  id: 'uptown',
  label: 'Uptown Charlotte (Trade & Tryon)',
  position: [-80.8431, 35.2271],
}

/**
 * Where SC-160 (Fort Mill Hwy) ends at US-521 (Charlotte Hwy) in Indian Land,
 * South Carolina, a little over a kilometer south of the state line. Position
 * from OpenStreetMap (the east end of the way "Fort Mill Highway", looked up
 * through Nominatim, Nov 2026).
 */
export const INDIAN_LAND: Place = {
  id: 'indian-land',
  label: 'Indian Land, SC (US-521 & SC-160)',
  position: [-80.8561, 35.0015],
}

export const SOUTHPARK: Place = {
  id: 'southpark',
  label: 'SouthPark (south Charlotte)',
  position: [-80.8295, 35.1527],
}

/**
 * The trip the app opens with: Uptown down the US-521 corridor into South
 * Carolina. It leaves the City of Charlotte's signal data behind at the state
 * line, so the count south of it has to come from OpenStreetMap.
 */
export const DEFAULT_TRIP: { readonly origin: Place; readonly destination: Place } = {
  origin: UPTOWN_CHARLOTTE,
  destination: INDIAN_LAND,
}

export const TEST_PLACES: readonly Place[] = [UPTOWN_CHARLOTTE, INDIAN_LAND, SOUTHPARK]
