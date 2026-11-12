// Runs inside the page, before the app's own scripts (page.addInitScript).
// Stands in for the three browser features a test cannot use for real:
//
// - GPS: navigator.geolocation answers from window.__e2e.fix(...), which the
//   test calls once per simulated second. Nothing reads the PC's location.
// - Voice: speechSynthesis writes every line it is asked to say into
//   window.__e2e.spoken, in order, and "finishes" each line 1.5 s later on the
//   page's (fake) clock.
// - Network bookkeeping: fetch counts requests in flight, so the test can wait
//   until the app has its answers before moving the clock on. Where requests
//   go is decided by the test's router, not here.
//
// It must be self-contained: Playwright serializes this function into the page.

export interface E2EWindow {
  __e2e: {
    spoken: { atMs: number; text: string }[]
    inflight: number
    /** Every URL the page handed to fetch, in order, including calls cancelled before they left. */
    fetched: string[]
    fix: (lng: number, lat: number, headingDeg: number, speedMps: number) => void
    /** Location permission is taken away: every position watch gets a "denied" error. */
    deny: () => void
    /** The position "Use my location" gets; null answers with a refusal. */
    here: [number, number] | null
  }
}

export function installBrowserStubs(): void {
  type Watcher = { ok: (p: GeolocationPosition) => void; fail?: (e: GeolocationPositionError) => void }
  const w = window as unknown as E2EWindow & Window
  const watchers = new Map<number, Watcher>()
  let nextId = 1
  const position = (lng: number, lat: number, headingDeg: number | null, speedMps: number | null) =>
    ({
      coords: { longitude: lng, latitude: lat, accuracy: 5, altitude: null, altitudeAccuracy: null, heading: headingDeg, speed: speedMps },
      timestamp: Date.now(),
    }) as unknown as GeolocationPosition

  w.__e2e = {
    spoken: [],
    inflight: 0,
    fetched: [],
    here: [-80.8431, 35.2271],
    fix(lng, lat, headingDeg, speedMps) {
      for (const watcher of watchers.values()) watcher.ok(position(lng, lat, speedMps > 0.5 ? headingDeg : null, speedMps))
    },
    deny() {
      for (const watcher of watchers.values()) watcher.fail?.({ code: 1, PERMISSION_DENIED: 1, message: 'denied' } as GeolocationPositionError)
    },
  }

  const geolocation = {
    getCurrentPosition(ok: (p: GeolocationPosition) => void, fail?: (e: GeolocationPositionError) => void) {
      const here = w.__e2e.here
      setTimeout(() => {
        if (here === null) fail?.({ code: 1, message: 'denied' } as GeolocationPositionError)
        else ok(position(here[0], here[1], null, null))
      }, 0)
    },
    watchPosition(ok: (p: GeolocationPosition) => void, fail?: (e: GeolocationPositionError) => void) {
      const id = nextId++
      watchers.set(id, { ok, fail })
      return id
    },
    clearWatch(id: number) {
      watchers.delete(id)
    },
  }
  Object.defineProperty(navigator, 'geolocation', { value: geolocation, configurable: true })

  class FakeUtterance {
    text: string
    lang = ''
    rate = 1
    volume = 1
    onend: (() => void) | null = null
    onerror: (() => void) | null = null
    constructor(text: string) {
      this.text = text
    }
  }
  let current: FakeUtterance | null = null
  const synth = {
    speaking: false,
    pending: false,
    paused: false,
    speak(u: FakeUtterance) {
      // A silent "unlock" line (volume 0) is not something the driver hears.
      if (u.volume > 0 && u.text.trim() !== '') w.__e2e.spoken.push({ atMs: Date.now(), text: u.text })
      current = u
      setTimeout(() => {
        if (current !== u) return
        current = null
        u.onend?.()
      }, 1500)
    },
    cancel() {
      current = null
    },
    pause() {},
    resume() {},
    getVoices: () => [],
    addEventListener() {},
    removeEventListener() {},
  }
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true })
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: FakeUtterance, configurable: true })

  const realFetch = window.fetch.bind(window)
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    w.__e2e.inflight++
    const [input] = args
    w.__e2e.fetched.push(input instanceof Request ? input.url : String(input))
    try {
      const response = await realFetch(...args)
      // Read the body here, so "no request in flight" also means "every answer is in".
      const body = await response.arrayBuffer()
      return new Response(response.status === 204 ? null : body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    } finally {
      w.__e2e.inflight--
    }
  }
}

/** What the stand-in for the iPhone shell's plugin was asked to do, in order. */
export interface ShellWindow {
  __shell: {
    calls: string[]
    /** Every text handed to the share sheet. */
    shared: string[]
  }
}

