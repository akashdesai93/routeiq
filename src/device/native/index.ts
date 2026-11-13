import type { OfferLifeEvent } from '../../core/index.ts'
import { currentPosition, type LocationResult, type PositionSource } from '../geolocation.ts'
import type { Speaker } from '../speech.ts'
import type { PageVisibility } from '../visibility.ts'
import type { ScreenWakeLock } from '../wakeLock.ts'
import type { DirectionsTransport } from '../../providers/mapbox/client.ts'
import { localTextStore, type TextStore } from '../../storage/local.ts'
import { shellDiagnostics, type DriveDiagnostics } from './diagnostics.ts'
import { nativeTransport } from './http.ts'
import { lastDriveSaver } from './lastDrive.ts'
import { nativePlugin, type RouteIQNativePlugin } from './plugin.ts'
import { nativeGeolocation, nativePositionSource } from './position.ts'
import { nativeEvery, type PulseTimers } from './pulse.ts'
import { simulatedPositionSource, type SimulatedDrive } from './simulated.ts'
import { createNativeSpeaker } from './speech.ts'
import { ALWAYS_IN_FRONT } from './visibility.ts'
import { nativeWakeLock } from './wakeLock.ts'

export { isNativeShell, nativePlugin } from './plugin.ts'

/** Everything a live drive takes from the device, as the shell supplies it (see LiveRunnerDeps). */
export interface NativeDevice {
  readonly source: PositionSource
  readonly speaker: Speaker
  readonly wakeLock: ScreenWakeLock
  readonly visibility: PageVisibility
  readonly every: (ms: number, fn: () => void) => () => void
  /** True when the positions are a test drive's (made up), not the GPS's. */
  readonly simulated: boolean
  /** A drive check was decided: its outcome goes into the diagnostics (DriveDiagnostics.checked). */
  readonly checked: (code: string, routes: number | null, savingSec: number | null) => void
  /** What happened to a switch offer (#202): shown, then one ending (DriveDiagnostics.offerShown, offerEnded). */
  readonly offer: (event: OfferLifeEvent) => void
}

export interface NativeDeviceOptions {
  /** A test drive: the made-up car in place of the GPS (simulated.ts). Null or left out: the GPS. */
  readonly simulate?: SimulatedDrive | null
  /** Where the last drive's diagnostics are kept. Default: the app's own storage. */
  readonly store?: TextStore
  /** Swapped out in tests: the clock and the page timers behind the ticks and the saving. */
  readonly timers?: PulseTimers
}

/**
 * `log`: the drive diagnostics. It is told that a fix or a tick came, that a
 * line was spoken and that the GPS went on or off; never what or where. Its
 * text is written to `store` when a drive ends and now and then during one
 * (lastDrive.ts), so it is still there after the app was closed.
 */
export function nativeDeviceFor(plugin: RouteIQNativePlugin, log: DriveDiagnostics = shellDiagnostics, options: NativeDeviceOptions = {}): NativeDevice {
  const simulate = options.simulate ?? null
  const source = simulate === null ? nativePositionSource(plugin) : simulatedPositionSource(plugin, simulate)
  const every = options.timers === undefined ? nativeEvery(plugin) : nativeEvery(plugin, options.timers)
  const saver = lastDriveSaver(log, options.store ?? localTextStore(), options.timers?.now)
  return {
    simulated: simulate !== null,
    checked: (code, routes, faster) => log.checked(code, routes, faster),
    offer: (e) => (e.kind === 'shown' ? log.offerShown(e.why, e.savingSec) : log.offerEnded(e.how, e.reason, e.afterSec, e.directions)),
    source: {
      start(onFix, onError) {
        log.gps(true)
        if (simulate !== null) log.simulated(simulate.preset, simulate.multiplier)
        const stop = source.start((fix) => {
          log.fix()
          onFix(fix)
        }, onError)
        return () => {
          log.gps(false)
          stop()
          saver.end()
        }
      },
      follow: (geometry) => source.follow?.(geometry),
    },
    speaker: createNativeSpeaker(plugin, { log }),
    wakeLock: nativeWakeLock(plugin),
    visibility: ALWAYS_IN_FRONT,
    every: (ms, fn) =>
      every(ms, () => {
        log.tick()
        saver.tick()
        fn()
      }),
  }
}

/**
 * Call once at startup. Inside the shell it starts the drive diagnostics'
 * record of the app going to the background and coming back, and returns
 * the transport that sends Directions requests through native networking
 * (for setDirectionsTransport). Null in a browser, where nothing changes.
 */
export function startNativeShell(log: DriveDiagnostics = shellDiagnostics): DirectionsTransport | null {
  const plugin = nativePlugin()
  if (plugin === null) return null
  try {
    void plugin.addListener('appState', (change) => log.appState(change?.state)).catch(() => {})
  } catch {
    // Diagnostics only: the drive does not depend on it.
  }
  return nativeTransport(plugin, { log })
}

/** The shell's device, or null in a browser: the caller then uses the browser's own. `simulate`: a test drive. */
export function nativeDevice(simulate: SimulatedDrive | null = null): NativeDevice | null {
  const plugin = nativePlugin()
  return plugin === null ? null : nativeDeviceFor(plugin, shellDiagnostics, { simulate })
}

/** "Use my location": the plugin's position in the shell, the browser's otherwise. */
export function locateDevice(): Promise<LocationResult> {
  const plugin = nativePlugin()
  return plugin === null ? currentPosition() : currentPosition({ geolocation: nativeGeolocation(plugin), secureContext: true })
}
