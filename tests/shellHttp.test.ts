import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CHECK_ROUTES_CAP, createDriveDiagnostics, FIX_GAP_EVENT_MS, TICK_GAP_EVENT_MS, type RequestOutcome } from '../src/device/native/diagnostics.ts'
import { NATIVE_HTTP_GRACE_MS, NATIVE_HTTP_TIMEOUT_MS, nativeTransport } from '../src/device/native/http.ts'
import { nativeDeviceFor, startNativeShell } from '../src/device/native/index.ts'
import type { RouteIQNativePlugin } from '../src/device/native/plugin.ts'
import { buildDirectionsUrl, directionsRequestKind, fetchDirections, setDirectionsTransport } from '../src/providers/mapbox/client.ts'
import { SOUTHPARK, UPTOWN_CHARLOTTE } from '../src/core/index.ts'

const UPTOWN = UPTOWN_CHARLOTTE.position
const BALLANTYNE = SOUTHPARK.position

// Route requests inside the iPhone shell: the Directions client on the
// plugin's native httpGet (src/device/native/http.ts), against a stand-in for
// the Swift plugin, and the drive diagnostics that record what happened.

const OK = readFileSync(join(import.meta.dirname, 'fixtures', 'directions.ok.json'), 'utf8')
// Shaped like a token, and not one.
const TOKEN = 'pk.eyJ1Ijoibm90LWEtcmVhbC10b2tlbiJ9.c2lnbmF0dXJl'
const where = { origin: UPTOWN, destination: BALLANTYNE, token: TOKEN }

type Answer = { status?: number; body?: string; ms?: number }
type Listener = (data?: unknown) => void

/** A stand-in for the Swift plugin's request methods. Each httpGet waits to be answered by the test. */
function fakePlugin() {
  const gets: { id: string; url: string; timeoutMs: number; resolve: (a: Answer) => void; reject: (e: unknown) => void }[] = []
  const cancelled: string[] = []
  const listeners = new Map<string, Set<Listener>>()
  const spoken: ((finished: boolean) => void)[] = []
  const plugin = {
    httpGet(options: { id: string; url: string; timeoutMs: number }) {
      return new Promise<Answer>((resolve, reject) => gets.push({ ...options, resolve, reject }))
    },
    httpCancel({ id }: { id: string }) {
      cancelled.push(id)
      return Promise.resolve()
    },
    startLocation: () => Promise.resolve({}),
    stopLocation: () => Promise.resolve(),
    getCurrentPosition: () => new Promise(() => {}),
    speak: () => new Promise<{ finished?: boolean }>((resolve) => spoken.push((finished) => resolve({ finished }))),
    cancelSpeech: () => Promise.resolve(),
    keepAwake: () => Promise.resolve(),
    addListener(event: string, listener: Listener) {
      const set = listeners.get(event) ?? new Set()
      listeners.set(event, set)
      set.add(listener)
      return Promise.resolve({ remove: async () => void set.delete(listener) })
    },
  } as unknown as RouteIQNativePlugin
  const emit = (event: string, data?: unknown) => [...(listeners.get(event) ?? [])].forEach((l) => l(data))
  return { plugin, gets, cancelled, emit, spoken }
}

const noTimers = { setTimer: () => 0, clearTimer: () => {} }
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