/**
 * Makes the page believe it runs inside the iPhone shell (native/shell): a
 * stand-in for the Swift plugin on window.RouteIQNative, the way the shell's
 * bridge script puts it there. Runs after installBrowserStubs, and takes
 * over its fake GPS and voice:
 *
 * - window.__e2e.fix(...) now arrives as the plugin's 'fix' event, and the
 *   browser's own watchPosition only records that it was (wrongly) used;
 * - the plugin's speak() writes into window.__e2e.spoken and resolves 1.5 s
 *   later on the page's clock, as the native voice does when a line ends;
 * - the plugin's httpGet() (native networking on a phone) is the page's fetch,
 *   and a hidden page is reported as the plugin's 'appState' event;
 * - the plugin's startSimulatedRoute() (the "Test drive") moves a made-up car
 *   along the points it is given on the page's clock, one 'fix' a second
 *   marked `simulated`, the way RouteIQSimulation.swift does on a phone, and
 *   share() records the text instead of opening a share sheet.
 *
 * Self-contained, like installBrowserStubs.
 */
export function installShellStubs(): void {
  const w = window as unknown as E2EWindow & ShellWindow & Window & { RouteIQNative: unknown }
  const calls: string[] = []
  const shared: string[] = []
  w.__shell = { calls, shared }
  // The made-up car of a test drive: where it is on its points, and the script still ahead.
  type Step = { atM: number; speedMps?: number; stopSec?: number }
  let car: { points: number[][]; along: number[]; steps: Step[]; speed: number; at: number; stop: number; last: number | null } | null = null
  let carTimer: ReturnType<typeof setInterval> | null = null
  const rad = (d: number) => (d * Math.PI) / 180
  const metersBetween = (a: number[], b: number[]) => {
    const h = Math.sin(rad(b[1]! - a[1]!) / 2) ** 2 + Math.cos(rad(a[1]!)) * Math.cos(rad(b[1]!)) * Math.sin(rad(b[0]! - a[0]!) / 2) ** 2
    return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(h)))
  }
  const moveCar = () => {
    if (car === null) return
    const now = Date.now()
    const dt = car.last === null ? 0 : Math.min(3, Math.max(0, (now - car.last) / 1000))
    car.last = now
    const length = car.along.at(-1)!
    const before = car.at
    let left = dt
    for (;;) {
      while (car.steps.length > 0 && car.steps[0]!.atM <= car.at + 0.001) {
        const step = car.steps.shift()!
        if (step.speedMps !== undefined) car.speed = step.speedMps
        if (step.stopSec !== undefined) car.stop += step.stopSec
      }
      if (left <= 0) break
      if (car.stop > 0) {
        const used = Math.min(car.stop, left)
        car.stop -= used
        left -= used
        continue
      }
      if (car.speed <= 0 || car.at >= length) break
      const limit = car.steps.length > 0 ? Math.min(length, car.steps[0]!.atM) : length
      const room = limit - car.at
      if (car.speed * left < room) {
        car.at += car.speed * left
        left = 0
      } else {
        car.at = limit
        left -= room / car.speed
      }
    }
    let i = 0
    while (i < car.points.length - 2 && car.along[i + 1]! < car.at) i++
    const a = car.points[i]!
    const b = car.points[i + 1] ?? a
    const span = (car.along[i + 1] ?? car.along[i]!) - car.along[i]!
    const t = span > 0 ? Math.min(1, Math.max(0, (car.at - car.along[i]!) / span)) : 0
    const y = Math.sin(rad(b[0]! - a[0]!)) * Math.cos(rad(b[1]!))
    const x = Math.cos(rad(a[1]!)) * Math.sin(rad(b[1]!)) - Math.sin(rad(a[1]!)) * Math.cos(rad(b[1]!)) * Math.cos(rad(b[0]! - a[0]!))
    const speed = dt > 0 ? (car.at - before) / dt : 0
    emit('fix', {
      lng: a[0]! + (b[0]! - a[0]!) * t,
      lat: a[1]! + (b[1]! - a[1]!) * t,
      accuracy: 5,
      speed,
      ...(speed > 0.5 && span > 0 ? { course: ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360 } : {}),
      timestamp: now,
      simulated: true,
    })
  }
  const listeners = new Map<string, Set<(data?: unknown) => void>>()
  const emit = (event: string, data?: unknown) => [...(listeners.get(event) ?? [])].forEach((l) => l(data))
  let line = 0
  const requests = new Map<string, AbortController>()
  // In the shell a route request must go through the plugin: one made by the page itself is recorded as wrong.
  const pageFetch = window.fetch.bind(window)
  window.fetch = (...args: Parameters<typeof fetch>) => {
    const [input] = args
    if ((input instanceof Request ? input.url : String(input)).includes('/directions/v5/')) calls.push('BROWSER fetch of a route')
    return pageFetch(...args)
  }
  // Locking the phone: the native side says the app went to the background.
  document.addEventListener('visibilitychange', () => emit('appState', { state: document.visibilityState === 'hidden' ? 'background' : 'active' }))

  w.RouteIQNative = {
    async startLocation() {
      calls.push('startLocation')
      return { authorization: 'when-in-use' }
    },
    async stopLocation() {
      calls.push('stopLocation')
      // As on the phone: ending the location stream ends a test drive too.
      if (carTimer !== null) clearInterval(carTimer)
      carTimer = null
      car = null
    },
    async startSimulatedRoute({ points, speedMps, script }: { points: number[][]; speedMps: number; script: Step[] }) {
      calls.push('startSimulatedRoute')
      if (points.length === 0) throw Object.assign(new Error('invalid'), { code: 'invalid' })
      const along = [0]
      for (let i = 1; i < points.length; i++) along.push(along[i - 1]! + metersBetween(points[i - 1]!, points[i]!))
      // A route that replaces another carries on in the same rhythm; the first one reports at once.
      const running = car !== null && carTimer !== null
      car = { points, along, steps: [...script].sort((p, q) => p.atM - q.atM), speed: speedMps, at: 0, stop: 0, last: running ? car!.last : null }
      if (running) return
      if (carTimer !== null) clearInterval(carTimer)
      carTimer = setInterval(moveCar, 1000)
      moveCar()
    },
    async stopSimulatedRoute() {
      calls.push('stopSimulatedRoute')
      if (carTimer !== null) clearInterval(carTimer)
      carTimer = null
      car = null
    },
    async share({ text }: { text: string }) {
      calls.push('share')
      shared.push(text)
      return { completed: true }
    },
    async getCurrentPosition() {
      calls.push('getCurrentPosition')
      const here = w.__e2e.here
      if (here === null) throw Object.assign(new Error('denied'), { code: 'denied' })
      return { lng: here[0], lat: here[1], accuracy: 5 }
    },
    speak({ text }: { text: string }) {
      calls.push('speak')
      w.__e2e.spoken.push({ atMs: Date.now(), text })
      const mine = ++line
      return new Promise((resolve) => setTimeout(() => resolve({ finished: mine === line }), 1500))
    },
    async cancelSpeech() {
      calls.push('cancelSpeech')
      line++
    },
    async keepAwake({ on }: { on: boolean }) {
      calls.push(`keepAwake:${on}`)
    },
    // The plugin's native GET: here the page's fetch, so the made-up world answers it and it is counted as usual.
    async httpGet({ id, url }: { id: string; url: string }) {
      calls.push('httpGet')
      if (!url.startsWith('https://api.mapbox.com/')) throw Object.assign(new Error('not allowed'), { code: 'not-allowed' })
      const controller = new AbortController()
      requests.set(id, controller)
      const startedAt = Date.now()
      try {
        const response = await pageFetch(url, { signal: controller.signal })
        return { status: response.status, body: await response.text(), ms: Date.now() - startedAt }
      } catch {
        throw Object.assign(new Error('failed'), { code: controller.signal.aborted ? 'cancelled' : 'network' })
      } finally {
        requests.delete(id)
      }
    },
    async httpCancel({ id }: { id: string }) {
      calls.push('httpCancel')
      requests.get(id)?.abort()
    },
    addListener(event: string, listener: (data?: unknown) => void) {
      const set = listeners.get(event) ?? new Set()
      listeners.set(event, set)
      set.add(listener)
      return Promise.resolve({ remove: async () => void set.delete(listener) })
    },
  }

  // The phone's own GPS. During a test drive the native side discards it, so it is not sent on here either.
  w.__e2e.fix = (lng, lat, headingDeg, speedMps) => {
    if (car === null) emit('fix', { lng, lat, accuracy: 5, speed: speedMps, course: speedMps > 0.5 ? headingDeg : -1, timestamp: Date.now() })
  }
  const geolocation = navigator.geolocation as unknown as { watchPosition: () => number; getCurrentPosition: () => void }
  geolocation.watchPosition = () => {
    calls.push('BROWSER watchPosition')
    return 0
  }
  geolocation.getCurrentPosition = () => {
    calls.push('BROWSER getCurrentPosition')
  }
}
