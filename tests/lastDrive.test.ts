import { describe, expect, it } from 'vitest'
import { createDriveDiagnostics } from '../src/device/native/diagnostics.ts'
import { nativeTransport } from '../src/device/native/http.ts'
import { nativeDeviceFor } from '../src/device/native/index.ts'
import {
  LAST_DRIVE_KEY,
  LAST_DRIVE_SAVE_MS,
  lastDriveSaver,
  readLastDrive,
  safeToStore,
  saveLastDrive,
} from '../src/device/native/lastDrive.ts'
import type { RouteIQNativePlugin } from '../src/device/native/plugin.ts'
import { memoryTextStore, type TextStore } from '../src/storage/local.ts'

// The last drive's diagnostics, kept on the phone: counts and timings only.
// The coordinates and the token below are made up (a public landmark).

const LNG = -80.843127
const LAT = 35.227085
const TOKEN = 'pk.eyJ1IjoiZXhhbXBsZSIsImEiOiJub3QtYS1yZWFsLXRva2VuIn0.c2lnbmF0dXJl'
const URL = `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${LNG},${LAT};-80.8561,35.0015?access_token=${TOKEN}`

/** A store that also remembers everything ever written to it. */
function recordingStore(): { store: TextStore; written: string[] } {
  const inner = memoryTextStore()
  const written: string[] = []
  return {
    written,
    store: {
      read: inner.read,
      remove: inner.remove,
      write(key, value) {
        written.push(`${key}=${value}`)
        return inner.write(key, value)
      },
    },
  }
}

type Listener = (data?: unknown) => void

function fakePlugin() {
  const listeners = new Map<string, Set<Listener>>()
  const plugin = {
    startLocation: () => Promise.resolve({ authorization: 'when-in-use' }),
    stopLocation: () => Promise.resolve(),
    getCurrentPosition: () => new Promise(() => {}),
    speak: () => Promise.resolve({ finished: true }),
    cancelSpeech: () => Promise.resolve(),
    keepAwake: () => Promise.resolve(),
    httpGet: () => Promise.resolve({ status: 200, body: `{"code":"Ok","note":"${LNG},${LAT}"}`, ms: 412 }),
    httpCancel: () => Promise.resolve(),
    startSimulatedRoute: () => Promise.resolve(),
    stopSimulatedRoute: () => Promise.resolve(),
    addListener(event: string, listener: Listener) {
      const set = listeners.get(event) ?? new Set()
      listeners.set(event, set)
      set.add(listener)
      return Promise.resolve({ remove: async () => void set.delete(listener) })
    },
  } as unknown as RouteIQNativePlugin
  const emit = (event: string, data?: unknown) => [...(listeners.get(event) ?? [])].forEach((l) => l(data))
  return { plugin, emit }
}

describe('what may be stored', () => {
  it('a diagnostics text is; anything that looks like a position, a token or an address is not', () => {
    expect(safeToStore('fixes: 3200 (2900 while not active), longest gap 1 s\n14:03:22 request 2 answered, HTTP 200, 440 ms, native 431 ms [background]')).toBe(true)
    expect(safeToStore(`fix at ${LNG}`)).toBe(false)
    expect(safeToStore(`fix at ${LAT}`)).toBe(false)
    expect(safeToStore('at 35,227085')).toBe(false)
    expect(safeToStore(`token ${TOKEN}`)).toBe(false)
    expect(safeToStore('token sk.secret')).toBe(false)
    expect(safeToStore(URL)).toBe(false)
    expect(safeToStore('capacitor://localhost')).toBe(false)
    expect(safeToStore('')).toBe(false)
    expect(safeToStore('x'.repeat(50_000))).toBe(false)
  })

  it('a refused text is not written at all, and leaves the last good one in place', () => {
    const { store, written } = recordingStore()
    expect(saveLastDrive(store, 'fixes: 12', 1_000)).toBe(true)
    expect(saveLastDrive(store, `fixes: 12 at ${LNG},${LAT}`, 2_000)).toBe(false)
    expect(saveLastDrive(store, URL, 3_000)).toBe(false)
    expect(written).toHaveLength(1)
    expect(readLastDrive(store)).toEqual({ savedAtMs: 1_000, text: 'fixes: 12' })
  })

  it('what is read back is checked the same way: a damaged or unsafe record reads as none', () => {
    expect(readLastDrive(memoryTextStore())).toBeNull()
    expect(readLastDrive(memoryTextStore({ [LAST_DRIVE_KEY]: 'not json' }))).toBeNull()
    expect(readLastDrive(memoryTextStore({ [LAST_DRIVE_KEY]: 'null' }))).toBeNull()
    expect(readLastDrive(memoryTextStore({ [LAST_DRIVE_KEY]: JSON.stringify({ savedAtMs: 'now', text: 'fixes: 1' }) }))).toBeNull()
    expect(readLastDrive(memoryTextStore({ [LAST_DRIVE_KEY]: JSON.stringify({ savedAtMs: 5, text: `at ${LAT}` }) }))).toBeNull()
    expect(readLastDrive(memoryTextStore({ [LAST_DRIVE_KEY]: JSON.stringify({ savedAtMs: 5, text: 'fixes: 1' }) }))).toEqual({ savedAtMs: 5, text: 'fixes: 1' })
  })
})

