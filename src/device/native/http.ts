import { directionsRequestKind, type DirectionsTransport } from '../../providers/mapbox/client.ts'
import type { DriveDiagnostics, RequestOutcome } from './diagnostics.ts'
import type { RouteIQNativePlugin } from './plugin.ts'

/** The only place the native request path goes. The Swift side checks the same. */
export const NATIVE_HTTP_PREFIX = 'https://api.mapbox.com/'
/** How long one route request may take before the native side gives up, in milliseconds. */
export const NATIVE_HTTP_TIMEOUT_MS = 20_000
/** How much longer the web side waits for the native side to say so, in milliseconds. */
export const NATIVE_HTTP_GRACE_MS = 5_000

export interface NativeTransportOptions {
  /** Counts and timings only; the URL is never passed to it. */
  readonly log?: Pick<DriveDiagnostics, 'requestSent' | 'requestEnded'>
  readonly timeoutMs?: number
  readonly setTimer?: (fn: () => void, ms: number) => unknown
  readonly clearTimer?: (id: unknown) => void
}

const abortError = () => new DOMException('The request was cancelled.', 'AbortError')

const outcomeOf = (code: unknown): RequestOutcome =>
  code === 'cancelled' || code === 'timeout' || code === 'not-allowed' ? code : 'network'

/**
 * The Directions client's transport inside the iPhone shell: the request is
 * made by iOS (URLSession, the plugin's `httpGet`) instead of by the web
 * view's `fetch`, which iOS may hold back while the phone is locked.
 *
 * It behaves like `fetch` as far as the client can tell: it resolves with
 * the status and the body for any HTTP answer (401, 403 and 429 included, so
 * the client's error messages are the same), rejects when there is none, and
 * an abort rejects at once and cancels the native request.
 *
 * The URL holds the token and the position: it goes to the plugin and
 * nowhere else. No error made here contains it, and nothing is logged.
 */
export function nativeTransport(plugin: RouteIQNativePlugin, options: NativeTransportOptions = {}): DirectionsTransport {
  const {
    log,
    timeoutMs = NATIVE_HTTP_TIMEOUT_MS,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  } = options
  let count = 0
  return (url, init) =>
    new Promise((resolve, reject) => {
      const signal = init?.signal ?? undefined
      if (typeof url !== 'string' || !url.startsWith(NATIVE_HTTP_PREFIX)) {
        reject(new Error('Only requests to Mapbox go through the app.'))
        return
      }
      if (signal?.aborted) {
        reject(abortError())
        return
      }
      const id = `get-${++count}`
      // Only the kind of request is passed on, read off the URL here: never the URL itself.
      const n = log?.requestSent(directionsRequestKind(url))
      let settled = false
      const settle = (outcome: RequestOutcome, status?: number, nativeMs?: number): boolean => {
        if (settled) return false
        settled = true
        clearTimer(backstop)
        signal?.removeEventListener('abort', onAbort)
        if (n !== undefined) log?.requestEnded(n, outcome, status, nativeMs)
        return true
      }
      const cancelNative = () => {
        try {
          void plugin.httpCancel({ id }).catch(() => {})
        } catch {
          // Nothing to cancel then.
        }
      }
      const onAbort = () => {
        if (!settle('cancelled')) return
        cancelNative()
        reject(abortError())
      }
      // The native side has its own time limit. This is for a native side that never answers at all.
      const backstop = setTimer(() => {
        if (!settle('timeout')) return
        cancelNative()
        reject(new Error('The route request timed out.'))
      }, timeoutMs + NATIVE_HTTP_GRACE_MS)
      signal?.addEventListener('abort', onAbort, { once: true })

      let pending: Promise<{ status?: number; body?: string; ms?: number }>
      try {
        pending = plugin.httpGet({ id, url, timeoutMs })
      } catch {
        if (settle('network')) reject(new Error('The route request could not be made.'))
        return
      }
      pending.then(
        (answer) => {
          const status = answer?.status
          if (typeof status !== 'number' || !Number.isFinite(status)) {
            if (settle('network')) reject(new Error('The route request got no answer.'))
            return
          }
          if (!settle('answered', status, answer.ms)) return
          const body = typeof answer.body === 'string' ? answer.body : ''
          resolve({ status, json: async () => JSON.parse(body) as unknown })
        },
        (failure: { code?: unknown } | undefined) => {
          // Only the kind of failure is kept: a native error text could hold the URL.
          const outcome = outcomeOf(failure?.code)
          if (settle(outcome)) reject(new Error(`The route request failed (${outcome}).`))
        },
      )
    })
}
