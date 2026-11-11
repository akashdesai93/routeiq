// The e2e harness: the real app (production build) in a real browser, with
// everything outside the browser replaced:
//
// - Every request that leaves localhost is answered here: Directions from the
//   made-up road network (world/roads.ts), Search Box from the hand-written
//   fixtures in tests/fixtures, the map style with a blank one, and the rest
//   (telemetry, Overpass) as each scenario says. A request
//   nothing here answers fails the scenario: no test ever reaches the network.
// - GPS, voice and the clock are stubbed in the page (browserStubs.ts and
//   Playwright's page.clock), so a 20-minute drive runs in seconds, the same
//   way every time.
//
// Evidence: `app.snap('...')` attaches a screenshot to the report and every
// scenario attaches what was said out loud, in order.

import { readFileSync } from 'node:fs'
import { test as base, expect, type Page, type Request, type Route, type TestInfo } from '@playwright/test'
import { installBrowserStubs, type E2EWindow } from './browserStubs.ts'
import { along, alongOf, FREE_FLOW, sideStep, World, type FramePoint, type LngLat, type RoadName, type Traffic } from './world/roads.ts'

export { expect }

/** The trip the app opens with (src/core/testPoints.ts): public landmarks. */
export const UPTOWN: LngLat = [-80.8431, 35.2271]
export const INDIAN_LAND: LngLat = [-80.8561, 35.0015]

/** The fake GPS sends a fix every this many simulated seconds. */
const STEP_SEC = 2

/** The fake clock starts here: a weekday morning. */
const START_TIME = new Date('2026-11-11T08:00:00-05:00')

const BLANK_STYLE = {
  version: 8,
  name: 'e2e blank',
  sources: {},
  layers: [{ id: 'land', type: 'background', paint: { 'background-color': '#eef1ec' } }],
}

const fixture = (name: string) => readFileSync(`tests/fixtures/${name}`, 'utf8')

/** How a scenario wants the outside world to answer. Anything left out gets a sensible default. */
export interface Outside {
  /** Traffic on the made-up road network. Default: free flow. */
  traffic?: Traffic
  /** The road network has Parallel Street (S), a side street Mapbox never offers among its three. Default: no. */
  sideStreet?: boolean
  /** Answers every Mapbox request (map style, Directions, Search) with this HTTP status instead. */
  mapboxStatus?: number
  /**
   * Side-street probes are not answered until `releaseProbes()`: each waits,
   * the way a slow answer from Mapbox would. Default: answered at once.
   */
  holdProbes?: boolean
  /** Answers an Overpass tile query. Default: 504 (busy). */
  overpass?: (query: string) => { status: number; body?: unknown }
}

export interface DriveOptions {
  /**
   * The road the driver sets off on: the route picked on the plan screen,
   * which the app drives. Default: the fastest of Mapbox's own routes for the
   * trip (the recommended one when no side street beats it).
   */
  road?: RoadName
  /** Car speed on the road, meters per second. */
  speedMps?: number
  /** Give up after this many simulated seconds. */
  maxSec?: number
  /** At this simulated second the driver turns off the route the wrong way. */
  wrongTurnAtSec?: number
  /** GPS error, up to this many meters to either side of the road (deterministic). Default 0. */
  gpsNoiseM?: number
  /** Screenshots at these simulated seconds (one is also taken whenever a banner appears). */
  snapAtSec?: readonly number[]
}

export interface DriveLog {
  /** Every switch banner, in the order they appeared, with the second they appeared at. */
  banners: { atSec: number; text: string }[]
  /** The drive view's quiet line (the engine's latest reason), each time it changed, with the second it showed. */
  statusLines: { atSec: number; text: string }[]
  arrived: boolean
  seconds: number
}

