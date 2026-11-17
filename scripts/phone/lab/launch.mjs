// How the phone lab starts an app (#136). Pure, so the tests can hold it; phone.mjs uses it.

/** The app the lab puts in front to send RouteIQ to the background. */
export const BACKGROUND_APP = 'com.apple.calculator'

/**
 * How the lab starts an app (#136). Ending RouteIQ while it is in front and starting it again at
 * once through the developer process-control service left the whole app unshown (black under
 * the status bar, even native marker colours missing) while it ran normally: black 4 of 4 on
 * the phone. Started from the background it drew 5 of 5. So before ending the app, the lab sends
 * it to the background and waits.
 */
export const DEFAULT_LAB_LAUNCH = Object.freeze({
  /** How long the app is left in the background before the lab ends it and starts it again, in milliseconds. */
  backgroundFirstMs: 6000,
})

/**
 * Whether a launch first sends the app to the background and waits: every launch that ends the
 * app (not `keep`), except of the background app itself, unless ROUTEIQ_LAB_HOT=1 asks for the
 * old start to reproduce the black screen on purpose.
 */
export function startsFromBackground(bundleId, { keep = false, env = process.env } = {}) {
  return !keep && bundleId !== BACKGROUND_APP && env.ROUTEIQ_LAB_HOT !== '1'
}
