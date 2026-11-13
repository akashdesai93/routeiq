import { Component, lazy, memo, Suspense, type ComponentProps, type ReactNode } from 'react'

/**
 * The map, loaded after the first screen. Mapbox GL JS is about 1.35 MB of JavaScript in
 * its own chunk (vite.config.ts); importing MapView statically made the entry wait for
 * it, so the top bar and the plan panel could not paint until all of it was parsed.
 * Here the map chunk is fetched as soon as this renders and the rest of the app paints
 * meanwhile. Until it runs, an empty box of the same size holds the map's place, so
 * nothing moves when the map arrives. Same props and behaviour as MapView.
 *
 * In the iPhone shell the chunk is a file in the app bundle (capacitor://localhost/assets),
 * so it resolves offline like every other file. If it cannot be loaded (a browser that
 * went offline before the chunk arrived), only the map is replaced by a notice: the plan
 * panel, the route list and a drive keep working.
 */
const MapViewChunk = lazy(() => import('./MapView.tsx').then((m) => ({ default: m.MapView })))

type MapViewProps = ComponentProps<typeof MapViewChunk>

/** Holds the map's place: the same class (size) and test id as MapView's own box. */
const placeholder = <div className="map" data-testid="map" aria-busy="true" />

class MapLoadBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    if (!this.state.failed) return this.props.children
    return (
      <main className="notice" role="alert">
        The map could not be loaded. Reload the page to try again; routes and the drive work without it.
      </main>
    )
  }
}

/** Memoised like MapView, so a drive's 1 s clock does not re-render the boundary either. */
export const MapView = memo(function LazyMapView(props: MapViewProps) {
  return (
    <MapLoadBoundary>
      <Suspense fallback={placeholder}>
        <MapViewChunk {...props} />
      </Suspense>
    </MapLoadBoundary>
  )
})