export class App {
  readonly page: Page
  private readonly info: TestInfo
  private readonly worlds = new Map<string, World>()
  /** Directions requests answered so far in this scenario. */
  directionsRequests = 0
  /** What each Directions request was answered with: route names and minutes, fastest first. */
  readonly answers: { n: number; routes: { name: string; durationSec: number }[] }[] = []
  /** The drive's own checks of the route being driven (baselineProbe: vias, from a moving car): the road each one came back on. */
  readonly pathChecks: { n: number; road: string | null; vias: number }[] = []
  /**
   * Side-street probes (one via point with a `radiuses` entry), in order: the road each one came
   * back on, null for NoSegment. The plan screen's go out from the origin pin with no heading;
   * a drive's go out from the moving car with its heading (`duringDrive`).
   */
  readonly probes: {
    forRequest: number
    duringDrive: boolean
    destination: LngLat
    road: string | null
    durationSec: number | null
    radiuses: string | null
    /** Where the via was, in the trip's frame (share of the way, meters to the left). */
    via: FramePoint
    /** The `annotations` parameter the request sent. */
    annotations: string | null
  }[] = []
  /** Probe requests the page itself cancelled (aborted) before they were answered, by their index in `probes`. */
  readonly abortedProbes: number[] = []
  private held: (() => Promise<void>)[] = []
  private readonly heldRequests = new Map<Request, number>()
  readonly unexpected: string[] = []
  outside: Outside = {}
  private shot = 0

  constructor(page: Page, info: TestInfo) {
    this.page = page
    this.info = info
  }

  /** Every destination Directions was asked about, in order. */
  destinations(): LngLat[] {
    return [...this.worlds.values()].map((w) => w.destination)
  }

  /** The made-up road network for the trip to `destination` (created by the first request for it). */
  world(destination: LngLat): World | undefined {
    return this.worlds.get(destination.join(','))
  }

  async open(options: { fakeClock?: boolean; storage?: Record<string, string>; path?: string } = {}) {
    const { page } = this
    await page.context().route('**/*', (route) => this.answer(route))
    page.on('requestfailed', (request) => {
      const index = this.heldRequests.get(request)
      if (index !== undefined) this.abortedProbes.push(index)
    })
    await page.addInitScript(installBrowserStubs)
    if (options.storage !== undefined) {
      await page.addInitScript((items) => {
        for (const [k, v] of Object.entries(items)) if (localStorage.getItem(k) === null) localStorage.setItem(k, v)
      }, options.storage)
    }
    if (options.fakeClock === true) await page.clock.install({ time: START_TIME })
    await page.goto(options.path ?? '/')
  }

  /** Waits for the trip to be planned: ranked routes, with every signal count in. */
  async routesReady() {
    const panel = this.page.locator('.route-list, [aria-label="Routes"]').first()
    // The badge, not any text with the word: a route's reason can say "than the recommended route".
    await expect(this.page.locator('.route-badge', { hasText: 'Recommended' })).toBeVisible({ timeout: 15_000 })
    await expect(this.page.getByText('Counting signals')).toHaveCount(0, { timeout: 15_000 })
    return panel
  }

  /**
   * The destination of every side-street probe the page tried to make, in
   * order: each fetch the app called with a via and no bearings, including
   * one cancelled before it left the page (so never seen by `probes`).
   */
  async probeAttempts(): Promise<LngLat[]> {
    const urls = await this.page.evaluate(() => (window as unknown as E2EWindow).__e2e.fetched)
    return urls.flatMap((href) => {
      const url = new URL(href, 'http://localhost/')
      if (url.hostname !== 'api.mapbox.com' || !url.pathname.startsWith('/directions/v5/mapbox/driving-traffic/')) return []
      if (url.searchParams.get('waypoints') !== '0;2' || url.searchParams.has('bearings')) return []
      const points = decodeURIComponent(url.pathname.split('/').at(-1)!).split(';')
      return points.length === 3 ? [points[2]!.split(',').map(Number) as LngLat] : []
    })
  }

  /** Answers every held probe (see Outside.holdProbes), in the order they were asked. */
  async releaseProbes() {
    const held = this.held
    this.held = []
    for (const answer of held) await answer()
  }

