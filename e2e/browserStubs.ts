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
    fix: (lng: number, lat: number, headingDeg: number, speedMps: number) => void
    /** The position "Use my location" gets; null answers with a refusal. */
    here: [number, number] | null
  }
}

export function installBrowserStubs(): void {
  type Watcher = { ok: (p: GeolocationPosition) => void }
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
    here: [-80.8431, 35.2271],
    fix(lng, lat, headingDeg, speedMps) {
      for (const watcher of watchers.values()) watcher.ok(position(lng, lat, speedMps > 0.5 ? headingDeg : null, speedMps))
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
    watchPosition(ok: (p: GeolocationPosition) => void) {
      const id = nextId++
      watchers.set(id, { ok })
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
