import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_REROUTE_OPTIONS, rankRoutes, type RouteCandidate, type SignalCoverage } from '../src/core/index.ts'
import { DEFAULT_DRIVE_SETTINGS } from '../src/drive/simulation.ts'
import type { DriveSim, DriveView } from '../src/useDriveSim.ts'

// Mapbox GL needs WebGL, which Node does not have. The smoke test checks the
// React tree renders and wires the right pieces; the real map is checked in a browser.
vi.mock('mapbox-gl/esm', () => ({}))
vi.mock('mapbox-gl/dist/mapbox-gl.css', () => ({}))

const { default: App } = await import('../src/App.tsx')
const { RoutePanel } = await import('../src/RoutePanel.tsx')
const { DrivePanel } = await import('../src/DrivePanel.tsx')

describe('App smoke test', () => {
  it('shows setup help when no token is set', () => {
    const html = renderToString(<App status={{ kind: 'missing' }} />)
    expect(html).toContain('RouteIQ')
    expect(html).toContain('.env.local')
    expect(html).not.toContain('data-testid="map"')
  })

  it('renders the map container and the default trip with a token', () => {
    const html = renderToString(<App status={{ kind: 'ok', token: 'pk.test' }} />)
    expect(html).toContain('data-testid="map"')
    expect(html).toContain('Uptown Charlotte')
    expect(html).toContain('Indian Land, SC (US-521 &amp; SC-160)')
    expect(html).not.toContain('SouthPark')
  })

  it('refuses a secret token', () => {
    const html = renderToString(<App status={{ kind: 'secret' }} />)
    expect(html).toContain('secret token')
    expect(html).not.toContain('data-testid="map"')
  })

  it('offers swap and reset, and says routes are loading, only with a token', () => {
    // Effects do not run in renderToString, so no route request is ever made here.
    const withToken = renderToString(<App status={{ kind: 'ok', token: 'pk.test' }} />)
    expect(withToken).toContain('Swap')
    expect(withToken).toContain('Reset to test points')
    expect(withToken).toContain('Finding routes')
    expect(withToken).toContain('Origin')
    expect(withToken).toContain('Destination')
    expect(withToken).not.toContain('pk.test')
    const without = renderToString(<App status={{ kind: 'missing' }} />)
    expect(without).not.toContain('Swap')
    expect(without).not.toContain('Finding routes')
  })

  it('offers the simulated drive in the panel, not startable before there is a route', () => {
    const html = renderToString(<App status={{ kind: 'ok', token: 'pk.test' }} />)
    expect(html).toContain('Simulate drive')
    expect(html).toMatch(/<button type="button" disabled="">Start drive<\/button>/)
    expect(html).toContain('Reroute settings')
    expect(renderToString(<App status={{ kind: 'missing' }} />)).not.toContain('Simulate drive')
  })
})

