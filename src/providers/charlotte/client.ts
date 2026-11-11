import { isValidLngLat, type SignalPoint } from '../../core/index.ts'
import { indexedDbStore, type KeyValueStore } from '../../storage/kv.ts'
import { parseSignalsPage, SIGNAL_FIELDS, type SignalsFailure } from './adapter.ts'

/**
 * City of Charlotte (CDOT) "Traffic Signals" layer on ArcGIS Online, the
 * service behind the dataset on the Charlotte Open Data Portal.
 */
export const SIGNALS_LAYER_URL =
  'https://services.arcgis.com/9Nl857LBlQVyzq54/arcgis/rest/services/Traffic_Signals/FeatureServer/0'

/** The layer's maxRecordCount (checked Nov 2026). The whole dataset is under one page today. */
export const SIGNALS_PAGE_SIZE = 2000

/** Stops a misbehaving server from paging forever: 50 pages is 100,000 records. */
const MAX_PAGES = 50

export type SignalsResult =
  | { readonly ok: true; readonly signals: readonly SignalPoint[] }
  | SignalsFailure

/**
 * Query URL for one page of the whole dataset. On purpose there is no place
 * to put a location: no bounding box, no geometry, no pin. The request is the
 * same whatever route is on screen, so the city's server learns nothing about
 * where anyone is driving. Matching to a route happens locally in src/core,
 * where this list only fills gaps in the OpenStreetMap signal data.
 */
export function buildSignalsUrl(offset: number, pageSize: number = SIGNALS_PAGE_SIZE): string {
  const query = new URLSearchParams({
    where: '1=1',
    outFields: SIGNAL_FIELDS.join(','),
    outSR: '4326',
    // A stable order is what makes offset paging safe.
    orderByFields: 'OBJECTID',
    resultOffset: String(offset),
    resultRecordCount: String(pageSize),
    f: 'geojson',
  })
  return `${SIGNALS_LAYER_URL}/query?${query.toString()}`
}

export interface FetchSignalsOptions {
  /** Aborting resolves with kind 'aborted'; the caller should ignore that result. */
  signal?: AbortSignal
  /** Swapped out in tests so they never touch the network. */
  fetchImpl?: typeof fetch
  pageSize?: number
}

const ABORTED: SignalsFailure = { ok: false, kind: 'aborted', message: 'Signal request cancelled.' }

/**
 * Downloads every operating traffic signal in the city, following the
 * server's paging until it says there is no more. Never rejects: HTTP, network
 * and abort failures all come back as a typed result with a message fit to
 * show the user. A dataset with no signals at all is a failure too, because
 * counting against it would report zero signals everywhere.
 */
export async function fetchSignals(options: FetchSignalsOptions = {}): Promise<SignalsResult> {
  const { signal, fetchImpl = fetch, pageSize = SIGNALS_PAGE_SIZE } = options
  const byId = new Map<string, SignalPoint>()
  let offset = 0
  for (let page = 0; page < MAX_PAGES; page++) {
    let status: number
    let body: unknown = null
    try {
      // No cookies and no referrer: the server only needs the query itself.
      const response = await fetchImpl(buildSignalsUrl(offset, pageSize), {
        signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      })
      status = response.status
      body = await response.json().catch(() => null)
    } catch {
      if (signal?.aborted) return ABORTED
      return {
        ok: false,
        kind: 'network',
        message: 'Could not reach the City of Charlotte signal data.',
      }
    }
    if (signal?.aborted) return ABORTED

    const parsed = parseSignalsPage(body)
    if (status < 200 || status >= 300) {
      if (!parsed.ok && parsed.kind === 'api') return parsed
      return {
        ok: false,
        kind: 'api',
        message: `The City of Charlotte signal data is not available right now (HTTP ${status}).`,
      }
    }
    if (!parsed.ok) return parsed
    for (const s of parsed.signals) byId.set(s.id, s)
    // An empty page that claims more would never advance, so it ends the loop too.
    if (!parsed.more || parsed.featureCount === 0) {
      if (byId.size === 0)
        return {
          ok: false,
          kind: 'malformed',
          message: 'The City of Charlotte signal data came back with no traffic signals in it.',
        }
      return { ok: true, signals: [...byId.values()] }
    }
    offset += parsed.featureCount
  }
  return {
    ok: false,
    kind: 'malformed',
    message: 'The City of Charlotte signal data did not finish downloading.',
  }
}

/**
 * The whole city list as it is kept on the device: one record, in a store of
 * its own. The City of Charlotte data is licensed CC BY-NC-SA 4.0, so it is
 * never written next to, or merged on disk with, any other signal source.
 */
export interface CharlotteSnapshot {
  /** When the list was downloaded, in milliseconds since 1970. */
  readonly fetchedAt: number
  readonly signals: readonly SignalPoint[]
}