  /** A screenshot in the report, named for what it shows. */
  async snap(name: string) {
    this.shot++
    const body = await this.page.screenshot()
    await this.info.attach(`${String(this.shot).padStart(2, '0')} ${name}`, { body, contentType: 'image/png' })
  }

  /** Everything said out loud so far, in order. */
  async spoken(): Promise<string[]> {
    return this.page.evaluate(() => (window as unknown as E2EWindow).__e2e.spoken.map((s) => s.text))
  }

  /** Attaches the spoken lines to the report, with the drive time each was said at. */
  async attachSpoken() {
    const lines = await this.page.evaluate(() => (window as unknown as E2EWindow).__e2e.spoken)
    const t0 = lines[0]?.atMs ?? 0
    const text = lines.map((l) => `${clock((l.atMs - t0) / 1000)}  ${l.text}`).join('\n')
    await this.info.attach('spoken lines', { body: text || '(nothing was said)', contentType: 'text/plain' })
  }

  /** Attaches what the made-up traffic server answered to each route request. */
  async attachAnswers() {
    if (this.answers.length === 0) return
    const names: Record<string, string> = { A: 'A (Main Corridor)', B: 'B (East Loop)', C: 'C (West Loop)', S: 'S (Parallel Street)', 'off-route': 'way back' }
    const minutes = (sec: number) => `${(sec / 60).toFixed(1)} min`
    const text = this.answers
      .map(({ n, routes }) => {
        const offered = routes.map((r) => `${names[r.name] ?? r.name} ${minutes(r.durationSec)}`).join(', ')
        const probes = this.probes
          .filter((p) => p.forRequest === n)
          .map((p) => (p.road === null ? 'NoSegment' : `${names[p.road] ?? p.road} ${minutes(p.durationSec ?? 0)}`))
        return `request ${String(n).padStart(2)}: ${offered}${probes.length > 0 ? `\n   probes: ${probes.join(', ')}` : ''}`
      })
      .join('\n')
    await this.info.attach('route answers', { body: text, contentType: 'text/plain' })
  }

