import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  addCustomPlace,
  addRecent,
  DEFAULT_REROUTE_OPTIONS,
  DEFAULT_TRIP,
  EMPTY_PLACE_BOOK,
  rankRoutes,
  serializePlaceBook,
  setLastTrip,
  setSlot,
  type Place,
  type PlaceBook,
  type RouteCandidate,
  type SignalCoverage,
} from '../src/core/index.ts'
import { LIVE_IDLE, liveStep, liveView, type LiveEvent, type LiveState } from '../src/core/index.ts'
import { DEFAULT_DRIVE_SETTINGS } from '../src/drive/simulation.ts'
import { memoryTextStore } from '../src/storage/local.ts'
import { PLACE_BOOK_KEY } from '../src/storage/placeBook.ts'
import type { PlaceBookState } from '../src/usePlaceBook.ts'
import type { DriveSim, DriveView } from '../src/useDriveSim.ts'

// Mapbox GL needs WebGL, which Node does not have. The smoke test checks the
// React tree renders and wires the right pieces; the real map is checked in a browser.
vi.mock('mapbox-gl/esm', () => ({}))
vi.mock('mapbox-gl/dist/mapbox-gl.css', () => ({}))

const { default: App } = await import('../src/App.tsx')
const { RoutePanel } = await import('../src/RoutePanel.tsx')
const { DrivePanel } = await import('../src/DrivePanel.tsx')
const { PlanPanel } = await import('../src/PlanPanel.tsx')
const { LiveDriveView } = await import('../src/LiveDriveView.tsx')

// Public landmarks only.
const STADIUM: Place = { id: 'mapbox:stadium', label: 'Bank of America Stadium', position: [-80.8528, 35.2258] }
const AIRPORT: Place = { id: 'mapbox:airport', label: 'Charlotte Douglas International Airport', position: [-80.9431, 35.214] }
const PARK: Place = { id: 'mapbox:park', label: 'Carowinds', position: [-80.9414, 35.1037] }

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

  it('opens with the last trip when this device has one, and with the built-in trip when it does not', () => {
    const book = setLastTrip(EMPTY_PLACE_BOOK, { origin: STADIUM, destination: PARK })
    const placeStore = memoryTextStore({ [PLACE_BOOK_KEY]: JSON.stringify(serializePlaceBook(book)) })
    const html = renderToString(<App status={{ kind: 'ok', token: 'pk.test' }} placeStore={placeStore} />)
    expect(html).toContain('value="Bank of America Stadium"')
    expect(html).toContain('value="Carowinds"')
    expect(html).not.toContain('Uptown Charlotte')
    // An origin that was not kept (it was the device's position) comes from the built-in trip.
    const noOrigin = memoryTextStore({
      [PLACE_BOOK_KEY]: JSON.stringify(serializePlaceBook(setLastTrip(EMPTY_PLACE_BOOK, { origin: null, destination: PARK }))),
    })
    const partly = renderToString(<App status={{ kind: 'ok', token: 'pk.test' }} placeStore={noOrigin} />)
    expect(partly).toContain('value="Uptown Charlotte (Trade &amp; Tryon)"')
    expect(partly).toContain('value="Carowinds"')
    // Corrupt storage is the same as none.
    const corrupt = memoryTextStore({ [PLACE_BOOK_KEY]: '{"version":1,' })
    const fresh = renderToString(<App status={{ kind: 'ok', token: 'pk.test' }} placeStore={corrupt} />)
    expect(fresh).toContain('value="Uptown Charlotte (Trade &amp; Tryon)"')
    expect(fresh).toContain('value="Indian Land, SC (US-521 &amp; SC-160)"')
    expect(corrupt.read(PLACE_BOOK_KEY)).toBeNull()
  })

  it('offers the simulated drive in the panel, not startable before there is a route', () => {
    const html = renderToString(<App status={{ kind: 'ok', token: 'pk.test' }} />)
    expect(html).toContain('Simulate drive')
    expect(html).toMatch(/<button type="button" disabled="">Start simulated drive<\/button>/)
    expect(html).toContain('Reroute settings')
    expect(renderToString(<App status={{ kind: 'missing' }} />)).not.toContain('Simulate drive')
  })
})

