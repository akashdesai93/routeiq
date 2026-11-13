import { memo, useEffect, useMemo, useRef, useState } from 'react'
import * as mapboxgl from 'mapbox-gl/esm'
import 'mapbox-gl/dist/mapbox-gl.css'
import {
  boundsOf,
  type LngLat,
  type Place,
  type RouteCandidate,
  type RouteSignal,
} from '../core/index.ts'
import { tokenErrorHelp } from '../config.ts'
import { SIGNAL_DATA_ATTRIBUTION } from './attribution.ts'
import { driveMarkerFeatures, driveRouteFeatures, type DriveOverlay } from './driveFeatures.ts'
import { DRIVE_HIDDEN_LAYERS, MAP_THEMES, mapThemeNow } from './mapTheme.ts'
import { DRIVE_ROUTE_CASE_LAYER, DRIVE_ROUTE_LAYER, DRIVE_ROUTE_SOURCE, DRIVE_SOURCE, driveLayers } from './driveLayers.ts'
import { PIN_COLOR, PIN_NAME, PIN_ROLES, type PinRole } from './pins.ts'
import { routeFeatures } from './routeFeatures.ts'
import { signalFeatures } from './signalFeatures.ts'

interface MapViewProps {
  token: string
  pins: Readonly<Record<PinRole, Place>>
  routes: readonly RouteCandidate[]
  selectedRouteId: string | null
  /** Signals on the selected route, drawn as small dots. */
  signals: readonly RouteSignal[]
  /** A simulated drive to draw: the car, the route being driven and the turn-off of a switch. Null or left out for none. */
  drive?: DriveOverlay | null
  /**
   * Keeps the map on the car during a live drive: centred on `center`, turned so that
   * `bearingDeg` points up. Null or left out: the map is the user's to move. While it is
   * set the pins cannot be dragged and the origin pin is hidden.
   */
  follow?: { readonly center: LngLat; readonly bearingDeg: number } | null
  /** Called once when a drag ends, never while the pin is moving. */
  onPinMove: (role: PinRole, position: LngLat) => void
  onSelectRoute: (id: string) => void
  /** Called with the centre of the map once it has loaded and after every move ends. Reported, never used here. */
  onCenterChange?: (center: LngLat) => void
}

const ROUTE_SOURCE = 'routes'
const HIT_LAYER = 'routes-hit'
const SIGNAL_SOURCE = 'route-signals'
const FIT_PADDING = 80
/** How close the map is when it follows the car. */
const FOLLOW_ZOOM = 15.5
/**
 * How long the map waits, while the page is in front, for the browser to give back a lost
 * WebGL context before it builds itself again. iOS takes the GPU from a page in the
 * background and does not always give it back; without this the map stays blank (#136).
 */
const CONTEXT_RESTORE_WAIT_MS = 2000
/** Builds after a lost context, at most, while this map is on screen: each one is a map load Mapbox counts. */
const MAX_REBUILDS = 3

/**
 * Draws the map at its container's size when the two differ, and asks for a frame.
 * Setting a canvas's size clears it even when the size is the same, so an unchanged map is
 * not resized: it would show blank until its next frame.
 */
function fitToContainer(map: mapboxgl.Map) {
  const container = map.getContainer()
  const canvas = map.getCanvas()
  if (Math.abs(container.clientWidth - canvas.clientWidth) >= 1 || Math.abs(container.clientHeight - canvas.clientHeight) >= 1) map.resize()
  map.triggerRepaint()
}

function pinLabel(role: PinRole, place: Place): string {
  return `${PIN_NAME[role]}: ${place.label}`
}

/**
 * Thin Mapbox GL JS wrapper. It draws the pins, routes and signals it is given (and a
 * simulated or live drive, when there is one, following the car when told to) and
 * reports drags and clicks upward; it decides nothing. Following Mapbox's
 * React guide, the map is created once in an effect and removed on unmount.
 *
 * Memoised: during a live drive the app renders once a second for the clock, and the
 * map takes no part in that unless something it draws has changed.
 */
