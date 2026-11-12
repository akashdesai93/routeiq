/**
 * The iPhone shell's native side, as the web app sees it. The shell
 * (native/shell) is this same web app inside an installed app; its Swift
 * plugin "RouteIQNative" owns the GPS, the voice and the screen lock, which
 * iOS keeps running while the phone is locked. A web page gets none of that.
 *
 * The shell puts the plugin on `globalThis.RouteIQNative` before the app's
 * own script runs (native/shell/src/bridge.js). In a browser it is not
 * there, and everything in this folder stays unused.
 */

/** One position from the phone's GPS. A value the phone does not know is left out. */
export interface NativeFix {
  readonly lng: number
  readonly lat: number
  /** Radius of the fix, meters. */
  readonly accuracy?: number
  /** Meters per second. */
  readonly speed?: number
  /** Degrees clockwise from true north. */
  readonly course?: number
  /** When the phone took the fix, milliseconds since 1970. */
  readonly timestamp?: number
  /** True on a position made up by startSimulatedRoute (the "Test drive"); never set on one from the GPS. */
  readonly simulated?: boolean
}

/** One step of a simulated route's script (see src/drive/testDrive.ts). */
export interface NativeSimulatedStep {
  readonly atM: number
  readonly speedMps?: number
  readonly stopSec?: number
}

export interface NativeLocationError {
  /** 'denied', or anything else for "no position right now". */
  readonly kind: string
}

export interface NativeListenerHandle {
  remove(): Promise<void>
}

export interface RouteIQNativePlugin {
  /** Starts the stream of 'fix' events, asking for the location permission first if needed. Rejects (code 'denied') when refused. */
  startLocation(): Promise<{ authorization?: string }>
  stopLocation(): Promise<unknown>
  /** One position, without starting a stream. Rejects with code 'denied', 'timeout' or 'unavailable'. */
  getCurrentPosition(): Promise<NativeFix>
  /** Resolves when the line has been spoken (finished: true) or was cut off (finished: false). */
  speak(options: { text: string }): Promise<{ finished?: boolean }>
  cancelSpeech(): Promise<unknown>
  /** True: the screen does not dim or lock by itself. */
  keepAwake(options: { on: boolean }): Promise<unknown>
  /**
   * A GET made by iOS (URLSession) instead of the web view, to
   * https://api.mapbox.com/ only. Resolves with the HTTP status (any status),
   * the body as text and the milliseconds it took. Rejects with code
   * 'not-allowed' (another address), 'cancelled', 'timeout' or 'network'.
   * `id` names the request for httpCancel.
   */
  httpGet(options: { id: string; url: string; timeoutMs: number }): Promise<{ status?: number; body?: string; ms?: number }>
  /** Stops the request with this id, if it is still out. */
  httpCancel(options: { id: string }): Promise<unknown>
  /**
   * The "Test drive": from now on 'fix' events are made up by a native timer,
   * about one a second, driving along `points` ([lng, lat] pairs) at `speedMps`
   * and following `script`; each carries `simulated: true`. At the end of the
   * points the car stands there. While this is on, positions from the GPS are
   * discarded (the GPS itself stays on when startLocation was called, which is
   * what keeps the app running with the phone locked). Calling it again
   * replaces the route. Rejects with code 'invalid' when no point is usable.
   */
  startSimulatedRoute?(options: { points: number[][]; speedMps: number; script: NativeSimulatedStep[] }): Promise<unknown>
  /** Ends the simulation; positions come from the GPS again. stopLocation ends it too. */
  stopSimulatedRoute?(): Promise<unknown>
  /** Opens the iOS share sheet with the text. Resolves when the sheet is closed. */
  share?(options: { text: string }): Promise<{ completed?: boolean }>
  /**
   * 'fix': a position. 'locationError': the GPS failed or was refused.
   * 'tick': about once a second while the location stream is on, from a
   * native timer, so the web side has a clock that iOS does not throttle.
   * 'appState': the app became 'active', 'inactive' or went to the 'background'.
   */
  addListener(event: 'appState', listener: (change: { state?: string }) => void): Promise<NativeListenerHandle>
  addListener(event: 'fix', listener: (fix: NativeFix) => void): Promise<NativeListenerHandle>
  addListener(event: 'locationError', listener: (error: NativeLocationError) => void): Promise<NativeListenerHandle>
  addListener(event: 'tick', listener: () => void): Promise<NativeListenerHandle>
}

/** The shell's plugin, or null in a browser. */
export function nativePlugin(): RouteIQNativePlugin | null {
  try {
    const plugin = (globalThis as { RouteIQNative?: RouteIQNativePlugin | null }).RouteIQNative
    return plugin !== undefined && plugin !== null && typeof plugin.startLocation === 'function' ? plugin : null
  } catch {
    return null
  }
}

/** True inside the iPhone shell. */
export function isNativeShell(): boolean {
  return nativePlugin() !== null
}

/** Stops listening, once the listener has been registered. Never throws or rejects. */
export function removeListener(handle: Promise<NativeListenerHandle>): void {
  void handle.then((h) => h.remove()).catch(() => {})
}