describe('route requests through the native plugin', () => {
  it('sends the same URL as the browser would, to the plugin, and reads the routes from its answer', async () => {
    const { plugin, gets } = fakePlugin()
    const pending = fetchDirections({ ...where, fetchImpl: nativeTransport(plugin, noTimers) })
    await flush()
    expect(gets).toHaveLength(1)
    expect(gets[0]!.url).toBe(buildDirectionsUrl(UPTOWN, BALLANTYNE, TOKEN))
    expect(gets[0]!.timeoutMs).toBe(NATIVE_HTTP_TIMEOUT_MS)
    gets[0]!.resolve({ status: 200, body: OK, ms: 180 })
    const result = await pending
    expect(result.ok).toBe(true)
    expect(result.ok && result.routes.length).toBeGreaterThan(0)
  })

  it('HTTP errors read the same as with fetch: 401 and 403 are the token, 429 the rate limit, 500 says so', async () => {
    const ask = async (status: number, body: string) => {
      const { plugin, gets } = fakePlugin()
      const pending = fetchDirections({ ...where, fetchImpl: nativeTransport(plugin, noTimers) })
      await flush()
      gets[0]!.resolve({ status, body })
      const viaFetch = await fetchDirections({ ...where, fetchImpl: () => Promise.resolve(new Response(body, { status })) })
      const result = await pending
      expect(result).toEqual(viaFetch)
      return result
    }
    expect(await ask(401, '{"message":"Not Authorized - Invalid Token"}')).toMatchObject({ ok: false, kind: 'token' })
    expect(await ask(403, '{"message":"Forbidden"}')).toMatchObject({ ok: false, kind: 'token' })
    expect(await ask(429, '{"message":"Too Many Requests"}')).toMatchObject({ ok: false, kind: 'rate-limit' })
    expect(await ask(422, '{"code":"InvalidInput","message":"Coordinate is invalid"}')).toMatchObject({ ok: false, kind: 'api' })
    const down = await ask(500, 'Internal Server Error')
    expect(down).toMatchObject({ ok: false, kind: 'api' })
    expect(!down.ok && down.message).toContain('HTTP 500')
    expect(await ask(200, '<html>not json</html>')).toMatchObject({ ok: false })
  })

  it('no answer is a network error, whatever the native side says, and never shows the token', async () => {
    for (const failure of [{ code: 'network' }, { code: 'timeout' }, { code: 'not-allowed' }, new Error(`failed ${TOKEN}`), undefined]) {
      const { plugin, gets } = fakePlugin()
      const pending = fetchDirections({ ...where, fetchImpl: nativeTransport(plugin, noTimers) })
      await flush()
      gets[0]!.reject(failure)
      const result = await pending
      expect(result).toMatchObject({ ok: false, kind: 'network' })
      expect(JSON.stringify(result)).not.toContain(TOKEN)
    }
    // An answer with no status is no answer.
    const { plugin, gets } = fakePlugin()
    const pending = fetchDirections({ ...where, fetchImpl: nativeTransport(plugin, noTimers) })
    await flush()
    gets[0]!.resolve({})
    expect(await pending).toMatchObject({ ok: false, kind: 'network' })
  })

  it('an abort cancels the native request by its id and comes back as aborted, at once', async () => {
    const { plugin, gets, cancelled } = fakePlugin()
    const controller = new AbortController()
    const pending = fetchDirections({ ...where, signal: controller.signal, fetchImpl: nativeTransport(plugin, noTimers) })
    await flush()
    expect(cancelled).toEqual([])
    controller.abort()
    expect(await pending).toMatchObject({ ok: false, kind: 'aborted' })
    expect(cancelled).toEqual([gets[0]!.id])
    // The native side answering "cancelled" afterwards changes nothing, and is not cancelled twice.
    gets[0]!.reject({ code: 'cancelled' })
    await flush()
    expect(cancelled).toHaveLength(1)
  })

  it('a request that was aborted before it started never reaches the plugin', async () => {
    const { plugin, gets, cancelled } = fakePlugin()
    const controller = new AbortController()
    controller.abort()
    expect(await fetchDirections({ ...where, signal: controller.signal, fetchImpl: nativeTransport(plugin, noTimers) })).toMatchObject({ kind: 'aborted' })
    expect(gets).toEqual([])
    expect(cancelled).toEqual([])
  })

  it('every request has its own id, so cancelling one leaves the others alone', async () => {
    const { plugin, gets, cancelled } = fakePlugin()
    const transport = nativeTransport(plugin, noTimers)
    const first = new AbortController()
    const a = fetchDirections({ ...where, signal: first.signal, fetchImpl: transport })
    const b = fetchDirections({ ...where, fetchImpl: transport })
    await flush()
    expect(new Set(gets.map((g) => g.id)).size).toBe(2)
    first.abort()
    await a
    expect(cancelled).toEqual([gets[0]!.id])
    gets[1]!.resolve({ status: 200, body: OK })
    expect((await b).ok).toBe(true)
  })

  it('an address that is not Mapbox is refused before it reaches the plugin', async () => {
    const { plugin, gets } = fakePlugin()
    const transport = nativeTransport(plugin, noTimers)
    for (const url of [
      'https://example.com/directions/v5',
      'http://api.mapbox.com/directions/v5',
      'https://api.mapbox.com.example.com/x',
      'https://api.mapbox.com@example.com/x',
      'https://API.MAPBOX.COM/x',
      'capacitor://localhost/seed/osm-signals/index.json',
      '/seed/osm-signals/index.json',
    ]) {
      await expect(transport(url)).rejects.toThrow('Only requests to Mapbox')
    }
    expect(gets).toEqual([])
  })

  it('a native side that never answers is given up on after its time limit and a little more', async () => {
    const { plugin, gets, cancelled } = fakePlugin()
    const timers: { fn: () => void; ms: number }[] = []
    const transport = nativeTransport(plugin, { setTimer: (fn, ms) => timers.push({ fn, ms }), clearTimer: () => {} })
    const pending = fetchDirections({ ...where, fetchImpl: transport })
    await flush()
    expect(timers.map((t) => t.ms)).toEqual([NATIVE_HTTP_TIMEOUT_MS + NATIVE_HTTP_GRACE_MS])
    timers[0]!.fn()
    expect(await pending).toMatchObject({ ok: false, kind: 'network' })
    expect(cancelled).toEqual([gets[0]!.id])
  })
})