  /**
   * Taps Start drive and drives the trip on the fake clock, one simulated
   * second at a time, the way a driver who follows the app would: on the
   * route picked on the plan screen (`road`), and onto the new one whenever
   * the app announces a switch.
   */
  async drive(options: DriveOptions = {}): Promise<DriveLog> {
    const { page } = this
    const { speedMps = 25, maxSec = 2400, wrongTurnAtSec, snapAtSec = [], gpsNoiseM = 0, road } = options
    const now = await page.evaluate(() => Date.now())
    await page.clock.pauseAt(now + 1000)
    await page.getByRole('button', { name: 'Start drive' }).click()
    await this.settle()

    // The car sets off on the route picked on the plan screen, from its start.
    const world: World | undefined = [...this.worlds.values()].at(-1)
    const first = road ?? world?.lastOffered[0]?.name
    let route: readonly LngLat[] | null = world !== undefined && first !== undefined && first !== 'off-route' ? world.cornersOf(first) : null
    let alongM = 0
    let astray: { at: LngLat; headingDeg: number; sec: number } | null = null
    let position: LngLat = UPTOWN
    let heading = 180
    let speed = 0
    const log: DriveLog = { banners: [], statusLines: [], arrived: false, seconds: 0 }
    let lastBanner = ''

    for (let sec = 0; sec < maxSec; sec += STEP_SEC) {
      if (route !== null && astray === null && wrongTurnAtSec !== undefined && sec === wrongTurnAtSec) {
        const here = along(route, alongM)
        // Turn right, square to the road.
        astray = { at: here.point, headingDeg: (here.headingDeg + 90) % 360, sec: 0 }
      }
      if (astray !== null) {
        astray.sec += STEP_SEC
        speed = 10
        heading = astray.headingDeg
        // Straight on, square to the road: "left of" the heading turned a quarter to the right.
        position = sideStep(astray.at, astray.headingDeg + 90, speed * astray.sec)
      } else if (route !== null) {
        alongM += speedMps * STEP_SEC
        const here = along(route, alongM)
        position = gpsNoiseM === 0 ? here.point : sideStep(here.point, here.headingDeg, gpsNoiseM * Math.sin(sec * 0.37) * Math.cos(sec * 0.11))
        heading = here.headingDeg
        speed = here.atEnd ? 0 : speedMps
      }
      await page.evaluate(([lng, lat, h, v]) => (window as unknown as E2EWindow).__e2e.fix(lng, lat, h, v), [
        position[0],
        position[1],
        heading,
        speed,
      ] as const)
      // fastForward fires each due timer once: the app sees the time pass, but the map draws one frame, not sixty a second.
      await page.clock.fastForward(STEP_SEC * 1000)
      const state = await this.settle()
      if (state.status !== '' && state.status !== log.statusLines.at(-1)?.text) log.statusLines.push({ atSec: sec, text: state.status })
      if (state.banner !== '' && state.banner !== lastBanner) {
        log.banners.push({ atSec: sec, text: state.banner })
        await this.snap(`minute ${Math.floor(sec / 60)}: ${state.banner}`)
        // The driver follows the app onto the route it switched to: a side street a probe
        // found during the drive, or else the fastest of what Mapbox offered.
        const probed = this.probes.filter((p) => p.duringDrive && p.road !== null && p.road !== 'off-route').at(-1)?.road as RoadName | undefined
        const next =
          state.banner.includes('via side streets') && probed !== undefined && world !== undefined
            ? { corners: world.cornersOf(probed) }
            : world?.lastOffered[0]
        if (next !== undefined) {
          route = next.corners
          alongM = alongOf(route, position)
          astray = null
        }
      }
      lastBanner = state.banner
      if (snapAtSec.some((at) => at >= sec && at < sec + STEP_SEC)) await this.snap(`driving, minute ${Math.floor(sec / 60)}`)
      log.seconds = sec + STEP_SEC
      if (state.arrived) {
        log.arrived = true
        break
      }
    }
    return log
  }

  /**
   * Waits until no request is in flight in the page (two looks in a row), and
   * says what the drive view shows then.
   */
  async settle(): Promise<{ banner: string; status: string; arrived: boolean }> {
    let quiet = 0
    for (let i = 0; i < 4000; i++) {
      const look = await this.page.evaluate(() => ({
        inflight: (window as unknown as E2EWindow).__e2e.inflight,
        banner: document.querySelector('.live-banner')?.textContent ?? '',
        // The engine's reason only, without "checked N s ago" and the request count after it.
        status: (document.querySelector('.live-status')?.textContent ?? '').split(' · ')[0]!,
        arrived: document.querySelector('[aria-label="Drive summary"]') !== null,
      }))
      quiet = look.inflight === 0 ? quiet + 1 : 0
      if (quiet >= 2) return look
      if (look.inflight > 0) await new Promise((r) => setTimeout(r, 5))
    }
    throw new Error('A request in the page never finished')
  }