describe('when it is written', () => {
  it('about every 30 s during a drive, and when the drive ends', () => {
    const { store, written } = recordingStore()
    let now = 0
    let text = 'fixes: 0'
    const saver = lastDriveSaver({ text: () => text }, store, () => now)
    // One tick a second for a minute and a half.
    for (now = 1000; now <= 91_000; now += 1000) {
      text = `fixes: ${now / 1000}`
      saver.tick()
    }
    expect(written).toHaveLength(3)
    expect(readLastDrive(store)).toEqual({ savedAtMs: 1000 + 3 * LAST_DRIVE_SAVE_MS, text: 'fixes: 91' })
    now = 95_500
    text = 'fixes: 95'
    saver.end()
    expect(readLastDrive(store)).toEqual({ savedAtMs: 95_500, text: 'fixes: 95' })
  })
})

describe('a whole drive through the shell', () => {
  it('leaves counts and timings in the store, and no coordinate, token or address', async () => {
    const { store, written } = recordingStore()
    const { plugin, emit } = fakePlugin()
    let now = new Date(2026, 10, 11, 13, 0, 0).getTime()
    const log = createDriveDiagnostics(() => now)
    const device = nativeDeviceFor(plugin, log, {
      store,
      simulate: { origin: [LNG, LAT], preset: 'wrong-turn', multiplier: 3 },
      timers: { now: () => now, setInterval: () => 0, clearInterval: () => {} },
    })
    const transport = nativeTransport(plugin, { log })

    const stopTicks = device.every(1000, () => {})
    const stop = device.source.start(
      () => {},
      () => {},
    )
    log.appState('background')
    // Two minutes of fixes and ticks carrying precise positions, and route requests whose address holds the token.
    for (let s = 1; s <= 120; s++) {
      now += 1000
      emit('fix', { lng: LNG + s * 0.000137, lat: LAT - s * 0.000211, accuracy: 4.7, speed: 14.6, course: 181.3, timestamp: now + 0.5, simulated: true })
      emit('tick')
      if (s % 40 === 0) await transport(URL, { signal: new AbortController().signal })
    }
    device.speaker.say({ text: `Turn left at ${LAT}`, priority: 'turn' })
    stop()
    stopTicks()

    // Written during the drive (every 30 s) and at its end.
    expect(written.length).toBeGreaterThanOrEqual(4)
    const kept = readLastDrive(store)
    expect(kept).not.toBeNull()
    expect(kept!.text).toContain('fixes: 120 (120 while not active)')
    expect(kept!.text).toMatch(/requests: 3 sent \(3 while not active\), 3 answered/)
    expect(kept!.text).toContain('SIMULATED GPS test drive: wrong-turn, 3x speed')
    expect(kept!.text).toContain('SIMULATED GPS: 1 test drive')
    expect(kept!.text).toContain('gps off')

    // By pattern, over everything that was ever written: no decimal number (a coordinate has one),
    // nothing of the made-up position, no token, no address.
    for (const entry of written) {
      expect(entry).not.toMatch(/\d\.\d/)
      expect(entry).not.toMatch(/-?80[.,]?84|35[.,]?22/)
      expect(entry).not.toMatch(/pk\.|sk\.|access_token|eyJ/)
      expect(entry).not.toMatch(/https?:|mapbox|directions/i)
      expect(entry).not.toContain('Turn left')
    }
  })
})