describe('the shell at startup', () => {
  afterEach(() => {
    delete (globalThis as { RouteIQNative?: unknown }).RouteIQNative
    setDirectionsTransport(null)
  })

  it('in a browser there is no native transport: requests stay on fetch', () => {
    expect(startNativeShell()).toBeNull()
  })

  it('in the shell the Directions client is put on the plugin, and app state changes are recorded', async () => {
    const { plugin, gets, emit } = fakePlugin()
    ;(globalThis as { RouteIQNative?: unknown }).RouteIQNative = plugin
    const log = createDriveDiagnostics(() => 0)
    setDirectionsTransport(startNativeShell(log))
    const pending = fetchDirections(where)
    await flush()
    expect(gets).toHaveLength(1)
    emit('appState', { state: 'background' })
    gets[0]!.resolve({ status: 200, body: OK, ms: 90 })
    expect((await pending).ok).toBe(true)
    const text = log.text()
    expect(text).toContain('requests: 1 sent (0 while not active), 1 answered')
    expect(text).toContain('app background')
    expect(text).toContain('request 1 answered, HTTP 200, 0 ms, native 90 ms [background]')
  })
})

describe('drive diagnostics', () => {
  /** Nothing that could be a coordinate, a token or an address: every number in the text is a whole one. */
  const expectHarmless = (text: string) => {
    expect(text).not.toMatch(/\d\.\d/)
    expect(text).not.toMatch(/[ps]k\./)
    expect(text).not.toMatch(/https?:|access_token|mapbox\.com/i)
    expect(text).not.toMatch(/-\d/)
  }

  it('counts fixes, ticks, requests and spoken lines, and tells apart what happened in the background', () => {
    let now = Date.UTC(2026, 10, 11, 12, 0, 0)
    const log = createDriveDiagnostics(() => now)
    log.gps(true)
    for (let i = 0; i < 30; i++) {
      now += 1000
      log.fix()
      log.tick()
    }
    log.appState('inactive')
    log.appState('background')
    for (let i = 0; i < 60; i++) {
      now += 1000
      log.fix()
      log.tick()
    }
    const n = log.requestSent()
    now += 420
    log.requestEnded(n, 'answered', 200, 400)
    const failed = log.requestSent()
    now += 20_000
    log.requestEnded(failed, 'timeout')
    log.speechStarted()
    log.speechEnded(true)
    log.speechStarted()
    log.speechEnded(false)
    log.appState('active')
    log.gps(false)

    const text = log.text()
    expect(text).toContain('fixes: 90 (60 while not active), longest gap 1 s')
    expect(text).toContain('ticks: 90 (60 while not active), longest gap 1 s')
    expect(text).toContain('requests: 2 sent (2 while not active), 1 answered, 1 failed, 0 cancelled, 0 waiting')
    expect(text).toContain('request time: average 420 ms, longest 420 ms')
    expect(text).toContain('speech: 2 lines started, 1 finished, 1 cut off or failed')
    expect(text).toMatch(/request 1 answered, HTTP 200, 420 ms, native 400 ms \[background\]/)
    expect(text).toMatch(/request 2 timeout after 20000 ms \[background\]/)
    expect(text).toMatch(/\d\d:\d\d:\d\d app background/)
    expectHarmless(text)
  })

  it('records the longest wait between ticks, and logs a long one: that is JavaScript not being run', () => {
    let now = 0
    const log = createDriveDiagnostics(() => now)
    log.gps(true)
    log.tick()
    log.fix()
    log.appState('background')
    now += TICK_GAP_EVENT_MS - 1
    log.tick()
    expect(log.text()).not.toContain('no tick for')
    now += 42_000
    log.tick()
    log.fix()
    const text = log.text()
    expect(text).toContain('longest gap 42 s')
    expect(text).toContain('no tick for 42 s [background]')
    expect(text).toContain(`no fix for ${Math.round((42_000 + TICK_GAP_EVENT_MS - 1) / 1000)} s [background]`)
    expect(FIX_GAP_EVENT_MS).toBeGreaterThan(TICK_GAP_EVENT_MS)
    // The time between two drives is not a gap.
    log.gps(false)
    now += 3_600_000
    log.gps(true)
    log.tick()
    expect(log.text()).toContain('ticks: 4 (3 while not active), longest gap 42 s')
  })

  it('keeps only the newest events and says how many were dropped', () => {
    let now = 0
    const log = createDriveDiagnostics(() => now, 10)
    for (let i = 0; i < 25; i++) {
      now += 1000
      log.requestEnded(log.requestSent(), 'answered', 200)
    }
    const text = log.text()
    expect(text).toContain('40 earlier ones dropped')
    expect(text.split('\n').filter((line) => /^\d\d:\d\d:\d\d /.test(line))).toHaveLength(10)
    expect(text).toContain('request 25 answered')
    expect(text).not.toContain('request 1 sent')
  })

  it('never holds a position or a token, whatever it is handed', () => {
    let now = 1_700_000_000_000
    const log = createDriveDiagnostics(() => now)
    const secret = 'pk.eyJ1Ijoibm90LWEtcmVhbC10b2tlbiJ9.c2lnbmF0dXJl'
    const url = `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/-80.843127,35.227085;-80.848,35.05?access_token=${secret}`
    // What a careless caller could pass: none of it may come out again.
    log.appState(url)
    log.appState({ lng: -80.843127, lat: 35.227085 })
    log.appState(secret)
    log.gps(true)
    log.fix()
    log.tick()
    const n = log.requestSent()
    now += 311.7
    log.requestEnded(n, 'answered', 35.227085, -80.843127)
    const m = log.requestSent()
    log.requestEnded(m, url as unknown as RequestOutcome, -80.843127, 35.227085)
    log.requestEnded(-80.843127, 'answered', 200, 1)
    log.requestEnded(log.requestSent(), 'answered', Number.NaN, Number.POSITIVE_INFINITY)
    const text = log.text()
    expectHarmless(text)
    expect(text).not.toContain('80')
    expect(text).not.toContain('227085')
    expect(text).toContain('app unknown')
    // Only whole numbers, times of day and words from fixed lists.
    for (const line of text.split('\n')) expect(line).toMatch(/^[A-Za-z0-9 :,()[\]-]*$/)
  })

  it('the shell device reports fixes, ticks and spoken lines to it as counts, with nothing of the fix or the line', async () => {
    const { plugin, emit, spoken } = fakePlugin()
    const now = 1_000_000
    const log = createDriveDiagnostics(() => now)
    const device = nativeDeviceFor(plugin, log)
    const fixes: unknown[] = []
    const stop = device.source.start(
      (fix) => fixes.push(fix),
      () => {},
    )
    let ticks = 0
    const stopTicks = device.every(1000, () => ticks++)
    emit('fix', { lng: -80.843127, lat: 35.227085, accuracy: 4.7, speed: 13.4, course: 187.3, timestamp: 1 })
    emit('fix', { lng: -80.843227, lat: 35.226985, accuracy: 4.7 })
    expect(fixes).toHaveLength(2)
    device.speaker.say({ text: 'In 400 feet, turn left onto South Tryon Street.', priority: 'turn', distanceToManeuverM: 120 })
    await flush()
    spoken[0]?.(true)
    await flush()
    stop()
    stop()
    stopTicks()
    const text = log.text()
    expect(text).toContain('fixes: 2 (0 while not active)')
    expect(text).toContain('speech: 1 lines started, 1 finished')
    expect(text).toContain('gps on')
    expect(text).toContain('gps off')
    expect(text).not.toContain('Tryon')
    expectHarmless(text)
    expect(ticks).toBe(0)
  })
})

