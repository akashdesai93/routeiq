import { distanceM, isValidLngLat, type LngLat } from '../../core/index.ts'
import { buildTestDrive, type SimulatedRoute, type TestDrivePreset } from '../../drive/testDrive.ts'
import type { PositionSource } from '../geolocation.ts'
import { removeListener, type NativeFix, type RouteIQNativePlugin } from './plugin.ts'

/** What a test drive is set to do. */
export interface SimulatedDrive {
  /** Where the made-up car starts: the start of the selected route. */
  readonly origin: LngLat
  readonly preset: TestDrivePreset
  /** 1 for a real car's speed. */
  readonly multiplier: number
}

const known = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)

const usable = (fix: NativeFix | null | undefined): fix is NativeFix =>
  fix !== undefined &&
  fix !== null &&
  fix.simulated === true &&
  typeof fix.lng === 'number' &&
  typeof fix.lat === 'number' &&
  isValidLngLat([fix.lng, fix.lat])

/**
 * The shell's "Test drive" as a position source: a made-up car, moved by the
 * app's native code (the plugin's startSimulatedRoute, a native timer), so
 * it keeps driving while the phone is locked. This side writes the script
 * (drive/testDrive.ts) each time the session gives it a route to follow, and
 * hands the made-up fixes on like the GPS's.
 *
 * The phone's real GPS is switched on as well, exactly as on a real drive,
 * because that is what makes iOS keep the app running in the background;
 * its positions are discarded natively, and again here (only fixes marked
 * `simulated` are taken). So a test drive never reads where the phone is.
 */
export function simulatedPositionSource(plugin: RouteIQNativePlugin, drive: SimulatedDrive, now: () => number = Date.now): PositionSource {
  let stopped = true
  let last: LngLat | null = null
  let drivenM = 0
  // Of the script being driven: the meters driven when it began, and where on it the wrong turn or U-turn begins.
  let scriptFromM = 0
  let eventAtM: number | null = null
  let eventBegun = false
  let fail: () => void = () => {}

  /** Resolves true once the native side has the route; false (after reporting the failure) when it does not. */
  const send = (route: SimulatedRoute): Promise<boolean> => {
    if (typeof plugin.startSimulatedRoute !== 'function') {
      fail()
      return Promise.resolve(false)
    }
    return plugin
      .startSimulatedRoute({ points: route.points.map(([lng, lat]) => [lng, lat]), speedMps: route.speedMps, script: [...route.script] })
      .then(
        () => true,
        () => {
          fail()
          return false
        },
      )
  }

  return {
    start(onFix, onError) {
      stopped = false
      last = null
      drivenM = scriptFromM = 0
      eventAtM = null
      eventBegun = false
      fail = () => {
        if (!stopped) onError('unavailable')
      }
      const fixes = plugin.addListener('fix', (fix) => {
        if (stopped || !usable(fix)) return
        const at: LngLat = [fix.lng, fix.lat]
        if (last !== null) drivenM += distanceM(last, at)
        last = at
        if (eventAtM !== null && drivenM - scriptFromM >= eventAtM) eventBegun = true
        onFix({ lng: fix.lng, lat: fix.lat, accuracyM: known(fix.accuracy) ?? NaN, speedMps: known(fix.speed), headingDeg: known(fix.course), timeMs: now() })
      })
      // Indoors the real GPS often has no position: that is not this drive's problem. A refusal is, as on a real drive.
      const errors = plugin.addListener('locationError', (error) => {
        if (!stopped && error?.kind === 'denied') onError('denied')
      })
      // The made-up car first, standing at its start; the GPS only once the native side has it,
      // so the native side never hands on a real position.
      void send({ points: [drive.origin], speedMps: 0, script: [] }).then((running) => {
        if (stopped || !running) return
        plugin.startLocation().catch((error: { code?: unknown } | undefined) => {
          if (!stopped && error?.code === 'denied') onError('denied')
        })
      })
      return () => {
        if (stopped) return
        stopped = true
        removeListener(fixes)
        removeListener(errors)
        // Ending the location stream ends the simulation in the same native step, so no real
        // position slips out in between; the second call is for a stream that never started.
        plugin.stopLocation().catch(() => {})
        plugin.stopSimulatedRoute?.().catch(() => {})
      }
    },
    follow(geometry) {
      if (stopped) return
      const script = buildTestDrive({ geometry, from: last ?? drive.origin, drivenM, eventBegun, preset: drive.preset, multiplier: drive.multiplier })
      scriptFromM = drivenM
      eventAtM = script.eventAtM
      void send(script)
    },
  }
}
