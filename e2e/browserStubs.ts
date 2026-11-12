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
  __shell: { calls: string[] }
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
 *   and a hidden page is reported as the plugin's 'appState' event.
 *
 * Self-contained, like installBrowserStubs.
 */
export function installShellStubs(): void {
  const w = window as unknown as E2EWindow & ShellWindow & Window & { RouteIQNative: unknown }
  const calls: string[] = []
  w.__shell = { calls }
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

  w.__e2e.fix = (lng, lat, headingDeg, speedMps) =>
    emit('fix', { lng, lat, accuracy: 5, speed: speedMps, course: speedMps > 0.5 ? headingDeg : -1, timestamp: Date.now() })
  const geolocation = navigator.geolocation as unknown as { watchPosition: () => number; getCurrentPosition: () => void }
  geolocation.watchPosition = () => {
    calls.push('BROWSER watchPosition')
    return 0
  }
  geolocation.getCurrentPosition = () => {
    calls.push('BROWSER getCurrentPosition')
  }
}