  private async answer(route: Route) {
    const request = route.request()
    const url = new URL(request.url())
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return route.continue()
    if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue()
    const { mapboxStatus, traffic = FREE_FLOW, overpass, sideStreet = false } = this.outside

    if (url.hostname === 'api.mapbox.com') {
      if (mapboxStatus !== undefined) return route.fulfill({ status: mapboxStatus, json: { message: 'Not Authorized - Invalid Token' } })
      if (url.pathname.startsWith('/styles/v1/')) return route.fulfill({ json: BLANK_STYLE })
      if (url.pathname.startsWith('/directions/v5/mapbox/driving-traffic/')) {
        const coords = decodeURIComponent(url.pathname.split('/').at(-1)!).split(';')
        const points = coords.map((c) => c.split(',').map(Number) as LngLat)
        const from = points[0]
        const to = points.at(-1)
        if (from === undefined || to === undefined || points.length < 2) return route.fulfill({ status: 422, json: { code: 'InvalidInput' } })
        const key = to.join(',')
        let world = this.worlds.get(key)
        if (world === undefined) {
          world = new World(from, to, { sideStreet })
          this.worlds.set(key, world)
        }
        // A side-street probe: one via with a `radiuses` entry of its own. The plan screen's
        // come from the origin pin with no bearings; a drive's from the moving car, with its
        // heading as `bearings`. The drive's own path check (baselineProbe) also sends vias,
        // but with no `radiuses`: its points lie on the route being driven.
        const radiuses = url.searchParams.get('radiuses')
        const viaRadius = Number(radiuses?.split(';')[1])
        if (points.length === 3 && url.searchParams.get('waypoints') === '0;2' && Number.isFinite(viaRadius)) {
          // Through the via, answered with the traffic of the request it belongs to (the plan,
          // or the drive's check it follows). As Mapbox reads the radius: no road that close is NoSegment.
          const probe = world.through(from, points[1]!, traffic, this.directionsRequests, viaRadius)
          const index =
            this.probes.push({
              forRequest: this.directionsRequests,
              duringDrive: url.searchParams.has('bearings'),
              destination: to,
              road: probe.road,
              durationSec: probe.durationSec,
              radiuses,
              via: world.frameOf(points[1]!),
              annotations: url.searchParams.get('annotations'),
            }) - 1
          if (this.outside.holdProbes !== true) return route.fulfill({ json: probe.answer })
          this.heldRequests.set(request, index)
          // Answering a request the page has cancelled fails; that is the point of some scenarios.
          this.held.push(() => route.fulfill({ json: probe.answer }).catch(() => {}))
          return
        }
        // The drive's own check of the route being driven: through vias, with the car's heading.
        if (points.length > 2) {
          const path = world.pathThrough(from, points.slice(1, -1), traffic, this.directionsRequests + 1)
          if (path !== null) {
            this.directionsRequests++
            this.pathChecks.push({ n: this.directionsRequests, road: path.road, vias: points.length - 2 })
            this.answers.push({ n: this.directionsRequests, routes: [{ name: path.road, durationSec: path.durationSec }] })
            return route.fulfill({ json: path.answer })
          }
          this.pathChecks.push({ n: this.directionsRequests + 1, road: null, vias: points.length - 2 })
        }
        this.directionsRequests++
        const json = world.directions(from, traffic, this.directionsRequests)
        this.answers.push({ n: this.directionsRequests, routes: world.lastOffered.map((r) => ({ name: r.name, durationSec: r.durationSec })) })
        return route.fulfill({ json })
      }
      if (url.pathname.startsWith('/search/searchbox/v1/suggest')) return route.fulfill({ body: fixture('search.suggest.json'), contentType: 'application/json' })
      if (url.pathname.startsWith('/search/searchbox/v1/retrieve/')) return route.fulfill({ body: fixture('search.retrieve.json'), contentType: 'application/json' })
      if (url.pathname.startsWith('/map-sessions/')) return route.fulfill({ status: 204 })
    }
    if (url.hostname === 'events.mapbox.com') return route.fulfill({ status: 204 })
    if (url.hostname === 'overpass-api.de') {
      const query = new URLSearchParams(request.postData() ?? '').get('data') ?? ''
      const answer = overpass?.(query) ?? { status: 504 }
      return route.fulfill({ status: answer.status, json: answer.body ?? { remark: 'busy' } })
    }
    this.unexpected.push(`${request.method()} ${url.origin}${url.pathname}`)
    return route.abort('blockedbyclient')
  }
}

function clock(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export const test = base.extend<{ app: App }>({
  // The second argument is Playwright's "use"; named otherwise so the React hooks lint rule leaves it alone.
  app: async ({ page }, provide, info) => {
    const app = new App(page, info)
    await provide(app)
    await app.attachSpoken().catch(() => {})
    await app.attachAnswers()
    expect(app.unexpected, 'requests that would have left this PC').toEqual([])
  },
})