export const MapView = memo(function MapView({
  token,
  pins,
  routes,
  selectedRouteId,
  signals,
  drive = null,
  follow = null,
  onPinMove,
  onSelectRoute,
  onCenterChange,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const markersRef = useRef<Record<PinRole, mapboxgl.Marker> | null>(null)
  // What the map's own event handlers should see, without recreating the map.
  const latest = useRef({ pins, selectedRouteId, onPinMove, onSelectRoute, onCenterChange })
  const [error, setError] = useState<string | null>(null)
  // Set once the style has loaded and the route layers exist.
  const [readyMap, setReadyMap] = useState<mapboxgl.Map | null>(null)
  // Bumped to build the map again, when its WebGL context was lost and never given back.
  const [generation, setGeneration] = useState(0)
  const rebuilds = useRef(0)

  useEffect(() => {
    latest.current = { pins, selectedRouteId, onPinMove, onSelectRoute, onCenterChange }
  })

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const start = latest.current.pins
    const [west, south, east, north] = boundsOf(PIN_ROLES.map((role) => start[role].position))
    // Day or night, chosen once as the map starts (#145). A change of appearance takes effect
    // the next time the map starts: no style reload under a drive (#136).
    const theme = MAP_THEMES[mapThemeNow()]
    let map: mapboxgl.Map
    try {
      map = new mapboxgl.Map({
        accessToken: token,
        container,
        style: theme.style,
        bounds: [
          [west, south],
          [east, north],
        ],
        fitBoundsOptions: { padding: FIT_PADDING },
        // Replaced below by one that also credits the signal data.
        attributionControl: false,
      })
    } catch (e) {
      // Most often: WebGL is off or unavailable in this browser.
      console.error(e)
      // oxlint-disable-next-line react/set-state-in-effect -- the external Mapbox constructor threw while this effect syncs with it; there is nothing to derive in render.
      setError(`The map could not start: ${e instanceof Error ? e.message : String(e)}`)
      return
    }
    map.on('error', (e) => {
      console.error(e.error)
      const help = tokenErrorHelp((e.error as { status?: number } | undefined)?.status)
      if (help) setError(help)
    })
    map.addControl(new mapboxgl.NavigationControl(), 'top-right')
    // Mapbox's own attribution, plus the credit for the signal data. Never collapsed
    // behind a button: the credit has to be readable on the map itself.
    map.addControl(
      new mapboxgl.AttributionControl({ compact: false, customAttribution: SIGNAL_DATA_ATTRIBUTION }),
      'bottom-right',
    )

    const reportCenter = () => {
      const { lng, lat } = map.getCenter().wrap()
      latest.current.onCenterChange?.([lng, lat])
    }
    map.on('moveend', reportCenter)

    const marker = (role: PinRole) => {
      const m = new mapboxgl.Marker({ color: PIN_COLOR[role], draggable: true })
        .setLngLat([start[role].position[0], start[role].position[1]])
        .setPopup(new mapboxgl.Popup({ offset: 24 }).setText(pinLabel(role, start[role])))
        .addTo(map)
      m.on('dragend', () => {
        const { lng, lat } = m.getLngLat().wrap()
        latest.current.onPinMove(role, [lng, lat])
      })
      return m
    }
    const markers = { origin: marker('origin'), destination: marker('destination') }
    markersRef.current = markers

    map.on('load', () => {
      map.addSource(ROUTE_SOURCE, { type: 'geojson', data: routeFeatures([], null) })
      const layout = { 'line-join': 'round', 'line-cap': 'round' } as const
      // Bottom to top: muted alternatives, then the selected route with a darker edge.
      map.addLayer({
        id: 'routes-alt',
        type: 'line',
        source: ROUTE_SOURCE,
        filter: ['!', ['get', 'selected']],
        layout,
        paint: { 'line-color': '#8c959f', 'line-width': 5, 'line-opacity': 0.85 },
      })
      map.addLayer({
        id: 'routes-selected-edge',
        type: 'line',
        source: ROUTE_SOURCE,
        filter: ['get', 'selected'],
        layout,
        paint: { 'line-color': '#0b3d91', 'line-width': 9 },
      })
      map.addLayer({
        id: 'routes-selected',
        type: 'line',
        source: ROUTE_SOURCE,
        filter: ['get', 'selected'],
        layout,
        paint: { 'line-color': '#1f6feb', 'line-width': 6 },
      })
      // Signals on the selected route: small dots above the line, never clickable.
      map.addSource(SIGNAL_SOURCE, { type: 'geojson', data: signalFeatures([]) })
      map.addLayer({
        id: 'route-signals',
        type: 'circle',
        source: SIGNAL_SOURCE,
        paint: {
          'circle-radius': 3.5,
          'circle-color': '#ffffff',
          'circle-stroke-color': '#1f2328',
          'circle-stroke-width': 1.5,
        },
      })
      // Wide, nearly invisible line over every route so a click does not need to be exact.
      map.addLayer({
        id: HIT_LAYER,
        type: 'line',
        source: ROUTE_SOURCE,
        layout,
        paint: { 'line-color': '#000000', 'line-width': 20, 'line-opacity': 0.01 },
      })
      map.on('click', HIT_LAYER, (e) => {
        // @types/geojson is not installed, so the feature's GeoJSON fields are spelled out here.
        const hits = (e.features ?? []) as readonly { properties?: { id?: unknown } | null }[]
        const ids = hits.map((f) => String(f.properties?.id))
        // Where routes share a road the click is ambiguous, so the current selection stays.
        const first = ids[0]
        if (first === undefined || ids.includes(latest.current.selectedRouteId ?? '')) return
        latest.current.onSelectRoute(first)
      })
      map.on('mouseenter', HIT_LAYER, () => {
        map.getCanvas().style.cursor = 'pointer'
      })
      map.on('mouseleave', HIT_LAYER, () => {
        map.getCanvas().style.cursor = ''
      })
      // The drive, above everything else: the route being driven (its own source, set only
      // when the route changes; the part behind the car is trimmed off, see driveLayers.ts),
      // the turn-off of a switch (hollow while the switch is still waiting), and the car.
      map.addSource(DRIVE_ROUTE_SOURCE, { type: 'geojson', data: driveRouteFeatures([]), lineMetrics: true })
      map.addSource(DRIVE_SOURCE, { type: 'geojson', data: driveMarkerFeatures(null) })
      // Ink on a white casing on the day map, a light line on a dark casing on the night map
      // (mapTheme.ts). Both lines are trimmed alike, so no casing is left behind the car.
      map.addLayer({
        id: DRIVE_ROUTE_CASE_LAYER,
        type: 'line',
        source: DRIVE_ROUTE_SOURCE,
        filter: ['==', ['get', 'kind'], 'route'],
        // Flat ends: the trimmed-off start is then gone whole (no round cap left behind), and the cut is under the car.
        layout: { 'line-join': 'round', 'line-cap': 'butt' },
        paint: { 'line-color': theme.routeCase, 'line-width': 10, 'line-trim-offset': [0, 0] },
      })
      map.addLayer({
        id: DRIVE_ROUTE_LAYER,
        type: 'line',
        source: DRIVE_ROUTE_SOURCE,
        filter: ['==', ['get', 'kind'], 'route'],
        layout: { 'line-join': 'round', 'line-cap': 'butt' },
        paint: { 'line-color': theme.routeCore, 'line-width': 6, 'line-trim-offset': [0, 0] },
      })
      map.addLayer({
        id: 'drive-turn',
        type: 'circle',
        source: DRIVE_SOURCE,
        filter: ['==', ['get', 'kind'], 'turn'],
        paint: {
          'circle-radius': 8,
          'circle-color': ['case', ['get', 'pending'], '#ffffff', '#ffb000'],
          'circle-stroke-color': ['case', ['get', 'pending'], '#ffb000', '#0a0c0f'],
          'circle-stroke-width': 3,
        },
      })
      map.addLayer({
        id: 'drive-car',
        type: 'circle',
        source: DRIVE_SOURCE,
        filter: ['==', ['get', 'kind'], 'car'],
        paint: {
          'circle-radius': 9,
          'circle-color': '#ffffff',
          'circle-stroke-color': '#0a0c0f',
          'circle-stroke-width': 4,
        },
      })
      setReadyMap(map)
      reportCenter()
    })

    // Mapbox resizes the drawing only when the window resizes. The container also changes
    // size on its own: the drive view hides the side panel and End brings it back.
    const resizer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => map.resize())
    resizer?.observe(container)

    // The GPU can be taken from the page (iOS does it to an app in the background). Mapbox
    // draws again when the browser gives the context back; when it does not within
    // CONTEXT_RESTORE_WAIT_MS of the page being in front, the map is built again (at most
    // MAX_REBUILDS times). The wait counts from the later of the loss and the page coming
    // to the front, since iOS gives the context back only to a page in front.
    let lostAtMs: number | null = null
    let rebuildTimer: ReturnType<typeof setTimeout> | null = null
    const pageHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'
    const checkLost = () => {
      if (rebuildTimer !== null) clearTimeout(rebuildTimer)
      rebuildTimer = null
      if (lostAtMs === null || pageHidden()) return
      const waitMs = CONTEXT_RESTORE_WAIT_MS - (Date.now() - lostAtMs)
      if (waitMs > 0) {
        rebuildTimer = setTimeout(checkLost, waitMs)
        return
      }
      if (rebuilds.current >= MAX_REBUILDS) {
        console.warn('The map lost its WebGL context and did not get it back; it has been built again too often already.')
        return
      }
      rebuilds.current++
      console.warn('The map lost its WebGL context and did not get it back: building the map again.')
      setGeneration((g) => g + 1)
    }
    map.on('webglcontextlost', () => {
      console.warn('The map lost its WebGL context.')
      lostAtMs = Date.now()
      checkLost()
    })
    map.on('webglcontextrestored', () => {
      lostAtMs = null
      checkLost()
    })
    // Back in front (unlocked, or switched back to): draw at the container's size now, and
    // see whether the context came back.
    const onShown = () => {
      if (pageHidden()) return
      fitToContainer(map)
      if (lostAtMs !== null) lostAtMs = Date.now()
      checkLost()
    }
    document.addEventListener('visibilitychange', onShown)
    window.addEventListener('pageshow', onShown)

    return () => {
      document.removeEventListener('visibilitychange', onShown)
      window.removeEventListener('pageshow', onShown)
      if (rebuildTimer !== null) clearTimeout(rebuildTimer)
      resizer?.disconnect()
      setReadyMap(null)
      markersRef.current = null
      Object.values(markers).forEach((m) => m.remove())
      map.remove()
    }
  }, [token, generation])

  // Pins moved from outside (drag result, swap, reset): move the markers to match.
  useEffect(() => {
    const markers = markersRef.current
    if (!markers) return
    for (const role of PIN_ROLES) {
      const place = pins[role]
      markers[role].setLngLat([place.position[0], place.position[1]])
      markers[role].getPopup()?.setText(pinLabel(role, place))
    }
  }, [pins])

  // Bring a pin back into view if it was moved off screen (reset, for example).
  useEffect(() => {
    if (!readyMap) return
    const points = PIN_ROLES.map((role) => pins[role].position)
    const view = readyMap.getBounds()
    if (view && points.every(([lng, lat]) => view.contains([lng, lat]))) return
    const [west, south, east, north] = boundsOf(points)
    readyMap.fitBounds(
      [
        [west, south],
        [east, north],
      ],
      { padding: FIT_PADDING },
    )
  }, [readyMap, pins])

  useEffect(() => {
    if (!readyMap) return
    const source = readyMap.getSource<mapboxgl.GeoJSONSource>(ROUTE_SOURCE)
    source?.setData(routeFeatures(routes, selectedRouteId))
  }, [readyMap, routes, selectedRouteId])

  useEffect(() => {
    if (!readyMap) return
    const source = readyMap.getSource<mapboxgl.GeoJSONSource>(SIGNAL_SOURCE)
    source?.setData(signalFeatures(signals))
  }, [readyMap, signals])

  // The drive: only what changed goes to the map (the route line once per route, then the car).
  const driveLayer = useMemo(
    () =>
      readyMap
        ? driveLayers({
            getSource: (id) => readyMap.getSource<mapboxgl.GeoJSONSource>(id),
            setPaintProperty: (layer, name, value) => readyMap.setPaintProperty(layer, name, value),
          })
        : null,
    [readyMap],
  )
  useEffect(() => {
    driveLayer?.update(drive)
  }, [driveLayer, drive])

  // A live drive: the map follows the car, heading up. Leaving it turns the map north
  // again and shows the trip.
  const following = follow !== null
  useEffect(() => {
    if (!readyMap || !following) return
    const markers = markersRef.current
    markers?.origin.getElement().style.setProperty('display', 'none')
    PIN_ROLES.forEach((role) => markers?.[role].setDraggable(false))
    // The drive view has just taken the whole screen: draw at the new size now, not on a
    // later resize callback (#136).
    fitToContainer(readyMap)
    readyMap.easeTo({ zoom: FOLLOW_ZOOM, pitch: 40, duration: 0 })
    // While driving: no points of interest, transit or traffic from the base map (mapTheme.ts).
    // Once when the drive starts and once when it ends; nothing per fix.
    const hidden = (readyMap.getStyle()?.layers ?? [])
      .filter((layer) => DRIVE_HIDDEN_LAYERS.test(layer.id) && readyMap.getLayoutProperty(layer.id, 'visibility') !== 'none')
      .map((layer) => layer.id)
    for (const id of hidden) readyMap.setLayoutProperty(id, 'visibility', 'none')
    const { pins: shown } = latest.current
    return () => {
      try {
        for (const id of hidden) readyMap.setLayoutProperty(id, 'visibility', 'visible')
      } catch {
        // The map itself is being removed: nothing to put back.
      }
      markers?.origin.getElement().style.removeProperty('display')
      PIN_ROLES.forEach((role) => markers?.[role].setDraggable(true))
      const [west, south, east, north] = boundsOf(PIN_ROLES.map((role) => shown[role].position))
      try {
        fitToContainer(readyMap)
        readyMap.fitBounds(
          [
            [west, south],
            [east, north],
          ],
          { padding: FIT_PADDING, bearing: 0, pitch: 0 },
        )
      } catch {
        // The map itself is being removed (the page is closing): nothing to put back.
      }
    }
  }, [readyMap, following])

  const followLng = follow?.center[0]
  const followLat = follow?.center[1]
  const followBearing = follow?.bearingDeg
  useEffect(() => {
    if (!readyMap || followLng === undefined || followLat === undefined) return
    // A little longer than the second between two fixes, so the map glides instead of stepping.
    readyMap.easeTo({ center: [followLng, followLat], bearing: followBearing ?? 0, duration: 1100, easing: (t) => t })
  }, [readyMap, followLng, followLat, followBearing])

  return (
    <>
      {error && (
        <main className="notice" role="alert">
          {error}
        </main>
      )}
      <div ref={containerRef} className="map" data-testid="map" hidden={error !== null} />
    </>
  )
})
