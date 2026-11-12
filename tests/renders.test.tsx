// @vitest-environment jsdom
import { act, memo, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
// @ts-expect-error plain JavaScript helper without types
import { fixesAlong, syntheticDirections } from '../scripts/perf/lib.mjs'

// #95: during a live drive a GPS fix (and the 1 s clock of "checked N s ago") renders only
// what shows it. The real App in jsdom, on a stubbed GPS, a synthetic route from
// scripts/perf/lib.mjs and Mapbox replaced by a stand-in; each component's renders are
// counted, with the props that changed. A render that a driver cannot see is a phone's
// main thread spent once a second for nothing.

const counts = vi.hoisted(() => ({
  renders: {} as Record<string, number>,
  /** Renders in which no prop had changed: work for nothing. */
  unchanged: {} as Record<string, number>,
}))

type MemoLike<P> = { type: (props: P) => ReactNode; compare?: ((a: P, b: P) => boolean) | null }

/** Counts each render of a component; a memo()'d one keeps its memo, so a render it skips is not counted. */
const counting = vi.hoisted(() => {
  return <P extends Record<string, unknown>>(name: string, component: ((props: P) => ReactNode) | MemoLike<P>): never => {
    if (typeof component !== 'function') return memo(counting(name, component.type), component.compare ?? undefined) as never
    let last: P | null = null
    return ((props: P) => {
      counts.renders[name] = (counts.renders[name] ?? 0) + 1
      if (last !== null && Object.keys(props).every((key) => Object.is(props[key], last![key]))) {
        counts.unchanged[name] = (counts.unchanged[name] ?? 0) + 1
      }
      last = props
      return component(props)
    }) as never
  }
})

vi.mock('mapbox-gl/dist/mapbox-gl.css', () => ({}))
vi.mock('mapbox-gl/esm', () => {
  class Map {
    private sources: Record<string, { setData: () => void }> = {}
    on(event: string, layerOrFn: unknown) {
      if (event === 'load' && typeof layerOrFn === 'function') queueMicrotask(layerOrFn as () => void)
      return this
    }
    addControl() {}
    addLayer() {}
    addSource(id: string) {
      this.sources[id] = { setData: () => {} }
    }
    getSource(id: string) {
      return this.sources[id]
    }
    getCanvas() {
      return { style: {} }
    }
    getBounds() {
      return { contains: () => true }
    }
    getCenter() {
      return { wrap: () => ({ lng: -80.84, lat: 35.22 }) }
    }
    fitBounds() {}
    easeTo() {}
    setPaintProperty() {}
    resize() {}
    remove() {}
  }
  class Marker {
    private element = document.createElement('div')
    setLngLat() {
      return this
    }
    setPopup() {
      return this
    }
    addTo() {
      return this
    }
    on() {}
    getPopup() {
      return { setText() {} }
    }
    getElement() {
      return this.element
    }
    setDraggable() {}
    remove() {}
  }
  class Popup {
    setText() {
      return this
    }
  }
  class Control {}
  return { Map, Marker, Popup, NavigationControl: Control, AttributionControl: Control }
})
vi.mock('../src/map/MapView.tsx', async (original) => {
  const actual = await original<typeof import('../src/map/MapView.tsx')>()
  return { ...actual, MapView: counting('MapView', actual.MapView as never) }
})
vi.mock('../src/RoutePanel.tsx', async (original) => {
  const actual = await original<typeof import('../src/RoutePanel.tsx')>()
  return { ...actual, RoutePanel: counting('RoutePanel', actual.RoutePanel as never) }
})
vi.mock('../src/PlanPanel.tsx', async (original) => {
  const actual = await original<typeof import('../src/PlanPanel.tsx')>()
  return { ...actual, PlanPanel: counting('PlanPanel', actual.PlanPanel as never) }
})
vi.mock('../src/DrivePanel.tsx', async (original) => {
  const actual = await original<typeof import('../src/DrivePanel.tsx')>()
  return { ...actual, DrivePanel: counting('DrivePanel', actual.DrivePanel as never) }
})
vi.mock('../src/LiveDriveView.tsx', async (original) => {
  const actual = await original<typeof import('../src/LiveDriveView.tsx')>()
  return { ...actual, LiveDriveView: counting('LiveDriveView', actual.LiveDriveView as never) }
})

const HIDDEN_DURING_A_DRIVE = ['PlanPanel', 'RoutePanel', 'DrivePanel'] as const

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('during a live drive, a fix and the clock render only the drive view and the map, and the panels come back after', async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const body = syntheticDirections({ lengthKm: 8, vertices: 400 })
  const geometry = body.routes[0].geometry.coordinates as [number, number][]
  const fixes = fixesAlong(geometry) as { lng: number; lat: number; accuracyM: number; speedMps: number; headingDeg: number }[]
  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = String(input)
    if (url.includes('/directions/')) {
      // A probe or a path check (via points): no route that way. The main request: the routes.
      const answer = url.includes('waypoints=') ? { code: 'NoRoute' } : body
      return { ok: true, status: 200, json: async () => answer }
    }
    // Signal tiles: not there. The counts stay unknown; they are not what is checked.
    return { ok: false, status: 404, json: async () => ({}) }
  })
  let emit: ((position: { coords: Record<string, number> }) => void) | null = null
  Object.defineProperty(globalThis.navigator, 'geolocation', {
    configurable: true,
    value: {
      watchPosition: (success: typeof emit) => {
        emit = success
        return 1
      },
      clearWatch: () => {},
      getCurrentPosition: () => {},
    },
  })
  vi.stubGlobal('isSecureContext', true)

  const { default: App } = await import('../src/App.tsx')
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  await act(async () => {
    root.render(<App status={{ kind: 'ok', token: 'pk.test' }} />)
    await vi.advanceTimersByTimeAsync(3000)
  })
  const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
  expect(button('Start drive'), 'the Start drive button').toBeDefined()
  await act(async () => {
    button('Start drive')!.click()
    await vi.advanceTimersByTimeAsync(100)
  })
  expect(emit, 'the GPS watch').not.toBeNull()
  const fix = (i: number) => {
    const f = fixes[i]!
    emit!({ coords: { longitude: f.lng, latitude: f.lat, accuracy: f.accuracyM, speedMps: f.speedMps, speed: f.speedMps, heading: f.headingDeg } })
  }
  // Getting going: the first fixes put the car on the route.
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      fix(i)
      await vi.advanceTimersByTimeAsync(1000)
    })
  }
  expect(container.querySelector('.app.live'), 'the drive view').not.toBeNull()

  const before = structuredClone(counts)
  const since = (name: string, of: 'renders' | 'unchanged' = 'renders') => (counts[of][name] ?? 0) - (before[of][name] ?? 0)
  // Twenty seconds: a fix each second, delivered on its own and then the clock's tick on its
  // own, as a browser delivers them (two updates a second).
  const SECONDS = 20
  for (let i = 8; i < 8 + SECONDS; i++) {
    await act(async () => {
      fix(i)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
  }

  // Hidden behind the drive view: not rendered at all.
  for (const name of HIDDEN_DURING_A_DRIVE) expect(since(name), `${name} renders during the drive`).toBe(0)
  // The drive view shows every fix and the clock ("checked N s ago"): it still renders for both.
  expect(since('LiveDriveView')).toBeGreaterThanOrEqual(2 * SECONDS)
  // The map shows the car: it renders for each fix, never for the clock, never for nothing.
  expect(since('MapView')).toBeGreaterThanOrEqual(SECONDS)
  expect(since('MapView')).toBeLessThanOrEqual(SECONDS + 2)
  expect(since('MapView', 'unchanged'), 'MapView renders with no prop changed').toBe(0)

  // After the drive, the panels are back, up to date and usable.
  const beforeEnd = structuredClone(counts.renders)
  await act(async () => {
    button('End')!.click()
    await vi.advanceTimersByTimeAsync(100)
  })
  expect(container.querySelector('.app.live')).toBeNull()
  for (const name of HIDDEN_DURING_A_DRIVE) expect((counts.renders[name] ?? 0) - (beforeEnd[name] ?? 0), `${name} after the drive`).toBeGreaterThan(0)
  expect(button('Start drive')).toBeDefined()
  root.unmount()
})
