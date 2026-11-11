import { currentPosition, type LocationResult, type PositionSource } from '../geolocation.ts'
import type { Speaker } from '../speech.ts'
import type { PageVisibility } from '../visibility.ts'
import type { ScreenWakeLock } from '../wakeLock.ts'
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

export function nativeDeviceFor(plugin: RouteIQNativePlugin): NativeDevice {
  return {
    source: nativePositionSource(plugin),
    speaker: createNativeSpeaker(plugin),
    wakeLock: nativeWakeLock(plugin),
    visibility: ALWAYS_IN_FRONT,
    every: nativeEvery(plugin),
  }
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
