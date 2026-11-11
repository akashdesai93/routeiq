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
   * 'fix': a position. 'locationError': the GPS failed or was refused.
   * 'tick': about once a second while the location stream is on, from a
   * native timer, so the web side has a clock that iOS does not throttle.
   */
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
