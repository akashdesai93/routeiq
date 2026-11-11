import type { KeyValueStore } from '../../storage/kv.ts'
import { buildOverpassQuery, parseOverpassSignals, type OsmFailure, type OsmSignalTile } from './adapter.ts'

/**
 * The public Overpass API instance run by FOSSGIS volunteers. It is shared
 * and free, so the rules below are strict: few requests, never in a burst,
 * and a real pause after the server says it is busy.
 */
export const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter'

/** After a busy answer no request is sent for this long. The operators ask for at least 30 s after a 429. */
export const OVERPASS_COOLDOWN_MS = 30_000

/** Each further busy answer doubles the pause, up to this. */
export const OVERPASS_MAX_COOLDOWN_MS = 8 * 60_000

/** The public server gives each address two query slots. */
export const OVERPASS_MAX_CONCURRENT = 2

/**
 * How long the app waits for an answer. A tile of signals normally takes a
 * second or two; a server at capacity can hold the connection open instead of
 * refusing it, and nobody should watch "Counting signals" for that long.
 */
const REQUEST_TIMEOUT_MS = 20_000

/** HTTP statuses that mean "later": rate limited, or the server (or the proxy in front of it) is at capacity. */
const BUSY_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504])

export type OsmTileFailure = OsmFailure & {
  /** Seconds the server asked to wait (Retry-After), when it said. */
  readonly retryAfterSec?: number
}

export type OsmTileResult = { readonly ok: true; readonly tile: OsmSignalTile } | OsmTileFailure

export interface FetchSignalTileOptions {
  /** Another Overpass instance, for example a private one. */
  endpoint?: string
  /** Aborting resolves with kind 'aborted'; the caller should ignore that result. */
  signal?: AbortSignal
  /** Swapped out in tests so they never touch the network. */
  fetchImpl?: typeof fetch
  /** The clock, in milliseconds. Stamps the tile's fetchedAt. */
  now?: () => number
  timeoutMs?: number
}

const ABORTED: OsmTileFailure = { ok: false, kind: 'aborted', message: 'Signal request cancelled.' }

/**
 * Downloads the traffic signals of one tile from Overpass: one POST whose
 * body is the query for that tile's bounding box and nothing else (see
 * buildOverpassQuery). No route, pin or position is sent, and no cookies.
 *
 * The body is form-encoded, which browsers send cross-origin without a
 * preflight request, and no custom header is set. The referrer is cut down
 * to the page's origin rather than removed: the server's usage policy
 * requires browser requests to say which site they come from and refuses
 * those that do not.
 *
 * Never rejects: HTTP, network, timeout and abort failures all come back as a
 * typed result. A request that gets no answer within `timeoutMs` is given up
 * and reported as busy. It makes exactly one request; waiting after a busy answer is
 * the job of createOverpassClient.
 */
export async function fetchSignalTile(tileId: string, options: FetchSignalTileOptions = {}): Promise<OsmTileResult> {
  const {
    endpoint = OVERPASS_ENDPOINT,
    signal,
    fetchImpl = fetch,
    now = Date.now,
    timeoutMs = REQUEST_TIMEOUT_MS,
  } = options
  const query = buildOverpassQuery(tileId)
  if (query === null) return { ok: false, kind: 'malformed', message: `"${tileId}" is not a signal tile.` }
  if (signal?.aborted) return ABORTED

  const controller = new AbortController()
  const forwardAbort = () => controller.abort()
  signal?.addEventListener('abort', forwardAbort)
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  let status: number
  let retryAfter: string | null = null
  let body: unknown = null
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      body: new URLSearchParams({ data: query }),
      signal: controller.signal,
      credentials: 'omit',
      referrerPolicy: 'origin',
    })
    status = response.status
    retryAfter = response.headers?.get('retry-after') ?? null
    // Errors come back as plain text or HTML; those stay null.
    body = await response.json().catch(() => null)
  } catch {
    if (signal?.aborted) return ABORTED
    if (timedOut) {
      // No answer in time is a server with too much to do: treated like any other busy answer.
      return {
        ok: false,
        kind: 'busy',
        message: 'The OpenStreetMap signal server did not answer in time. Try again in a minute.',
      }
    }
    return {
      ok: false,
      kind: 'network',
      message: 'Could not reach the OpenStreetMap signal server (Overpass).',
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forwardAbort)
  }
  if (signal?.aborted) return ABORTED

  if (BUSY_STATUSES.has(status)) {
    const seconds = retryAfter === null ? NaN : Number(retryAfter)
    return {
      ok: false,
      kind: 'busy',
      message: `The OpenStreetMap signal server is busy (HTTP ${status}). Try again in a minute.`,
      ...(Number.isFinite(seconds) && seconds > 0 ? { retryAfterSec: seconds } : {}),
    }
  }
  if (status < 200 || status >= 300) {
    return {
      ok: false,
      kind: 'api',
      message: `The OpenStreetMap signal server refused the request (HTTP ${status}).`,
    }
  }
  const parsed = parseOverpassSignals(body)
  if (!parsed.ok) return parsed
  return { ok: true, tile: { tileId, fetchedAt: now(), nodes: parsed.nodes } }
}