describe('DrivePanel', () => {
  const nothing = () => {}
  const idle: DriveSim = {
    status: 'idle',
    view: null,
    multiplier: 5,
    setMultiplier: nothing,
    settings: DEFAULT_DRIVE_SETTINGS,
    setSettings: nothing,
    rerouteOptions: DEFAULT_REROUTE_OPTIONS,
    setRerouteOptions: nothing,
    whatIfDelaySec: 0,
    setWhatIfDelaySec: nothing,
    canStart: true,
    start: nothing,
    pause: nothing,
    resume: nothing,
    stop: nothing,
  }
  const view: DriveView = {
    simTimeSec: 185,
    car: [-80.85, 35.2],
    routeAhead: [
      [-80.85, 35.2],
      [-80.86, 35.0],
    ],
    remainingM: 24_140,
    requestsUsed: 3,
    polling: false,
    candidates: null,
    ranked: [],
    currentCandidateId: null,
    signals: [],
    turn: null,
    log: [
      { id: 1, simTimeSec: 0, kind: 'note', text: 'Drive started: 35 min, 21 mi.', simulated: false },
      { id: 2, simTimeSec: 60, kind: 'stay', text: 'Staying: current route is still the fastest', simulated: false },
      { id: 3, simTimeSec: 120, kind: 'stay', text: 'Staying: faster route saves 3 minutes, confirming, check 1 of 2', simulated: true },
      { id: 4, simTimeSec: 180, kind: 'switch', text: 'Switching: saves 3 minutes, turn in 0.8 miles', simulated: true },
    ],
  }

  it('idle: speed choices, a start button, the request budget in words, and the thresholds', () => {
    const html = renderToString(<DrivePanel sim={idle} />).replace(/<!-- -->/g, '')
    expect(html).toContain('>1×<')
    expect(html).toContain('>20×<')
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1)
    expect(html).toContain('<button type="button">Start drive</button>')
    expect(html).toContain('at most one request per 5 real seconds and 60 per drive')
    expect(html).not.toContain('Pause')
    expect(html).not.toContain('Stop')
    // Every default threshold is on show, the 5% as a percentage.
    for (const text of ['Minimum saving (seconds)', 'Checks in a row before switching', 'Cooldown after a switch (seconds)', 'Minimum distance to a freeway exit (meters)']) {
      expect(html).toContain(text)
    }
    for (const value of [60, 120, 5, 2, 300, 600, 400, 20, 1200, 3]) expect(html).toContain(`value="${value}"`)
    // The what-if control is a development aid and off unless asked for.
    expect(html).not.toContain('What-if')
    expect(renderToString(<DrivePanel sim={{ ...idle, canStart: false }} />)).toContain('disabled="">Start drive')
  })

  it('running: pause and stop, simulated time, requests used of the cap, and the log newest first', () => {
    const html = renderToString(<DrivePanel sim={{ ...idle, status: 'running', view }} />).replace(/<!-- -->/g, '')
    expect(html).toContain('Pause')
    expect(html).toContain('Stop')
    expect(html).not.toContain('Start drive')
    expect(html).toContain('simulated time 3:05')
    expect(html).toContain('15 mi to go')
    expect(html).toContain('Directions requests: 3 of 60 (at most one per 5 s)')
    const order = ['Switching: saves 3 minutes, turn in 0.8 miles', 'confirming, check 1 of 2', 'current route is still the fastest', 'Drive started']
    const places = order.map((text) => html.indexOf(text))
    expect(places.every((p) => p >= 0)).toBe(true)
    expect([...places].sort((a, b) => a - b)).toEqual(places)
    expect(html).toContain('class="drive-log-switch"')
    expect(html).toContain('>3:00</span>')
    expect(renderToString(<DrivePanel sim={{ ...idle, status: 'paused', view }} />)).toContain('Resume')
    expect(renderToString(<DrivePanel sim={{ ...idle, status: 'arrived', view }} />)).toContain('Drive again')
  })

  it('what-if: shown only when asked for, and always labelled as simulated', () => {
    const off = renderToString(<DrivePanel sim={{ ...idle, status: 'running', view }} showWhatIf />).replace(/<!-- -->/g, '')
    expect(off).toContain('What-if (simulated, not real traffic)')
    expect(off).toContain('Add delay from the next check')
    expect(off).not.toContain('Clear')
    const on = renderToString(
      <DrivePanel sim={{ ...idle, status: 'running', view, whatIfDelaySec: 300 }} showWhatIf />,
    ).replace(/<!-- -->/g, '')
    expect(on).toContain('Simulated: +5 min on the current route')
    expect(on).toContain('Clear')
    // Nothing to delay before a drive is on.
    expect(renderToString(<DrivePanel sim={idle} showWhatIf />)).toContain('disabled="">Add delay from the next check')
  })
})

