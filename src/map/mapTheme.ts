/**
 * The drive map by day and by night (#145; docs/design/map-check.md, findings 1-4). The map's
 * style follows the phone's appearance when the map starts, and the route ahead is painted to
 * read on that map. One table, so the native app can take the same values.
 */
export type MapTheme = 'day' | 'night'

export const MAP_THEMES: Readonly<Record<MapTheme, { style: string; routeCore: string; routeCase: string }>> = {
  // The day map is the one the app has always used; the route is ink on a white casing.
  day: { style: 'mapbox://styles/mapbox/streets-v12', routeCore: '#0a0c0f', routeCase: '#ffffff' },
  // A dark map made for driving; on it the route is a light core on a dark casing (15:1 on the land).
  night: { style: 'mapbox://styles/mapbox/navigation-night-v1', routeCore: '#f2f4f6', routeCase: '#050607' },
}

/**
 * Base-map layers switched off while following the car: points of interest and transit (noise
 * at a glance) and traffic (its orange sits next to amber, the news colour; RouteIQ shows the
 * route's own slow stretch instead). Matched on the layer id; the app's own layers never match.
 */
export const DRIVE_HIDDEN_LAYERS = /poi|transit|traffic/

/** The theme for a map starting now: night when the phone is set to dark. */
export function mapThemeNow(): MapTheme {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'day'
}