describe('side-street probes in the drive diagnostics (#5 review)', () => {
  it('the kind of a request is read off its URL: a probe, a path check, or anything else', () => {
    const o: [number, number] = [-80.8431, 35.2271]
    const d: [number, number] = [-80.8561, 35.0015]
    const probe = buildDirectionsUrl(o, d, 'pk.test', { originHeadingDeg: 90, via: [{ point: [-80.85, 35.1], radiusM: 250 }] })!
    const path = buildDirectionsUrl(o, d, 'pk.test', { via: [{ point: [-80.85, 35.1], bearingDeg: 180 }, { point: [-80.85, 35.05] }] })!
    const onePath = buildDirectionsUrl(o, d, 'pk.test', { via: [{ point: [-80.85, 35.1], bearingDeg: 180 }] })!
    expect(directionsRequestKind(probe)).toBe('probe')
    expect(directionsRequestKind(path)).toBe('path')
    expect(directionsRequestKind(onePath)).toBe('path')
    expect(directionsRequestKind(buildDirectionsUrl(o, d, 'pk.test')!)).toBe('routes')
    expect(directionsRequestKind('not a url')).toBe('routes')
  })

  it('probes and path checks are marked in the log and counted, and nothing of the URL is kept', async () => {
    const log = createDriveDiagnostics(() => 1_000_000)
    const { plugin, gets } = fakePlugin()
    const transport = nativeTransport(plugin, { log, ...noTimers })
    const o: [number, number] = [-80.8431, 35.2271]
    const d: [number, number] = [-80.8561, 35.0015]
    void transport(buildDirectionsUrl(o, d, 'pk.test', { originHeadingDeg: 90, via: [{ point: [-80.85, 35.1], radiusM: 250 }] })!).catch(() => {})
    void transport(buildDirectionsUrl(o, d, 'pk.test', { via: [{ point: [-80.85, 35.1], bearingDeg: 180 }] })!).catch(() => {})
    void transport(buildDirectionsUrl(o, d, 'pk.test')!).catch(() => {})
    expect(gets).toHaveLength(3)
    const text = log.text()
    expect(text).toMatch(/request 1 \(probe\) sent/)
    expect(text).toMatch(/request 2 \(path check\) sent/)
    expect(text).toMatch(/request 3 sent/)
    expect(text).toContain('of those: 1 side-street probes (no road or no route is a normal answer for one), 1 path checks')
    expect(text).not.toContain('pk.test')
    expect(text).not.toContain('35.1')
  })
})

