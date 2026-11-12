import { currentPosition, type LocationResult, type PositionSource } from '../geolocation.ts'
import type { Speaker } from '../speech.ts'
import type { PageVisibility } from '../visibility.ts'
import type { ScreenWakeLock } from '../wakeLock.ts'
import type { DirectionsTransport } from '../../providers/mapbox/client.ts'
import { shellDiagnostics, type DriveDiagnostics } from './diagnostics.ts'
import { nativeTransport } from './http.ts'
import { nativePlugin, type RouteIQNativePlugin } from './plugin.ts'
import { nativeGeolocation, nativePositionSource } from './position.ts'
import { nativeEvery } from './pulse.ts'
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
}

/**
 * `log`: the drive diagnostics. It is told that a fix or a tick came, that a
 * line was spoken and that the GPS went on or off; never what or where.
 */
export function nativeDeviceFor(plugin: RouteIQNativePlugin, log: DriveDiagnostics = shellDiagnostics): NativeDevice {
  const source = nativePositionSource(plugin)
  const every = nativeEvery(plugin)
  return {
    source: {
      start(onFix, onError) {
        log.gps(true)
        const stop = source.start((fix) => {
          log.fix()
          onFix(fix)
        }, onError)
        return () => {
          log.gps(false)
          stop()
        }
      },
    },
    speaker: createNativeSpeaker(plugin, { log }),
    wakeLock: nativeWakeLock(plugin),
    visibility: ALWAYS_IN_FRONT,
    every: (ms, fn) =>
      every(ms, () => {
        log.tick()
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

/** The shell's device, or null in a browser: the caller then uses the browser's own. */
export function nativeDevice(): NativeDevice | null {
  const plugin = nativePlugin()
  return plugin === null ? null : nativeDeviceFor(plugin)
}

/** "Use my location": the plugin's position in the shell, the browser's otherwise. */
export function locateDevice(): Promise<LocationResult> {
  const plugin = nativePlugin()
  return plugin === null ? currentPosition() : currentPosition({ geolocation: nativeGeolocation(plugin), secureContext: true })
}
