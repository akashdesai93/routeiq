import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_LIVE_OPTIONS, type LiveState, type PositionFix, type RouteCandidate } from '../src/core/index.ts'
import { checkToken, tokenErrorHelp } from '../src/config.ts'
import { sessionNow } from '../src/device/clock.ts'
import { currentPosition, type LocationErrorKind } from '../src/device/geolocation.ts'
import { pageVisibility, type PageVisibility } from '../src/device/visibility.ts'
import { nativeDeviceFor } from '../src/device/native/index.ts'
import { isNativeShell, nativePlugin, type NativeFix, type RouteIQNativePlugin } from '../src/device/native/plugin.ts'
import { nativeGeolocation, nativePositionSource } from '../src/device/native/position.ts'
import { nativeEvery, PULSE_SLACK_MS } from '../src/device/native/pulse.ts'
import { createNativeSpeaker } from '../src/device/native/speech.ts'
import { ALWAYS_IN_FRONT } from '../src/device/native/visibility.ts'
import { nativeWakeLock } from '../src/device/native/wakeLock.ts'
import { createLiveRunner, LIVE_TICK_MS } from '../src/live/runner.ts'
import { readShellToken, saveShellToken, SHELL_TOKEN_KEY, SHELL_TOKEN_PROBLEM } from '../src/shellToken.ts'
import { memoryTextStore } from '../src/storage/local.ts'

// The iPhone shell's side of the device seams (src/device/native), against a
// stand-in for the Swift plugin, and the shell's token on the device.

vi.mock('mapbox-gl/esm', () => ({}))
vi.mock('mapbox-gl/dist/mapbox-gl.css', () => ({}))
const { Root, ShellApp, ShellTokenScreen } = await import('../src/ShellRoot.tsx')

type Listener = (data?: unknown) => void

