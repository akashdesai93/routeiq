// What React and the map do during one minute of a live drive (docs/performance.md).
//   npm i --no-save jsdom && npx vitest run --config scripts/perf/vitest.config.ts
// The real App runs in jsdom: a stubbed GPS gives one fix a second along a synthetic 60 km /
// 3000-vertex route, the Directions answers come from scripts/perf/lib.mjs, and Mapbox GL is
// replaced by a recorder. Counted per second of driving: renders of each component, React
// commits, and what is handed to the map (setData per source, with its size, and easeTo).
import { act, memo, Profiler, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
// @ts-expect-error plain JavaScript helper without types
import { fixesAlong, syntheticDirections } from './lib.mjs'

const counts = vi.hoisted(() => ({
  renders: {} as Record<string, number>,
  changedProps: {} as Record<string, Record<string, number>>,
  setData: {} as Record<string, { calls: number; bytes: number; points: number }>,
  easeTo: 0,
  commits: 0,
  commitMs: 0,
}))

/** What memo() returns, as far as counting needs it. */
type MemoLike<P> = { type: (props: P) => ReactNode; compare?: ((a: P, b: P) => boolean) | null }

/** Wraps a component so that each render is counted, with the props that changed since the last one. */
const counting = vi.hoisted(() => {
  return <P extends Record<string, unknown>>(name: string, component: ((props: P) => ReactNode) | MemoLike<P>): never => {
    // A memo()'d component: count the inner function and keep the memo, so a render the
    // memo skips is not counted.
    if (typeof component !== 'function') return memo(counting(name, component.type), component.compare ?? undefined) as never
    let last: P | null = null
    return ((props: P) => {
      counts.renders[name] = (counts.renders[name] ?? 0) + 1
      const changed = (counts.changedProps[name] ??= {})
      if (last !== null) {
        const keys = Object.keys(props).filter((key) => !Object.is(props[key], last![key]))
        for (const key of keys) changed[key] = (changed[key] ?? 0) + 1
        if (keys.length === 0) changed['(none)'] = (changed['(none)'] ?? 0) + 1
      }
      last = props
      return component(props)
    }) as never
  }
})

vi.mock('mapbox-gl/dist/mapbox-gl.css', () => ({}))
vi.mock('mapbox-gl/esm', () => {
  const pointsIn = (data: { features: { geometry: { type: string; coordinates: unknown[] } }[] }) =>
    data.features.reduce((n, f) => n + (f.geometry.type === 'LineString' ? f.geometry.coordinates.length : 1), 0)
  class Map {
    private sources: Record<string, { setData: (data: never) => void }> = {}
    on(event: string, layerOrFn: unknown) {
      if (event === 'load' && typeof layerOrFn === 'function') queueMicrotask(layerOrFn as () => void)
      return this
    }
    addControl() {}
    addLayer() {}
    addSource(id: string) {
      this.sources[id] = {
        setData: (data) => {
          const entry = (counts.setData[id] ??= { calls: 0, bytes: 0, points: 0 })
          entry.calls++
          entry.bytes += JSON.stringify(data).length
          entry.points += pointsIn(data)
        },
      }
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
    easeTo() {
      counts.easeTo++
    }
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

vi.mock('../../src/map/MapView.tsx', async (original) => {
  const actual = await original<typeof import('../../src/map/MapView.tsx')>()
  return { ...actual, MapView: counting('MapView', actual.MapView as never) }
})
vi.mock('../../src/RoutePanel.tsx', async (original) => {
  const actual = await original<typeof import('../../src/RoutePanel.tsx')>()
  return { ...actual, RoutePanel: counting('RoutePanel', actual.RoutePanel as never) }
})
vi.mock('../../src/PlanPanel.tsx', async (original) => {
  const actual = await original<typeof import('../../src/PlanPanel.tsx')>()
  return { ...actual, PlanPanel: counting('PlanPanel', actual.PlanPanel as never) }
})
vi.mock('../../src/DrivePanel.tsx', async (original) => {
  const actual = await original<typeof import('../../src/DrivePanel.tsx')>()
  return { ...actual, DrivePanel: counting('DrivePanel', actual.DrivePanel as never) }
})
vi.mock('../../src/LiveDriveView.tsx', async (original) => {
  const actual = await original<typeof import('../../src/LiveDriveView.tsx')>()
  return { ...actual, LiveDriveView: counting('LiveDriveView', actual.LiveDriveView as never) }
})

const SECONDS = 60

it('counts renders and map updates over one minute of a live drive', async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const body = syntheticDirections()
  const geometry = body.routes[0].geometry.coordinates as [number, number][]
  const fixes = fixesAlong(geometry) as { lng: number; lat: number; accuracyM: number; speedMps: number; headingDeg: number }[]
  let directionsRequests = 0
  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = String(input)
    if (url.includes('/directions/')) {
      directionsRequests++
      // A probe or a baseline request (via points): no route that way. The main request: the three routes.
      const answer = url.includes('waypoints=') ? { code: 'NoRoute' } : body
      return { ok: true, status: 200, json: async () => answer }
    }
    // The signal bundle and Overpass: not there. Signal counts stay unknown; they are not what is measured.
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

  const { default: App } = await import('../../src/App.tsx')
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  const onRender = (_id: string, _phase: string, actualMs: number) => {
    counts.commits++
    counts.commitMs += actualMs
  }
  await act(async () => {
    root.render(
      <Profiler id="app" onRender={onRender}>
        <App status={{ kind: 'ok', token: 'pk.test' }} />
      </Profiler>,
    )
    await vi.advanceTimersByTimeAsync(3000)
  })

  const startButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Start drive')
  expect(startButton, 'the Start drive button').toBeDefined()
  await act(async () => {
    startButton!.click()
    await vi.advanceTimersByTimeAsync(100)
  })
  expect(emit, 'the GPS watch').not.toBeNull()
  const second = async (i: number) => {
    const fix = fixes[i]!
    await act(async () => {
      emit!({ coords: { longitude: fix.lng, latitude: fix.lat, accuracy: fix.accuracyM, speed: fix.speedMps, heading: fix.headingDeg } })
      await vi.advanceTimersByTimeAsync(1000)
    })
  }
  // Ten seconds to get going (the first fix, the first route), then the minute that is counted.
  for (let i = 0; i < 10; i++) await second(i)
  expect(container.querySelector('.app.live'), 'the drive view').not.toBeNull()
  const before = structuredClone(counts)
  const requestsBefore = directionsRequests
  for (let i = 10; i < 10 + SECONDS; i++) await second(i)

  const perSecond = (n: number) => (n / SECONDS).toFixed(2)
  console.log(`\nOne minute of a live drive (${SECONDS} fixes, 1 Hz), 60 km / 3000-vertex route, per second of driving:`)
  console.log(`  React commits of the app: ${perSecond(counts.commits - before.commits)} (${((counts.commitMs - before.commitMs) / SECONDS).toFixed(2)} ms of render work per second in jsdom)`)
  for (const name of Object.keys(counts.renders).sort()) {
    const renders = counts.renders[name]! - (before.renders[name] ?? 0)
    const changed = Object.entries(counts.changedProps[name] ?? {})
      .map(([key, n]) => [key, n - (before.changedProps[name]?.[key] ?? 0)] as const)
      .filter(([, n]) => n > 0)
      .sort((x, y) => y[1] - x[1])
      .map(([key, n]) => `${key} x${n}`)
      .join(', ')
    console.log(`  ${name.padEnd(14)} renders ${perSecond(renders)}   props that changed: ${changed || 'none'}`)
  }
  for (const id of Object.keys(counts.setData).sort()) {
    const now = counts.setData[id]!
    const was = before.setData[id] ?? { calls: 0, bytes: 0, points: 0 }
    const calls = now.calls - was.calls
    console.log(
      `  setData('${id}') ${perSecond(calls)} calls` +
        (calls > 0 ? `, ${((now.bytes - was.bytes) / calls / 1024).toFixed(1)} kB and ${Math.round((now.points - was.points) / calls)} points per call` : ''),
    )
  }
  console.log(`  map.easeTo ${perSecond(counts.easeTo - before.easeTo)} calls`)
  console.log(`  Directions requests in the minute: ${directionsRequests - requestsBefore}`)

  root.unmount()
  vi.useRealTimers()
  expect(counts.renders.MapView).toBeGreaterThan(0)
})