describe('what each drive check concluded, in the diagnostics (so "was there a faster way?" can be answered, #175)', () => {
  it('tallies the outcomes, most first, and keeps the largest saving any check saw', () => {
    let now = Date.UTC(2026, 10, 12, 11, 42, 0)
    const log = createDriveDiagnostics(() => now)
    log.checked('confirming', 2, 150)
    for (const s of [45, 95]) {
      now += 60_000
      log.checked('saving-too-small', 3, s)
    }
    for (let i = 0; i < 40; i++) {
      now += 60_000
      log.checked('current-best', 3, -30)
    }
    const text = log.text()
    expect(text).toContain('checks: 43: yours was the fastest 40, another was faster, by less than the minimum saving 2, a faster one, waiting for the next check to confirm it 1')
    expect(text).toContain('best saving another route offered: 150 s')
  })

  it('notes a check in the events only when its outcome changes, so a long drive keeps its other events', () => {
    const log = createDriveDiagnostics(() => 0)
    for (let i = 0; i < 30; i++) log.checked('current-best', 3, -12)
    log.checked('saving-too-small', 14, 61.4)
    log.checked('poll-failed', null, null)
    const checkEvents = log.text().split('\n').filter((l) => l.includes(' check: '))
    expect(checkEvents).toHaveLength(3)
    expect(checkEvents[0]).toContain('check: yours was the fastest (3 routes)')
    expect(checkEvents[1]).toContain(`another was faster, by less than the minimum saving (${CHECK_ROUTES_CAP} routes, the best other saves 61 s)`)
    expect(checkEvents[2]).toContain('check: the check failed (no answer)')
  })

  it('keeps an unknown outcome as "other", a slower alternative as 0, and nothing that could be a place', () => {
    const log = createDriveDiagnostics(() => 0)
    log.checked('<script>', 3, null)
    log.checked({ code: 'current-best' }, 99, -35.2)
    const text = log.text()
    expect(text).toContain('checks: 2: other 2')
    expect(text).toContain('best saving another route offered: 0 s')
    expect(text).not.toMatch(/\d\.\d|-\d|script/)
  })

  it('says unknown when no check could compare, and shows no check lines before the first check', () => {
    const log = createDriveDiagnostics(() => 0)
    expect(log.text()).not.toContain('checks:')
    log.checked('route-unconfirmed', 2, null)
    log.checked('poll-failed', null, null)
    expect(log.text()).toContain('best saving another route offered: unknown')
  })
})