describe('RoutePanel', () => {
  const route = (id: string, durationSec: number, typicalDurationSec: number | null): RouteCandidate => ({
    id,
    geometry: [
      [-80.84, 35.22],
      [-80.83, 35.15],
    ],
    durationSec,
    typicalDurationSec,
    distanceM: 9300,
    signalCount: null,
    signalCoverage: 'none',
    providerSignalCount: null,
    intersections: null,
    limitedAccessSpansM: null,
    maneuvers: [],
  })
  /** The route with a signal count that covers all of it. */
  const counted = (r: RouteCandidate, signalCount: number, signalCoverage: SignalCoverage = 'full') => ({
    ...r,
    signalCount,
    signalCoverage,
  })
  const idle = {
    loading: false,
    error: null,
    onSelect: () => {},
    onRetry: () => {},
    signalsStatus: 'ready' as const,
    signalsError: null,
    onRetrySignals: () => {},
  }

  it('lists ETA, distance and difference from typical, and marks the selected route', () => {
    const routes = [route('route-0', 900, 780), route('route-1', 840, null)]
    const html = renderToString(<RoutePanel {...idle} ranked={rankRoutes(routes)} selectedId="route-1" />)
    expect(html).toContain('15 min')
    expect(html).toContain('14 min')
    expect(html).toContain('5.8 mi')
    expect(html).toContain('2 min slower than typical')
    expect(html).toContain('No typical time available')
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1)
  })

  it('lists routes in rank order with one Recommended badge and a reason under each', () => {
    // Given slowest first; the panel shows them as ranked.
    const routes = [
      counted(route('slow', 1020, null), 9),
      counted(route('fast', 840, null), 12),
      counted(route('calm', 860, null), 9),
    ]
    const html = renderToString(<RoutePanel {...idle} ranked={rankRoutes(routes)} selectedId="slow" />)
    expect(html.match(/Recommended/g)).toHaveLength(1)
    const order = [
      'Within 30 s of the fastest, 3 fewer signals',
      'Fastest right now, 3 more signals than the recommended route',
      '3 min slower than the fastest',
    ]
    const places = order.map((text) => html.indexOf(text))
    expect(places.every((at) => at >= 0)).toBe(true)
    expect([...places].sort((a, b) => a - b)).toEqual(places)
    // The badge sits on rank 1, before the second route starts.
    expect(html.indexOf('Recommended')).toBeGreaterThan(html.indexOf('Route 1'))
    expect(html.indexOf('Recommended')).toBeLessThan(html.indexOf('Route 2'))
    // Highlighting follows the selection (the slowest, ranked last), not the rank.
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1)
    expect(html.indexOf('aria-pressed="true"')).toBeGreaterThan(html.indexOf('Route 2'))
  })

  it('shows the signal count of each route once the signal data is in', () => {
    const routes = [
      { ...counted(route('route-0', 900, 780), 14), providerSignalCount: 17 },
      counted(route('route-1', 840, null), 1),
      counted(route('route-2', 990, null), 0),
    ]
    const html = renderToString(<RoutePanel {...idle} ranked={rankRoutes(routes)} selectedId="route-1" />)
    expect(html).toContain('14 signals')
    expect(html).toContain('1 signal<')
    // A full count of zero is an answer like any other.
    expect(html).toContain('>0 signals<')
    // Both sources are credited, OpenStreetMap with the link its license asks for.
    expect(html).toContain('href="https://www.openstreetmap.org/copyright"')
    expect(html).toContain('© OpenStreetMap contributors')
    expect(html).toContain('City of Charlotte (CDOT)')
    expect(html).toContain('CC BY-NC-SA 4.0')
    expect(html).not.toContain('within 20 m')
    expect(html).not.toContain('Retry signals')
    // The Mapbox count is a hover cross-check only, never shown as the count.
    expect(html).toContain('title="Cross-check: Mapbox flags 17 signalized intersections on this route."')
    expect(html).not.toContain('17 signals')
    expect(html.match(/title=/g)).toHaveLength(1)
  })

  it('dates the signal data in the footnote when it knows the date', () => {
    const routes = [counted(route('route-0', 900, 780), 14)]
    const dated = renderToString(
      <RoutePanel {...idle} ranked={rankRoutes(routes)} selectedId="route-0" signalDataDate={Date.UTC(2026, 10, 10)} />,
    )
    // React puts a comment between pieces of text; the reader sees "Signal data: OpenStreetMap, Nov 2026 (".
    expect(dated.replace(/<!-- -->/g, '')).toContain('Signal data: OpenStreetMap, Nov 2026 (<a href="https://www.openstreetmap.org/copyright"')
    const undated = renderToString(<RoutePanel {...idle} ranked={rankRoutes(routes)} selectedId="route-0" />)
    expect(undated.replace(/<!-- -->/g, '')).toContain('Signal data: OpenStreetMap (<a ')
    expect(undated).not.toContain('1970')
  })

  it('says so while signals are loading, and never shows a guess', () => {
    const routes = [route('route-0', 900, 780)]
    const loading = renderToString(
      <RoutePanel {...idle} signalsStatus="loading" ranked={rankRoutes(routes)} selectedId="route-0" />,
    )
    // Routes are already listed; only the signal line waits.
    expect(loading).toContain('15 min')
    expect(loading).toContain('Counting signals…')
    expect(loading).not.toContain('Signals: unknown')
    expect(loading).not.toContain('title=')
    // Data is in, but nothing is known about this route.
    const uncounted = renderToString(<RoutePanel {...idle} ranked={rankRoutes(routes)} selectedId="route-0" />)
    expect(uncounted).toContain('Signals: unknown')
    expect(uncounted).not.toContain('0 signals')
  })

  // Was "keeps routes usable when the signal data fails": a failed download no longer blanks every
  // count. The routes it touches show a partial count, the rest keep theirs, and the note offers a retry.
  it('keeps routes usable when some signal data is missing, with partial counts, a note and a retry', () => {
    const routes = [
      counted(route('route-0', 900, 780), 9, 'partial'),
      counted(route('route-1', 1000, null), 12),
      counted(route('route-2', 1100, null), 0, 'partial'),
      route('route-3', 1200, null),
    ]
    const html = renderToString(
      <RoutePanel
        {...idle}
        signalsStatus="partial"
        signalsError="Signal data for part of this trip could not be loaded."
        ranked={rankRoutes(routes)}
        selectedId="route-0"
      />,
    )
    expect(html).toContain('15 min')
    // A lower bound is labelled as one; a full count is plain; missing data is never shown as zero.
    expect(html).toContain('≥ 9 signals (partial)')
    expect(html).toContain('>12 signals<')
    expect(html.match(/Signals: unknown/g)).toHaveLength(2)
    expect(html).not.toContain('>9 signals<')
    expect(html).not.toContain('>0 signals')
    // Hovering a count that is not whole says why.
    expect(html).toContain('title="Signal data for part of this route is missing, so this is a lower bound."')
    expect(html.match(/title="Signal data for this route could not be loaded."/g)).toHaveLength(2)
    expect(html.match(/title=/g)).toHaveLength(3)
    expect(html).toContain('Signal data for part of this trip could not be loaded.')
    expect(html).toContain('Retry signals')
    // A note, not an alarm: the route error box is not used for this.
    expect(html).not.toContain('role="alert"')
  })

  it('shows an error with a way to retry, and no routes', () => {
    const html = renderToString(
      <RoutePanel {...idle} ranked={[]} selectedId={null} error="Could not reach Mapbox." />,
    )
    expect(html).toContain('role="alert"')
    expect(html).toContain('Could not reach Mapbox.')
    expect(html).toContain('Try again')
    expect(html).not.toContain('aria-pressed')
  })
})