/** The pause the server asked for, kept so that reloading the page does not forget it. */
export interface OverpassPause {
  /** No request before this time, in milliseconds since 1970. */
  readonly until: number
  /** How long the next pause will be if the server is still busy. */
  readonly nextMs: number
}

export function isOverpassPause(value: unknown): value is OverpassPause {
  if (typeof value !== 'object' || value === null) return false
  const { until, nextMs } = value as Record<string, unknown>
  return typeof until === 'number' && Number.isFinite(until) && typeof nextMs === 'number' && nextMs > 0
}

const PAUSE_KEY = 'pause'

export interface OverpassClientOptions extends Omit<FetchSignalTileOptions, 'signal'> {
  maxConcurrent?: number
  cooldownMs?: number
  maxCooldownMs?: number
  /** Where the pause is remembered across page loads. Left out, it lasts only as long as the page. */
  pauseStore?: KeyValueStore<OverpassPause>
}

export interface OverpassClient {
  /** One tile. Never rejects. Calls for a tile that is already being fetched share that request. */
  fetchTile: (tileId: string) => Promise<OsmTileResult>
}

/**
 * The polite way to use fetchSignalTile, and the only way the app does:
 * - at most `maxConcurrent` requests (2) are in flight; the rest wait in line;
 * - two callers asking for the same tile at once share one request;
 * - after a busy answer (HTTP 429, 502, 503, 504, a timeout remark, or no
 *   answer in time) nothing
 *   is sent for `cooldownMs` (30 s), or for the server's Retry-After if that
 *   is longer. Tiles asked for meanwhile, the ones already waiting in line
 *   included, fail at once as 'busy' without a request, and the caller shows
 *   a partial count. Each busy answer in a row doubles the pause, up to
 *   `maxCooldownMs`; a successful answer resets it. With a `pauseStore` the
 *   pause survives a page reload, so reloading cannot be used (by accident)
 *   to keep asking a busy server.
 * There are no automatic retries: the next attempt is the next time a route
 * needs the tile.
 */
export function createOverpassClient(options: OverpassClientOptions = {}): OverpassClient {
  const {
    maxConcurrent = OVERPASS_MAX_CONCURRENT,
    cooldownMs = OVERPASS_COOLDOWN_MS,
    maxCooldownMs = OVERPASS_MAX_COOLDOWN_MS,
    now = Date.now,
    pauseStore,
    ...fetchOptions
  } = options
  const inFlight = new Map<string, Promise<OsmTileResult>>()
  const waiting: (() => void)[] = []
  let running = 0
  let pausedUntil = 0
  let nextPauseMs = cooldownMs
  let restoring: Promise<void> | null = null

  /** Reads a pause left by an earlier page load, once. */
  const restore = (): Promise<void> => {
    restoring ??= (async () => {
      const stored = (await pauseStore?.get(PAUSE_KEY)) ?? null
      if (stored === null) return
      pausedUntil = Math.max(pausedUntil, stored.until)
      nextPauseMs = Math.min(Math.max(nextPauseMs, stored.nextMs), maxCooldownMs)
    })()
    return restoring
  }
  const remember = () => void pauseStore?.put(PAUSE_KEY, { until: pausedUntil, nextMs: nextPauseMs })

  const acquire = (): Promise<void> => {
    if (running < maxConcurrent) {
      running++
      return Promise.resolve()
    }
    return new Promise((resolve) => waiting.push(resolve))
  }
  const release = () => {
    // Hand the slot straight to the next in line, or free it.
    const next = waiting.shift()
    if (next) next()
    else running--
  }

  const run = async (tileId: string): Promise<OsmTileResult> => {
    await acquire()
    try {
      await restore()
      if (now() < pausedUntil) {
        return {
          ok: false,
          kind: 'busy',
          message: 'The OpenStreetMap signal server asked RouteIQ to wait. Try again in a minute.',
        }
      }
      const result = await fetchSignalTile(tileId, { ...fetchOptions, now })
      if (result.ok) {
        if (nextPauseMs !== cooldownMs) {
          nextPauseMs = cooldownMs
          remember()
        }
      } else if (result.kind === 'busy') {
        pausedUntil = now() + Math.max(nextPauseMs, (result.retryAfterSec ?? 0) * 1000)
        nextPauseMs = Math.min(nextPauseMs * 2, maxCooldownMs)
        remember()
      }
      return result
    } finally {
      release()
      inFlight.delete(tileId)
    }
  }

  return {
    fetchTile(tileId) {
      const existing = inFlight.get(tileId)
      if (existing) return existing
      const started = run(tileId)
      inFlight.set(tileId, started)
      return started
    },
  }
}