/** True for a well-formed snapshot, such as one read back from the device. */
export function isCharlotteSnapshot(value: unknown): value is CharlotteSnapshot {
  if (typeof value !== 'object' || value === null) return false
  const { fetchedAt, signals } = value as Record<string, unknown>
  if (typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt) || !Array.isArray(signals)) return false
  return (signals as unknown[]).every((s) => {
    if (typeof s !== 'object' || s === null) return false
    const { id, position, name } = s as Record<string, unknown>
    return (
      typeof id === 'string' &&
      Array.isArray(position) &&
      typeof position[0] === 'number' &&
      typeof position[1] === 'number' &&
      isValidLngLat([position[0], position[1]]) &&
      (name === null || typeof name === 'string')
    )
  })
}

/** A stored list older than this is still used, and downloaded again in the background: about a month. */
export const SIGNALS_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** The key the one snapshot is stored under. */
const SNAPSHOT_KEY = 'all'

export interface SignalSessionCache {
  /** Where the snapshot is kept between visits. */
  store: KeyValueStore<CharlotteSnapshot>
  /** The clock, in milliseconds. */
  now?: () => number
  ttlMs?: number
}

/** Where the seed snapshot is served from, under the site root. */
export const CHARLOTTE_SEED_PATH = 'seed/charlotte-signals/signals.json'

/**
 * Reads the seed snapshot: the city list as the seed script
 * (scripts/seed-charlotte.mjs) last saved it, served by this site as a static
 * file of its own (never in a file with any other signal source; see the
 * LICENSE.md next to it). Null when there is none or it cannot be read.
 * Never rejects. Nothing about the trip is in the request.
 */
export async function fetchSeedSnapshot(url: string, fetchImpl: typeof fetch = fetch): Promise<CharlotteSnapshot | null> {
  try {
    const response = await fetchImpl(url, { credentials: 'omit' })
    if (!response.ok) return null
    const body: unknown = await response.json()
    return isCharlotteSnapshot(body) && body.signals.length > 0 ? body : null
  } catch {
    return null
  }
}

export interface SignalSession {
  /**
   * The city's signals: answered from memory once loaded, for as long as the
   * page stays open. Calls made while a load is running share it. A failure
   * is not remembered, so the next call tries again.
   */
  load: () => Promise<SignalsResult>
}

/**
 * A once-per-session memory cache around fetchSignals, optionally backed by
 * a store on the device.
 *
 * Without `cache`, nothing is written anywhere and reloading the page
 * downloads the list again. With it, the list is read from the store first:
 * if it is there no request is made, unless it is older than `ttlMs`, in
 * which case it is used as it is and downloaded again in the background (a
 * download that fails leaves the stored list in place). Only when the store
 * has nothing is the list downloaded before answering, and then stored.
 *
 * With `seed`, a download that fails when there is nothing else to answer
 * with falls back on the seed snapshot shipped with the app. The seed is
 * never written to the store and never remembered as the answer: the next
 * call tries the city's server again, and only a real download is kept.
 */
export function createSignalSession(
  fetchAll: () => Promise<SignalsResult> = fetchSignals,
  cache: SignalSessionCache | null = null,
  seed: (() => Promise<CharlotteSnapshot | null>) | null = null,
): SignalSession {
  const now = cache?.now ?? Date.now
  const ttlMs = cache?.ttlMs ?? SIGNALS_TTL_MS
  let cached: SignalsResult | null = null
  let pending: Promise<SignalsResult> | null = null

  const download = async (): Promise<SignalsResult> => {
    const result = await fetchAll()
    if (result.ok) {
      cached = result
      await cache?.store.put(SNAPSHOT_KEY, { fetchedAt: now(), signals: result.signals })
    }
    return result
  }
  const loadOnce = async (): Promise<SignalsResult> => {
    const stored = cache === null ? null : await cache.store.get(SNAPSHOT_KEY)
    if (stored === null || stored.signals.length === 0) {
      const result = await download()
      if (result.ok || result.kind === 'aborted' || seed === null) return result
      const shipped = await seed().catch(() => null)
      return shipped === null || shipped.signals.length === 0 ? result : { ok: true, signals: shipped.signals }
    }
    cached = { ok: true, signals: stored.signals }
    if (now() - stored.fetchedAt > ttlMs) void download()
    return cached
  }

  return {
    load() {
      if (cached !== null) return Promise.resolve(cached)
      pending ??= loadOnce().then((result) => {
        pending = null
        return result
      })
      return pending
    },
  }
}

/**
 * The one session the app uses. The list is kept in its own IndexedDB
 * database on the device (memory only where IndexedDB is not available).
 * When the city's server cannot be reached and nothing is stored yet, the
 * seed snapshot served with the app stands in.
 */
export const signalSession: SignalSession = createSignalSession(
  fetchSignals,
  { store: indexedDbStore('routeiq-charlotte-signals', 'snapshot', isCharlotteSnapshot) },
  () => fetchSeedSnapshot(`${import.meta.env?.BASE_URL ?? '/'}${CHARLOTTE_SEED_PATH}`),
)