describe('PlanPanel', () => {
  const nothing = () => {}
  const state = (book: PlaceBook, storageNote: string | null = null): PlaceBookState => ({
    book,
    storageNote,
    setSlot: nothing,
    addCustom: () => null,
    rename: () => null,
    remove: nothing,
    addRecent: nothing,
    rememberTrip: nothing,
    clear: nothing,
  })
  const render = (places: PlaceBookState) =>
    renderToString(
      <PlanPanel
        pins={DEFAULT_TRIP}
        token="pk.test"
        places={places}
        getProximity={() => DEFAULT_TRIP.origin.position}
        onPlace={nothing}
        onSwap={nothing}
        onReset={nothing}
      />,
    ).replace(/<!-- -->/g, '')

  it('first run: two labelled search fields, use my location, and Home and Work waiting to be set', () => {
    const html = render(state(EMPTY_PLACE_BOOK))
    // Real inputs, each tied to its label, each a combobox over a listbox that is closed for now.
    const inputs = html.match(/<input[^>]*role="combobox"[^>]*>/g) ?? []
    expect(inputs).toHaveLength(2)
    for (const input of inputs) {
      const id = /id="([^"]+)"/.exec(input)![1]!
      expect(html).toContain(`<label for="${id}"`)
      expect(input).toContain('aria-expanded="false"')
      expect(input).toContain('aria-autocomplete="list"')
      expect(input).toContain('autoComplete="off"')
    }
    expect(html).toMatch(/<label for="[^"]+" class="dot"[^>]*>Origin<\/label>/)
    expect(html).toMatch(/<label for="[^"]+" class="dot"[^>]*>Destination<\/label>/)
    expect(html).toContain('value="Uptown Charlotte (Trade &amp; Tryon)"')
    expect(html).not.toContain('role="listbox"')
    expect(html).toContain('>Use my location</button>')
    expect(html).toContain('Set Home…')
    expect(html).toContain('Set Work…')
    expect(html).toContain('No recent destinations yet')
    expect(html).toContain('Clear saved places and history')
    expect(html).toContain('Swap')
    expect(html).toContain('Reset to test points')
    // Says where things are kept and what leaves the device; shows no alarm and no token.
    expect(html).toContain('kept in this browser only')
    expect(html).toContain('sent to Mapbox')
    expect(html).not.toContain('role="alert"')
    expect(html).not.toContain('pk.test')
  })

  it('with a place book: saved places one tap away, recents listed newest first, and ways to manage them', () => {
    let book = setSlot(setSlot(EMPTY_PLACE_BOOK, 'home', STADIUM), 'work', AIRPORT)
    book = addCustomPlace(book, 'Rides', PARK).book
    book = addRecent(addRecent(book, AIRPORT), PARK)
    const html = render(state(book))
    for (const name of ['Home', 'Work', 'Rides']) expect(html).toContain(`>${name}</button>`)
    expect(html).not.toContain('Set Home…')
    expect(html).toContain('title="Bank of America Stadium"')
    expect(html).not.toContain('No recent destinations yet')
    const recents = html.slice(html.indexOf('aria-label="Recent destinations"'))
    expect(recents.indexOf('>Carowinds<')).toBeGreaterThan(0)
    expect(recents.indexOf('>Carowinds<')).toBeLessThan(recents.indexOf('>Charlotte Douglas International Airport<'))
    // Only a named place can be renamed; all three can be removed.
    expect(html.match(/>Rename</g)).toHaveLength(1)
    expect(html.match(/aria-label="Remove /g)).toHaveLength(3)
    expect(html).toContain('Save as Home')
    expect(html).toContain('Saving the destination: Indian Land, SC (US-521 &amp; SC-160)')
  })

  it('says so when the device would not store the places', () => {
    const html = render(state(EMPTY_PLACE_BOOK, 'This browser would not store your places.'))
    expect(html).toContain('role="alert"')
    expect(html).toContain('This browser would not store your places.')
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
    expect(html).toContain('<button type="button">Start simulated drive</button>')
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
    expect(renderToString(<DrivePanel sim={{ ...idle, canStart: false }} />)).toContain('disabled="">Start simulated drive')
  })

  it('running: pause and stop, simulated time, requests used of the cap, and the log newest first', () => {
    const html = renderToString(<DrivePanel sim={{ ...idle, status: 'running', view }} />).replace(/<!-- -->/g, '')
    expect(html).toContain('Pause')
    expect(html).toContain('Stop')
    expect(html).not.toContain('Start simulated drive')
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

describe('Start drive and the live drive view', () => {
  const nothing = () => {}
  const T0 = 1_800_000_000_000
  // Public landmarks only: from Bank of America Stadium towards the airport.
  const route: RouteCandidate = {
    id: 'live',
    geometry: [STADIUM.position, [-80.9, 35.22], AIRPORT.position],
    durationSec: 900,
    typicalDurationSec: 840,
    distanceM: 8600,
    signalCount: null,
    signalCoverage: 'none',
    providerSignalCount: null,
    intersections: null,
    limitedAccessSpansM: null,
    maneuvers: [],
    guidance: [
      { atDistanceM: 0, location: STADIUM.position, type: 'depart', modifier: null, primaryText: 'South Mint Street', secondaryText: null, announcements: [], synthesized: false },
      { atDistanceM: 4300, location: [-80.9, 35.22], type: 'turn', modifier: 'right', primaryText: 'Wilkinson Boulevard', secondaryText: 'US 74 West', announcements: [], synthesized: false },
    ],
  }
  const fixAt = (sec: number) => ({ lng: STADIUM.position[0], lat: STADIUM.position[1], accuracyM: 8, speedMps: 0, headingDeg: null, timeMs: T0 + sec * 1000 })
  const play = (events: LiveEvent[]): LiveState => events.reduce((state, event) => liveStep(state, event).state, LIVE_IDLE)
  const started: LiveEvent[] = [
    { type: 'start', nowMs: T0, destination: AIRPORT.position },
    { type: 'fix', nowMs: T0, fix: fixAt(0) },
  ]
  const driving = play([...started, { type: 'routes', nowMs: T0 + 1000, requestId: 1, routes: [route] }])
  const render = (state: LiveState, nowMs: number, extra: { replaying?: boolean; speechSupported?: boolean } = {}) =>
    renderToString(
      <LiveDriveView
        state={state}
        view={liveView(state, nowMs)}
        destinationLabel="Charlotte Douglas International Airport"
        onKeepPrevious={nothing}
        onMute={nothing}
        onEnd={nothing}
        onRestart={nothing}
        {...extra}
      />,
    ).replace(/<!-- -->/g, '')

  it('the route panel leads with a large Start drive button and says what it does with the location', () => {
    const idle = { loading: false, error: null, onSelect: nothing, onRetry: nothing, signalsStatus: 'ready' as const, signalsError: null, onRetrySignals: nothing }
    const html = renderToString(<RoutePanel {...idle} ranked={[]} selectedId={null} onStartDrive={nothing} />)
    expect(html).toContain('<button type="button" class="start-drive-button">Start drive</button>')
    expect(html).toContain('Works while this page stays in front with the screen on')
    expect(html).toContain('Your location is not stored')
    expect(renderToString(<RoutePanel {...idle} ranked={[]} selectedId={null} onStartDrive={nothing} canStartDrive={false} />)).toContain('disabled="">Start drive')
    // Without a handler there is no button.
    expect(renderToString(<RoutePanel {...idle} ranked={[]} selectedId={null} />)).not.toContain('Start drive')
    // The app offers it, in the planning layout.
    const app = renderToString(<App status={{ kind: 'ok', token: 'pk.test' }} />)
    expect(app).toContain('class="start-drive-button">Start drive</button>')
    expect(app).not.toContain('class="app live"')
  })

  it('before the first route it says what it is waiting for, with Mute and End already there', () => {
    const html = render(play(started), T0)
    expect(html).toContain('Finding a route…')
    expect(html).toContain('>Mute</button>')
    expect(html).toContain('>End</button>')
    expect(html).not.toContain('Keep previous route')
    expect(render(play([started[0]!]), T0)).toContain('Finding your position…')
  })

  it('driving: the next turn with its arrow, distance and road, the arrival time, and a quiet status line', () => {
    const html = render(driving, T0 + 13_000)
    expect(html).toContain('data-arrow="right"')
    expect(html).toContain('<span class="live-turn-distance">2.7 mi</span>')
    expect(html).toContain('Turn right: </span>Wilkinson Boulevard')
    expect(html).toContain('US 74 West')
    // Arrival time, minutes left, distance left.
    expect(html).toMatch(/<p class="live-eta"><strong>\d{1,2}:\d{2}[^<]*<\/strong><span>1[45] min<\/span><span>\d\.\d mi<\/span><\/p>/)
    expect(html).toContain('Watching for a faster route. · checked 12 s ago · 1 of 60 requests')
    expect(html).toContain('aria-pressed="false">Mute</button>')
    expect(html).not.toContain('GPS replay')
    expect(render(driving, T0 + 13_000, { replaying: true })).toContain('GPS replay (simulated position)')
    expect(render({ ...driving, muted: true }, T0 + 13_000)).toContain('aria-pressed="true">Unmute</button>')
  })

  it('shows a switch with one large way to undo it, and warnings in one line each', () => {
    const switched: LiveState = {
      ...driving,
      switchBanner: { untilMs: T0 + 30_000, text: 'Switched to a faster route: saves 3 minutes', canKeep: true },
      wakeLock: 'unavailable',
      pausedNote: { seconds: 42, untilMs: T0 + 30_000 },
    }
    const html = render(switched, T0 + 20_000)
    expect(html).toContain('<strong>Switched to a faster route: saves 3 minutes</strong>')
    expect(html).toContain('class="live-button live-keep">Keep previous route</button>')
    expect(html).toContain('RouteIQ was paused for 42 s while in the background.')
    expect(html).toContain('Keep the screen on yourself')
    // After leaving the route there is nothing to keep.
    const replanned = render({ ...switched, switchBanner: { untilMs: T0 + 30_000, text: 'New route from here', canKeep: false } }, T0 + 20_000)
    expect(replanned).toContain('New route from here')
    expect(replanned).not.toContain('Keep previous route')
    expect(render(driving, T0, { speechSupported: false })).toContain('This browser cannot speak')
  })

  it('a failure says why and offers to try again; arrival sums the trip up', () => {
    const denied = play([started[0]!, { type: 'position-error', nowMs: T0, kind: 'denied' }])
    const failed = render(denied, T0)
    expect(failed).toContain('role="alert">Location permission was denied.')
    expect(failed).toContain('>Try again</button>')
    expect(failed).toContain('>Close</button>')

    const arrived: LiveState = {
      ...driving,
      status: 'arrived',
      summary: {
        tripSec: 1500,
        switches: [{ atMs: T0 + 600_000, code: 'faster-route', reason: 'Switching: saves 3 minutes, turn in 0.8 miles', savingSec: 180 }],
        declined: 1,
        requestsUsed: 26,
      },
    }
    const html = render(arrived, T0 + 1_500_000)
    expect(html).toContain('You have arrived')
    expect(html).toContain('Charlotte Douglas International Airport')
    expect(html).toContain('Trip time 25 min')
    expect(html).toContain('RouteIQ changed route once:')
    expect(html).toMatch(/<li>\d{1,2}:\d{2}[^<]*: saves 3 minutes, turn in 0\.8 miles<\/li>/)
    expect(html).toContain('You kept the previous route once.')
    expect(html).toContain('Route requests used: 26.')
    expect(html).toContain('>Done</button>')
    expect(render({ ...arrived, summary: { ...arrived.summary!, switches: [], declined: 0 } }, T0)).toContain('stayed on the first route')
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

  it('offers Google Maps and Waze hand-off links on the selected route only', () => {
    const routes = [route('route-0', 900, 780), route('route-1', 840, null)]
    const html = renderToString(<RoutePanel {...idle} ranked={rankRoutes(routes)} selectedId="route-1" />)
    expect(html.match(/Open in Google Maps/g)).toHaveLength(1)
    expect(html.match(/Open in Waze/g)).toHaveLength(1)
    expect(html).toContain(
      'href="https://www.google.com/maps/dir/?api=1&amp;origin=35.220000%2C-80.840000&amp;destination=35.150000%2C-80.830000&amp;travelmode=driving"',
    )
    expect(html).toContain('href="https://waze.com/ul?ll=35.150000%2C-80.830000&amp;navigate=yes"')
    expect(html.match(/target="_blank" rel="noopener"/g)).toHaveLength(2)
    expect(renderToString(<RoutePanel {...idle} ranked={rankRoutes(routes)} selectedId={null} />)).not.toContain('Open in')
    const fromHere = renderToString(
      <RoutePanel {...idle} ranked={rankRoutes(routes)} selectedId="route-1" originIsDeviceLocation />,
    )
    expect(fromHere).toContain('href="https://www.google.com/maps/dir/?api=1&amp;destination=35.150000%2C-80.830000')
    expect(fromHere).not.toContain('origin=')
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
    // OpenStreetMap is credited with the link its license asks for, and it is the only signal data.
    expect(html).toContain('href="https://www.openstreetmap.org/copyright"')
    expect(html).toContain('© OpenStreetMap contributors')
    expect(html).not.toContain('City of Charlotte')
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