/** A stand-in for the Swift plugin: records calls, and sends events when told to. */
function fakePlugin(options: { startFails?: string; position?: NativeFix | { code: string } } = {}) {
  const listeners = new Map<string, Set<Listener>>()
  const calls: string[] = []
  const speaking: { text: string; end: (finished: boolean) => void; fail: () => void }[] = []
  const plugin: RouteIQNativePlugin = {
    startLocation() {
      calls.push('startLocation')
      return options.startFails === undefined ? Promise.resolve({ authorization: 'when-in-use' }) : Promise.reject({ code: options.startFails })
    },
    stopLocation() {
      calls.push('stopLocation')
      return Promise.resolve()
    },
    getCurrentPosition() {
      calls.push('getCurrentPosition')
      const p = options.position
      if (p === undefined) return new Promise(() => {})
      return 'code' in p ? Promise.reject(p) : Promise.resolve(p)
    },
    speak({ text }) {
      calls.push(`speak:${text}`)
      return new Promise((resolve, reject) => {
        speaking.push({ text, end: (finished) => resolve({ finished }), fail: () => reject(new Error('audio')) })
      })
    },
    cancelSpeech() {
      calls.push('cancelSpeech')
      return Promise.resolve()
    },
    keepAwake({ on }) {
      calls.push(`keepAwake:${on}`)
      return Promise.resolve()
    },
    // Route requests through the plugin have their own tests (shellHttp.test.ts).
    httpGet: () => Promise.reject({ code: 'network' }),
    httpCancel: () => Promise.resolve(),
    addListener: ((event: string, listener: Listener) => {
      const set = listeners.get(event) ?? new Set()
      listeners.set(event, set)
      set.add(listener)
      return Promise.resolve({
        remove: async () => {
          set.delete(listener)
        },
      })
    }) as RouteIQNativePlugin['addListener'],
  }
  const emit = (event: string, data?: unknown) => [...(listeners.get(event) ?? [])].forEach((l) => l(data))
  const listening = (event: string) => listeners.get(event)?.size ?? 0
  return { plugin, calls, speaking, emit, listening }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('finding the plugin', () => {
  afterEach(() => {
    delete (globalThis as { RouteIQNative?: unknown }).RouteIQNative
  })

  it('a browser has none; the shell puts it on the global object', () => {
    expect(nativePlugin()).toBeNull()
    expect(isNativeShell()).toBe(false)
    const { plugin } = fakePlugin()
    ;(globalThis as { RouteIQNative?: unknown }).RouteIQNative = plugin
    expect(nativePlugin()).toBe(plugin)
    expect(isNativeShell()).toBe(true)
  })

  it('something else under that name is not a plugin', () => {
    ;(globalThis as { RouteIQNative?: unknown }).RouteIQNative = { speak: 1 }
    expect(nativePlugin()).toBeNull()
  })
})

describe('native position source', () => {
  it('starts the native stream and hands each fix over, stamped with its own clock', async () => {
    const { plugin, calls, emit } = fakePlugin()
    const fixes: PositionFix[] = []
    const errors: LocationErrorKind[] = []
    const stop = nativePositionSource(plugin, () => 5000).start(
      (f) => fixes.push(f),
      (k) => errors.push(k),
    )
    expect(calls).toEqual(['startLocation'])
    emit('fix', { lng: -80.84, lat: 35.22, accuracy: 6, speed: 13.4, course: 181, timestamp: 1 })
    // Standing still: the phone knows no course, and says so by leaving it out (or sending -1).
    emit('fix', { lng: -80.84, lat: 35.22, accuracy: 6, speed: 0, course: -1 })
    emit('fix', { lng: -80.84, lat: 35.22 })
    expect(fixes).toEqual([
      { lng: -80.84, lat: 35.22, accuracyM: 6, speedMps: 13.4, headingDeg: 181, timeMs: 5000 },
      { lng: -80.84, lat: 35.22, accuracyM: 6, speedMps: 0, headingDeg: null, timeMs: 5000 },
      { lng: -80.84, lat: 35.22, accuracyM: NaN, speedMps: null, headingDeg: null, timeMs: 5000 },
    ])
    expect(errors).toEqual([])
    stop()
    await flush()
    expect(calls).toEqual(['startLocation', 'stopLocation'])
    emit('fix', { lng: -80.84, lat: 35.22 })
    expect(fixes).toHaveLength(3)
  })

  it('by default stamps fixes with the session clock, the one the drive runs on, which never steps back (#30)', () => {
    const { plugin, emit } = fakePlugin()
    let wall = 1_800_000_000_000
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => wall)
    try {
      const fixes: PositionFix[] = []
      const stop = nativePositionSource(plugin).start((f) => fixes.push(f), () => {})
      for (const step of [1000, 1000, -30_000, 1000]) {
        wall += step
        emit('fix', { lng: -80.84, lat: 35.22, accuracy: 6 })
      }
      stop()
      const times = fixes.map((f) => f.timeMs)
      for (let i = 1; i < times.length; i++) expect(times[i]!).toBeGreaterThan(times[i - 1]!)
      expect(times[1]! - times[0]!).toBe(1000)
      // The same clock as the drive's: a fix stamped now is not newer than the session's own time.
      expect(sessionNow()).toBeGreaterThanOrEqual(times.at(-1)!)
      expect(sessionNow() - times.at(-1)!).toBeLessThan(5)
    } finally {
      spy.mockRestore()
    }
  })

  it('a fix that is not a place on Earth is an error, not a position', () => {
    const { plugin, emit } = fakePlugin()
    const fixes: PositionFix[] = []
    const errors: LocationErrorKind[] = []
    nativePositionSource(plugin).start(
      (f) => fixes.push(f),
      (k) => errors.push(k),
    )
    emit('fix', { lng: 500, lat: 35 })
    emit('fix', undefined)
    expect(fixes).toEqual([])
    expect(errors).toEqual(['unavailable', 'unavailable'])
  })

  it('a refused permission is "denied"; any other failure is "unavailable", and the stream goes on', async () => {
    const refused = fakePlugin({ startFails: 'denied' })
    const errors: LocationErrorKind[] = []
    nativePositionSource(refused.plugin).start(
      () => {},
      (k) => errors.push(k),
    )
    await flush()
    expect(errors).toEqual(['denied'])

    const { plugin, emit } = fakePlugin()
    const later: LocationErrorKind[] = []
    const fixes: PositionFix[] = []
    nativePositionSource(plugin).start(
      (f) => fixes.push(f),
      (k) => later.push(k),
    )
    emit('locationError', { kind: 'unavailable' })
    emit('locationError', { kind: 'denied' })
    emit('locationError', { kind: 'something new' })
    emit('fix', { lng: -80.84, lat: 35.22 })
    expect(later).toEqual(['unavailable', 'denied', 'unavailable'])
    expect(fixes).toHaveLength(1)
  })

  it('"Use my location" asks the plugin once, and never starts a stream', async () => {
    const here = fakePlugin({ position: { lng: -80.8431, lat: 35.2271, accuracy: 12 } })
    expect(await currentPosition({ geolocation: nativeGeolocation(here.plugin), secureContext: true })).toEqual({
      ok: true,
      position: [-80.8431, 35.2271],
      accuracyM: 12,
    })
    expect(here.calls).toEqual(['getCurrentPosition'])

    const refused = fakePlugin({ position: { code: 'denied' } })
    expect(await currentPosition({ geolocation: nativeGeolocation(refused.plugin), secureContext: true })).toMatchObject({ ok: false, kind: 'denied' })
    const lost = fakePlugin({ position: { code: 'unavailable' } })
    expect(await currentPosition({ geolocation: nativeGeolocation(lost.plugin), secureContext: true })).toMatchObject({ ok: false, kind: 'unavailable' })
  })

  it('"Use my location" gives up after the time limit when the phone never answers', async () => {
    vi.useFakeTimers()
    try {
      const silent = fakePlugin()
      const result = currentPosition({ geolocation: nativeGeolocation(silent.plugin), secureContext: true, timeoutMs: 1000 })
      await vi.advanceTimersByTimeAsync(1000)
      expect(await result).toMatchObject({ ok: false, kind: 'timeout' })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('native ticks', () => {
  /** A clock and an interval the test moves by hand. */
  function handTimers() {
    let now = 0
    const intervals = new Set<() => void>()
    return {
      timers: {
        now: () => now,
        setInterval: (fn: () => void) => {
          intervals.add(fn)
          return fn
        },
        clearInterval: (id: unknown) => {
          intervals.delete(id as () => void)
        },
      },
      advance: (ms: number) => {
        now += ms
      },
      fireIntervals: () => [...intervals].forEach((fn) => fn()),
      intervals,
    }
  }

  it('with the page timers held back (phone locked), every fix still ticks the session', () => {
    const { plugin, emit } = fakePlugin()
    const hand = handTimers()
    let ticks = 0
    nativeEvery(plugin, hand.timers)(1000, () => ticks++)
    // Ten seconds of driving with no page timer firing at all: one fix a second.
    for (let s = 0; s < 10; s++) {
      hand.advance(1000)
      emit('fix', { lng: -80.84, lat: 35.22 })
    }
    expect(ticks).toBe(10)
  })

  it('with no fixes either (a tunnel), the native timer ticks it', () => {
    const { plugin, emit } = fakePlugin()
    const hand = handTimers()
    let ticks = 0
    nativeEvery(plugin, hand.timers)(1000, () => ticks++)
    for (let s = 0; s < 5; s++) {
      hand.advance(1000)
      emit('tick')
    }
    expect(ticks).toBe(5)
  })

  it('a fix, a native tick and the page timer in the same second make one tick, not three', () => {
    const { plugin, emit } = fakePlugin()
    const hand = handTimers()
    let ticks = 0
    nativeEvery(plugin, hand.timers)(1000, () => ticks++)
    for (let s = 0; s < 4; s++) {
      hand.advance(1000)
      emit('fix', { lng: -80.84, lat: 35.22 })
      hand.advance(20)
      emit('tick')
      hand.advance(20)
      hand.fireIntervals()
      hand.advance(-40)
    }
    expect(ticks).toBe(4)
  })

  it('a pulse a little early still counts; one far too early does not', () => {
    const { plugin, emit } = fakePlugin()
    const hand = handTimers()
    let ticks = 0
    nativeEvery(plugin, hand.timers)(1000, () => ticks++)
    hand.advance(1000 - PULSE_SLACK_MS)
    emit('fix', {})
    expect(ticks).toBe(1)
    hand.advance(400)
    emit('fix', {})
    expect(ticks).toBe(1)
  })

  it('in a browser-like foreground the page timer alone is enough, and stopping stops everything', async () => {
    const { plugin, emit, listening } = fakePlugin()
    const hand = handTimers()
    let ticks = 0
    const stop = nativeEvery(plugin, hand.timers)(1000, () => ticks++)
    hand.advance(1000)
    hand.fireIntervals()
    expect(ticks).toBe(1)
    expect(listening('fix')).toBe(1)
    expect(listening('tick')).toBe(1)
    stop()
    await flush()
    expect(hand.intervals.size).toBe(0)
    expect(listening('fix')).toBe(0)
    expect(listening('tick')).toBe(0)
    hand.advance(5000)
    emit('fix', {})
    expect(ticks).toBe(1)
  })
})

describe('native voice', () => {
  const noTimers = { setTimer: () => 0, clearTimer: () => {} }

  it('speaks through the plugin and says the waiting line when the plugin reports the end', async () => {
    const { plugin, speaking } = fakePlugin()
    const speaker = createNativeSpeaker(plugin, noTimers)
    expect(speaker.supported).toBe(true)
    speaker.say({ text: 'Turn left onto Cross Street.', priority: 'turn', distanceToManeuverM: 80 })
    speaker.say({ text: 'Switching to a faster route.', priority: 'urgent' })
    expect(speaking.map((s) => s.text)).toEqual(['Turn left onto Cross Street.'])
    speaking[0]!.end(true)
    await flush()
    expect(speaking.map((s) => s.text)).toEqual(['Turn left onto Cross Street.', 'Switching to a faster route.'])
  })

  it('an urgent line cuts off a far-away turn prompt: cancel, then speak', async () => {
    const { plugin, calls, speaking } = fakePlugin()
    const speaker = createNativeSpeaker(plugin, noTimers)
    speaker.say({ text: 'In 2 miles, turn left.', priority: 'turn', distanceToManeuverM: 3200 })
    speaker.say({ text: 'Switching to a faster route.', priority: 'urgent' })
    expect(calls).toEqual(['speak:In 2 miles, turn left.', 'cancelSpeech', 'speak:Switching to a faster route.'])
    // The cut-off line's late end does not move the queue on.
    speaking[0]!.end(false)
    await flush()
    speaker.say({ text: 'Turn right.', priority: 'turn', distanceToManeuverM: 50 })
    expect(speaking).toHaveLength(2)
  })

  it('a line the phone fails to speak does not block the next one', async () => {
    const { plugin, speaking } = fakePlugin()
    const speaker = createNativeSpeaker(plugin, noTimers)
    speaker.say({ text: 'One.', priority: 'urgent' })
    speaker.say({ text: 'Two.', priority: 'urgent' })
    speaking[0]!.fail()
    await flush()
    expect(speaking.map((s) => s.text)).toEqual(['One.', 'Two.'])
  })

  it('muted, it sends nothing to the phone (no silent "unlock" line either), and stop cancels', () => {
    const { plugin, calls } = fakePlugin()
    const speaker = createNativeSpeaker(plugin, noTimers)
    speaker.setMuted(true)
    speaker.prime('RouteIQ started')
    speaker.say({ text: 'Turn left.', priority: 'turn', distanceToManeuverM: 80 })
    expect(calls).toEqual(['cancelSpeech'])
    speaker.setMuted(false)
    speaker.prime('RouteIQ started')
    speaker.stop()
    expect(calls).toEqual(['cancelSpeech', 'speak:RouteIQ started', 'cancelSpeech'])
  })
})

describe('native screen lock and visibility', () => {
  it('keeps the screen awake through the plugin and never rejects', async () => {
    const { plugin, calls } = fakePlugin()
    const lock = nativeWakeLock(plugin)
    expect(await lock.acquire()).toBe('held')
    await lock.release()
    expect(calls).toEqual(['keepAwake:true', 'keepAwake:false'])
    const broken = nativeWakeLock({ ...plugin, keepAwake: () => Promise.reject(new Error('no')) })
    expect(await broken.acquire()).toBe('unavailable')
    await expect(broken.release()).resolves.toBeUndefined()
  })

  it('the shell never reports the page as hidden', () => {
    let listened = false
    const stop = ALWAYS_IN_FRONT.subscribe(() => {
      listened = true
    })
    expect(ALWAYS_IN_FRONT.isHidden()).toBe(false)
    stop()
    expect(listened).toBe(false)
  })
})

describe('a locked phone: the live runner on the native device', () => {
  const DESTINATION: [number, number] = [-80.8, 35.2271]
  const route: RouteCandidate = {
    id: 'r1',
    geometry: [
      [-80.8431, 35.2271],
      DESTINATION,
    ],
    durationSec: 300,
    typicalDurationSec: 300,
    distanceM: 3900,
    label: 'Test Road',
    steps: [],
  } as unknown as RouteCandidate

  /** Runs a minute and a half of driving with the page hidden and its timers dead; counts route checks. */
  async function lockedDrive(visibility: PageVisibility | 'native') {
    const { plugin, emit } = fakePlugin()
    const device = nativeDeviceFor(plugin)
    let now = 1_000_000
    let checks = 0
    let state: LiveState | null = null
    const runner = createLiveRunner({
      source: nativePositionSource(plugin, () => now),
      speaker: device.speaker,
      wakeLock: device.wakeLock,
      visibility: visibility === 'native' ? device.visibility : visibility,
      now: () => now,
      // The page's own interval never fires: only native events move the session.
      every: nativeEvery(plugin, { now: () => now, setInterval: () => 0, clearInterval: () => {} }),
      options: () => ({}),
      onChange: (next) => {
        state = next
      },
      routes: async () => {
        checks++
        return { routes: [route] }
      },
    })
    runner.start(DESTINATION, route)
    for (let s = 0; s < 3 * DEFAULT_LIVE_OPTIONS.pollIntervalSec; s++) {
      now += LIVE_TICK_MS
      emit('fix', { lng: -80.8431 + s * 0.00005, lat: 35.2271, accuracy: 5, speed: 5, course: 90 })
      await flush()
    }
    runner.dispose()
    return { checks, state: state as LiveState | null }
  }

  const hiddenDocument = { visibilityState: 'hidden', addEventListener: () => {}, removeEventListener: () => {} }

  it('keeps checking for a faster route while the page is hidden', async () => {
    const { checks } = await lockedDrive('native')
    expect(checks).toBeGreaterThanOrEqual(2)
  })

  it('and the browser rule is unchanged: a hidden page stops the checks', async () => {
    const { checks } = await lockedDrive(pageVisibility(hiddenDocument))
    expect(checks).toBe(0)
  })
})

describe('the shell token', () => {
  it('stores a public token and reads it back', () => {
    const store = memoryTextStore()
    expect(readShellToken(store)).toEqual({ kind: 'missing' })
    expect(saveShellToken(store, '  pk.abc123  ')).toEqual({ ok: true, token: 'pk.abc123' })
    expect(store.read(SHELL_TOKEN_KEY)).toBe('pk.abc123')
    expect(readShellToken(store)).toEqual({ kind: 'ok', token: 'pk.abc123' })
  })

  it('refuses a secret token and never stores it', () => {
    const store = memoryTextStore()
    expect(saveShellToken(store, 'sk.secret')).toEqual({ ok: false, kind: 'secret' })
    expect(store.read(SHELL_TOKEN_KEY)).toBeNull()
    expect(SHELL_TOKEN_PROBLEM.secret).toContain('not stored')
  })

  it('refuses anything else that is not pk., and keeps the token already stored', () => {
    const store = memoryTextStore({ [SHELL_TOKEN_KEY]: 'pk.old' })
    expect(saveShellToken(store, 'hello')).toEqual({ ok: false, kind: 'malformed' })
    expect(saveShellToken(store, '   ')).toEqual({ ok: false, kind: 'missing' })
    expect(saveShellToken(store, 'sk.secret')).toEqual({ ok: false, kind: 'secret' })
    expect(readShellToken(store)).toEqual({ kind: 'ok', token: 'pk.old' })
  })

  it('says so when the phone will not keep it', () => {
    const full = { ...memoryTextStore(), write: () => false }
    expect(saveShellToken(full, 'pk.abc')).toEqual({ ok: false, kind: 'storage' })
  })

  it('a stored value that went bad is not used', () => {
    expect(readShellToken(memoryTextStore({ [SHELL_TOKEN_KEY]: 'sk.oops' }))).toEqual({ kind: 'secret' })
    expect(checkToken('sk.oops').kind).toBe('secret')
  })

  it('in the shell, a rejected token points at "Change token", not at .env.local', () => {
    expect(tokenErrorHelp(401, undefined, true)).toContain('Change token')
    expect(tokenErrorHelp(403, undefined, true)).toContain('URL restrictions')
    expect(tokenErrorHelp(401, undefined, true)).not.toContain('.env.local')
    expect(tokenErrorHelp(500, undefined, true)).toBeNull()
    expect(tokenErrorHelp(401, undefined, false)).toContain('.env.local')
  })
})

describe('the shell token screen', () => {
  const text = (html: string) => html.replace(/<!-- -->/g, '')

  it('the shell with no token asks for one instead of showing the .env.local help', () => {
    const html = text(renderToString(<Root buildStatus={{ kind: 'missing' }} shell store={memoryTextStore()} />))
    expect(html).toContain('Paste your Mapbox public token')
    expect(html).toContain('without URL restrictions')
    expect(html).toContain('Save token')
    expect(html).not.toContain('Cancel')
    expect(html).not.toContain('.env.local')
    expect(html).not.toContain('data-testid="map"')
  })

  it('with a token on the phone it opens the app, with a way to change the token', () => {
    const html = text(renderToString(<ShellApp store={memoryTextStore({ [SHELL_TOKEN_KEY]: 'pk.test' })} />))
    expect(html).toContain('data-testid="map"')
    expect(html).toContain('Change token')
    expect(html).not.toContain('Paste your Mapbox public token')
  })

  it('changing a token can be cancelled; the first paste cannot', () => {
    const screen = (replacing: boolean) => text(renderToString(<ShellTokenScreen replacing={replacing} onSave={() => null} onCancel={() => {}} />))
    expect(screen(true)).toContain('Cancel')
    expect(screen(false)).not.toContain('Cancel')
  })

  it('a browser is unchanged: no token shows the setup help, a built-in token opens the app with no token button', () => {
    const none = text(renderToString(<Root buildStatus={{ kind: 'missing' }} shell={false} />))
    expect(none).toContain('.env.local')
    expect(none).not.toContain('Paste your Mapbox public token')
    const web = text(renderToString(<Root buildStatus={{ kind: 'ok', token: 'pk.test' }} shell={false} />))
    expect(web).toContain('data-testid="map"')
    expect(web).not.toContain('Change token')
  })

  it('a built-in token wins in the shell too', () => {
    const html = text(renderToString(<Root buildStatus={{ kind: 'ok', token: 'pk.test' }} shell store={memoryTextStore()} />))
    expect(html).toContain('data-testid="map"')
    expect(html).not.toContain('Change token')
  })
})
