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
import { test as base, expect, type Page, type Route, type TestInfo } from '@playwright/test'
import { installBrowserStubs, type E2EWindow } from './browserStubs.ts'
import { along, alongOf, FREE_FLOW, sideStep, World, type LngLat, type Traffic } from './world/roads.ts'

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
  /** Answers every Mapbox request (map style, Directions, Search) with this HTTP status instead. */
  mapboxStatus?: number
  /** Answers an Overpass tile query. Default: 504 (busy). */
  overpass?: (query: string) => { status: number; body?: unknown }
}

export interface DriveOptions {
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
    const names: Record<string, string> = { A: 'A (Main Corridor)', B: 'B (East Loop)', C: 'C (West Loop)', 'off-route': 'way back' }
    const text = this.answers
      .map(({ n, routes }) => {
        const offered = routes.map((r) => `${names[r.name] ?? r.name} ${(r.durationSec / 60).toFixed(1)} min`).join(', ')
        return `request ${String(n).padStart(2)}: ${offered}`
      })
      .join('\n')
    await this.info.attach('route answers', { body: text, contentType: 'text/plain' })
  }

  /**
   * Taps Start drive and drives the trip on the fake clock, one simulated
   * second at a time, the way a driver who follows the app would: on the
   * recommended route, and onto the new one whenever the app announces a switch.
   */
  async drive(options: DriveOptions = {}): Promise<DriveLog> {
    const { page } = this
    const { speedMps = 25, maxSec = 2400, wrongTurnAtSec, snapAtSec = [], gpsNoiseM = 0 } = options
    const now = await page.evaluate(() => Date.now())
    await page.clock.pauseAt(now + 1000)
    const before = this.directionsRequests
    await page.getByRole('button', { name: 'Start drive' }).click()
    await this.settle()

    let route: readonly LngLat[] | null = null
    let alongM = 0
    let world: World | undefined
    let astray: { at: LngLat; headingDeg: number; sec: number } | null = null
    let position: LngLat = UPTOWN
    let heading = 180
    let speed = 0
    const log: DriveLog = { banners: [], arrived: false, seconds: 0 }
    let lastBanner = ''

    for (let sec = 0; sec < maxSec; sec += STEP_SEC) {
      // The first route of the drive: the car sets off on what the app recommended.
      if (route === null && this.directionsRequests > before) {
        world = [...this.worlds.values()].at(-1)
        const first = world?.lastOffered[0]
        if (first !== undefined) {
          route = first.corners
          alongM = 0
        }
      }
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
      if (state.banner !== '' && state.banner !== lastBanner) {
        log.banners.push({ atSec: sec, text: state.banner })
        await this.snap(`minute ${Math.floor(sec / 60)}: ${state.banner}`)
        // The driver follows the app onto the route it switched to.
        const next = world?.lastOffered[0]
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
  async settle(): Promise<{ banner: string; arrived: boolean }> {
    let quiet = 0
    for (let i = 0; i < 4000; i++) {
      const look = await this.page.evaluate(() => ({
        inflight: (window as unknown as E2EWindow).__e2e.inflight,
        banner: document.querySelector('.live-banner')?.textContent ?? '',
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
    const { mapboxStatus, traffic = FREE_FLOW, overpass } = this.outside

    if (url.hostname === 'api.mapbox.com') {
      if (mapboxStatus !== undefined) return route.fulfill({ status: mapboxStatus, json: { message: 'Not Authorized - Invalid Token' } })
      if (url.pathname.startsWith('/styles/v1/')) return route.fulfill({ json: BLANK_STYLE })
      if (url.pathname.startsWith('/directions/v5/mapbox/driving-traffic/')) {
        const coords = decodeURIComponent(url.pathname.split('/').at(-1)!).split(';')
        const [from, to] = coords.map((c) => c.split(',').map(Number) as LngLat)
        if (from === undefined || to === undefined) return route.fulfill({ status: 422, json: { code: 'InvalidInput' } })
        const key = to.join(',')
        let world = this.worlds.get(key)
        if (world === undefined) {
          world = new World(from, to)
          this.worlds.set(key, world)
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
