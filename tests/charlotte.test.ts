import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseSignalsPage, type SignalsPageResult } from '../src/providers/charlotte/adapter.ts'
import {
  buildSignalsUrl,
  createSignalSession,
  fetchSignals,
  isCharlotteSnapshot,
  SIGNALS_LAYER_URL,
  SIGNALS_TTL_MS,
  type CharlotteSnapshot,
  type SignalsResult,
} from '../src/providers/charlotte/client.ts'
import { memoryStore } from '../src/storage/kv.ts'

// Hand-written bodies shaped like the City of Charlotte "Traffic Signals" layer
// answering a f=geojson query. No test here touches the network.
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8'))
}
const PAGE_1 = fixture('signals.page1.json') as { features: Record<string, unknown>[] }
const PAGE_2 = fixture('signals.page2.json')
const ERROR = fixture('signals.error.json')

function pageOf(result: SignalsPageResult) {
  if (!result.ok) throw new Error(`expected a page, got ${result.kind}`)
  return result
}

function signalsOf(result: SignalsResult) {
  if (!result.ok) throw new Error(`expected signals, got ${result.kind}`)
  return result.signals
}

function failureOf(result: SignalsPageResult | SignalsResult) {
  if (result.ok) throw new Error('expected a failure')
  return result
}

const feature = (properties: unknown, geometry: unknown = { type: 'Point', coordinates: [-80.84, 35.22] }) => ({
  type: 'Feature',
  geometry,
  properties,
})
const collection = (features: unknown[], more = false) => ({
  type: 'FeatureCollection',
  ...(more ? { properties: { exceededTransferLimit: true } } : {}),
  features,
})
const SIGNAL = { OBJECTID: 1, UNITTYPE: 'TSL', SERVSTAT: 'OP', UNITDESC: 'A ST_B ST' }

describe('parseSignalsPage', () => {
  it('keeps operating traffic signals and says when more pages follow', () => {
    const page = pageOf(parseSignalsPage(PAGE_1))
    expect(page.featureCount).toBe(4)
    expect(page.more).toBe(true)
    expect(page.signals).toEqual([
      { id: 'clt-101', position: [-80.8431, 35.2271], name: 'FIXTURE TRADE ST_FIXTURE TRYON ST' },
      // Codes and names are trimmed, and codes compared without regard to case.
      { id: 'clt-104', position: [-80.8436, 35.2201], name: 'FIXTURE 3RD ST_FIXTURE COLLEGE ST' },
    ])
  })

  it('reads the last page: no transfer-limit flag, a null name stays null', () => {
    const page = pageOf(parseSignalsPage(PAGE_2))
    expect(page.more).toBe(false)
    expect(page.featureCount).toBe(3)
    expect(page.signals.map((s) => s.id)).toEqual(['clt-104', 'clt-105'])
    expect(page.signals[1]!.name).toBeNull()
  })

  it('leaves out flashers, beacons and signals that are not operating', () => {
    const others = ['SF', 'SFS', 'MSF', 'MPB', 'MPS', 'MPCS', 'RRFB', 'ES', 'SWSF', 'PWFS', null, undefined, 7]
    const features = [
      ...others.map((UNITTYPE, i) => feature({ ...SIGNAL, OBJECTID: 10 + i, UNITTYPE })),
      feature({ ...SIGNAL, OBJECTID: 50, SERVSTAT: 'NOP' }),
      feature({ ...SIGNAL, OBJECTID: 51, SERVSTAT: null }),
      feature({ ...SIGNAL, OBJECTID: 52, UNITTYPE: 'TS' }),
      feature({ ...SIGNAL, OBJECTID: 53, UNITTYPE: 'TSV' }),
    ]
    const page = pageOf(parseSignalsPage(collection(features)))
    expect(page.signals.map((s) => s.id)).toEqual(['clt-52', 'clt-53'])
    expect(page.featureCount).toBe(features.length)
  })

  it('skips malformed features without failing the page', () => {
    const features = [
      null,
      'feature',
      { type: 'Feature' },
      feature(SIGNAL, null),
      feature(SIGNAL, { type: 'Point', coordinates: [] }),
      feature(SIGNAL, { type: 'Point', coordinates: ['-80.84', '35.22'] }),
      feature(SIGNAL, { type: 'Point', coordinates: [-80.84, 95] }),
      feature(SIGNAL, { type: 'LineString', coordinates: [[-80.84, 35.22], [-80.83, 35.22]] }),
      // A point in the layer's own State Plane feet, as it comes without outSR=4326.
      feature(SIGNAL, { type: 'Point', coordinates: [1449000.5, 542000.25] }),
      feature({ ...SIGNAL, OBJECTID: undefined }),
      feature({ ...SIGNAL, OBJECTID: 2 }),
    ]
    const page = pageOf(parseSignalsPage(collection(features)))
    expect(page.signals).toEqual([{ id: 'clt-2', position: [-80.84, 35.22], name: 'A ST_B ST' }])
    expect(page.featureCount).toBe(features.length)
  })

  it('reports an ArcGIS error body with its code and explanation', () => {
    const failure = failureOf(parseSignalsPage(ERROR))
    expect(failure.kind).toBe('api')
    expect(failure.message).toContain('400')
    expect(failure.message).toContain('Invalid field: BOGUS')
    const withMessage = failureOf(parseSignalsPage({ error: { code: 503, message: 'Service unavailable' } }))
    expect(withMessage.message).toContain('Service unavailable')
    expect(failureOf(parseSignalsPage({ error: {} })).kind).toBe('api')
  })

  it('reports anything else as malformed instead of throwing', () => {
    const bodies = [null, undefined, 'x', 42, [], {}, { type: 'FeatureCollection' }, { type: 'Feature', features: [] }, { features: [] }]
    for (const body of bodies) {
      expect(failureOf(parseSignalsPage(body)).kind, JSON.stringify(body)).toBe('malformed')
    }
  })
})

describe('buildSignalsUrl', () => {
  it('asks the layer for everything, in WGS84 GeoJSON, in a stable order', () => {
    const url = new URL(buildSignalsUrl(0))
    expect(url.origin + url.pathname).toBe(`${SIGNALS_LAYER_URL}/query`)
    expect(url.searchParams.get('where')).toBe('1=1')
    expect(url.searchParams.get('outFields')).toBe('OBJECTID,UNITTYPE,SERVSTAT,UNITDESC')
    expect(url.searchParams.get('outSR')).toBe('4326')
    expect(url.searchParams.get('f')).toBe('geojson')
    expect(url.searchParams.get('orderByFields')).toBe('OBJECTID')
    expect(url.searchParams.get('resultOffset')).toBe('0')
    expect(url.searchParams.get('resultRecordCount')).toBe('2000')
  })

  it('has no way to carry a location: only the page offset ever changes', () => {
    const names = (u: string) => [...new URL(u).searchParams.keys()].sort()
    expect(names(buildSignalsUrl(0))).toEqual(
      ['f', 'orderByFields', 'outFields', 'outSR', 'resultOffset', 'resultRecordCount', 'where'],
    )
    const next = new URL(buildSignalsUrl(2000, 500))
    expect(next.searchParams.get('resultOffset')).toBe('2000')
    expect(next.searchParams.get('resultRecordCount')).toBe('500')
    next.searchParams.delete('resultOffset')
    next.searchParams.delete('resultRecordCount')
    const first = new URL(buildSignalsUrl(0))
    first.searchParams.delete('resultOffset')
    first.searchParams.delete('resultRecordCount')
    expect(next.toString()).toBe(first.toString())
  })
})

describe('fetchSignals', () => {
  /** Stands in for fetch: records each call and answers with the next canned response. */
  function fakeFetch(...responses: { status?: number; body: unknown }[]) {
    const calls: { url: string; init: RequestInit | undefined }[] = []
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
      const { status = 200, body } = responses[Math.min(calls.length, responses.length - 1)]!
      calls.push({ url: String(input), init })
      const text = typeof body === 'string' ? body : JSON.stringify(body)
      return Promise.resolve(new Response(text, { status }))
    }) as typeof fetch
    return { fetchImpl, calls }
  }
  const offsets = (calls: { url: string }[]) => calls.map((c) => new URL(c.url).searchParams.get('resultOffset'))

  it('follows paging to the end and returns each signal once', async () => {
    const { fetchImpl, calls } = fakeFetch({ body: PAGE_1 }, { body: PAGE_2 })
    const signals = signalsOf(await fetchSignals({ fetchImpl, pageSize: 4 }))
    // Signal 104 is on both pages (a record shifted between requests); it is kept once.
    expect(signals.map((s) => s.id)).toEqual(['clt-101', 'clt-104', 'clt-105'])
    // The second page starts after the four features of the first, filtered out or not.
    expect(offsets(calls)).toEqual(['0', '4'])
    expect(calls.every((c) => new URL(c.url).searchParams.get('resultRecordCount') === '4')).toBe(true)
  })

  it('makes one request when everything fits on a page', async () => {
    const { fetchImpl, calls } = fakeFetch({ body: PAGE_2 })
    expect(signalsOf(await fetchSignals({ fetchImpl }))).toHaveLength(2)
    expect(calls).toHaveLength(1)
  })

  it('sends no cookies or referrer, and passes the abort signal on', async () => {
    const { fetchImpl, calls } = fakeFetch({ body: PAGE_2 })
    const controller = new AbortController()
    await fetchSignals({ fetchImpl, signal: controller.signal })
    expect(calls[0]!.init?.signal).toBe(controller.signal)
    expect(calls[0]!.init?.credentials).toBe('omit')
    expect(calls[0]!.init?.referrerPolicy).toBe('no-referrer')
    expect(calls[0]!.init?.method).toBeUndefined()
    expect(calls[0]!.init?.body).toBeUndefined()
  })

  it('reports an error body, even with HTTP 200, and on any page', async () => {
    expect(failureOf(await fetchSignals(fakeFetch({ body: ERROR }))).kind).toBe('api')
    const midway = failureOf(await fetchSignals(fakeFetch({ body: PAGE_1 }, { body: ERROR })))
    expect(midway.kind).toBe('api')
    expect(midway.message).toContain('Invalid field')
  })

  it('reports HTTP failures, keeping the server explanation when there is one', async () => {
    const down = failureOf(await fetchSignals(fakeFetch({ status: 503, body: 'Service Unavailable' })))
    expect(down.kind).toBe('api')
    expect(down.message).toContain('HTTP 503')
    const explained = failureOf(await fetchSignals(fakeFetch({ status: 400, body: ERROR })))
    expect(explained.message).toContain('Invalid field')
    // A page that parses is still not trusted when the status says the request failed.
    expect(failureOf(await fetchSignals(fakeFetch({ status: 500, body: PAGE_2 }))).kind).toBe('api')
  })

  it('reports a 200 that is not a feature page as malformed', async () => {
    const result = await fetchSignals(fakeFetch({ body: '<html>proxy login</html>' }))
    expect(failureOf(result).kind).toBe('malformed')
  })

  it('treats a dataset with no traffic signals as a failure, not as zero signals', async () => {
    const empty = failureOf(await fetchSignals(fakeFetch({ body: collection([]) })))
    expect(empty.kind).toBe('malformed')
    const flashersOnly = collection([feature({ ...SIGNAL, UNITTYPE: 'SF' })])
    expect(failureOf(await fetchSignals(fakeFetch({ body: flashersOnly }))).kind).toBe('malformed')
  })

  it('stops when the server keeps promising more', async () => {
    const emptyButMore = fakeFetch({ body: PAGE_1 }, { body: collection([], true) })
    expect(signalsOf(await fetchSignals(emptyButMore))).toHaveLength(2)
    expect(emptyButMore.calls).toHaveLength(2)

    const endless = fakeFetch({ body: collection([feature(SIGNAL)], true) })
    expect(failureOf(await fetchSignals(endless)).kind).toBe('malformed')
    expect(endless.calls).toHaveLength(50)
    expect(offsets(endless.calls).slice(0, 3)).toEqual(['0', '1', '2'])
  })

  it('reports a network failure', async () => {
    const fetchImpl = (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch
    const result = failureOf(await fetchSignals({ fetchImpl }))
    expect(result.kind).toBe('network')
    expect(result.message).toContain('City of Charlotte')
  })

  it('reports an aborted request as aborted, before or during the fetch', async () => {
    const controller = new AbortController()
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })) as typeof fetch
    const pending = fetchSignals({ signal: controller.signal, fetchImpl })
    controller.abort()
    expect(failureOf(await pending).kind).toBe('aborted')

    const late = fetchSignals({ signal: controller.signal, ...fakeFetch({ body: PAGE_2 }) })
    expect(failureOf(await late).kind).toBe('aborted')
  })
})

describe('createSignalSession', () => {
  const ok: SignalsResult = { ok: true, signals: [{ id: 'clt-1', position: [-80.84, 35.22], name: null }] }
  const failed: SignalsResult = { ok: false, kind: 'network', message: 'offline' }

  it('downloads once and answers later calls from memory', async () => {
    let downloads = 0
    const session = createSignalSession(() => {
      downloads++
      return Promise.resolve(ok)
    })
    const [a, b] = await Promise.all([session.load(), session.load()])
    const c = await session.load()
    expect(downloads).toBe(1)
    expect(a).toBe(ok)
    expect(b).toBe(ok)
    expect(c).toBe(ok)
  })

  it('does not remember a failure, so the next call tries again', async () => {
    const answers = [failed, failed, ok]
    let downloads = 0
    const session = createSignalSession(() => Promise.resolve(answers[downloads++]!))
    expect((await session.load()).ok).toBe(false)
    expect((await session.load()).ok).toBe(false)
    expect((await session.load()).ok).toBe(true)
    expect((await session.load()).ok).toBe(true)
    expect(downloads).toBe(3)
  })
})

describe('createSignalSession with a store on the device', () => {
  const DAY_MS = 24 * 60 * 60 * 1000
  const NOW = 1_800_000_000_000
  const old: SignalsResult = { ok: true, signals: [{ id: 'clt-1', position: [-80.84, 35.22], name: 'A ST_B ST' }] }
  const fresh: SignalsResult = {
    ok: true,
    signals: [
      { id: 'clt-1', position: [-80.84, 35.22], name: 'A ST_B ST' },
      { id: 'clt-2', position: [-80.83, 35.21], name: null },
    ],
  }
  const failed: SignalsResult = { ok: false, kind: 'network', message: 'offline' }
  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }
  /** A download stand-in that counts its calls. */
  function downloader(...answers: SignalsResult[]) {
    let calls = 0
    const fetchAll = () => Promise.resolve(answers[Math.min(calls++, answers.length - 1)]!)
    return { fetchAll, calls: () => calls }
  }

  it('stores the list after the first download and does not download on the next visit', async () => {
    const store = memoryStore<CharlotteSnapshot>()
    const first = downloader(old)
    expect(await createSignalSession(first.fetchAll, { store, now: () => NOW }).load()).toEqual(old)
    expect(await store.get('all')).toEqual({ fetchedAt: NOW, signals: old.signals })
    // A new session is a new page load, two weeks later.
    const second = downloader(fresh)
    const session = createSignalSession(second.fetchAll, { store, now: () => NOW + 14 * DAY_MS })
    expect(await session.load()).toEqual(old)
    expect(await session.load()).toEqual(old)
    await flush()
    expect(second.calls()).toBe(0)
  })

  it('serves a stored list older than a month at once, and downloads a new one in the background', async () => {
    expect(SIGNALS_TTL_MS).toBe(30 * DAY_MS)
    const store = memoryStore<CharlotteSnapshot>()
    await store.put('all', { fetchedAt: NOW - 31 * DAY_MS, signals: old.signals })
    const download = downloader(fresh)
    const session = createSignalSession(download.fetchAll, { store, now: () => NOW })
    expect(await session.load()).toEqual(old)
    await flush()
    expect(download.calls()).toBe(1)
    expect(await store.get('all')).toEqual({ fetchedAt: NOW, signals: fresh.signals })
    // The session has the new list too, without another download.
    expect(await session.load()).toEqual(fresh)
    expect(download.calls()).toBe(1)
  })

  it('keeps the stored list when the background download fails', async () => {
    const store = memoryStore<CharlotteSnapshot>()
    const stale = { fetchedAt: NOW - 90 * DAY_MS, signals: old.signals }
    await store.put('all', stale)
    const download = downloader(failed)
    const session = createSignalSession(download.fetchAll, { store, now: () => NOW })
    expect(await session.load()).toEqual(old)
    await flush()
    expect(await session.load()).toEqual(old)
    expect(await store.get('all')).toEqual(stale)
    expect(download.calls()).toBe(1)
  })

  it('reports a failed first download, stores nothing, and tries again next time', async () => {
    const store = memoryStore<CharlotteSnapshot>()
    const download = downloader(failed, old)
    const session = createSignalSession(download.fetchAll, { store, now: () => NOW })
    expect(await session.load()).toEqual(failed)
    expect(await store.get('all')).toBeNull()
    expect(await session.load()).toEqual(old)
    expect(download.calls()).toBe(2)
  })

  it('checks what it reads back from the device', () => {
    expect(isCharlotteSnapshot({ fetchedAt: NOW, signals: old.signals })).toBe(true)
    expect(isCharlotteSnapshot({ fetchedAt: NOW, signals: [] })).toBe(true)
    for (const bad of [
      null,
      'list',
      {},
      { fetchedAt: 'yesterday', signals: [] },
      { fetchedAt: NOW, signals: 'many' },
      { fetchedAt: NOW, signals: [{ id: 1, position: [-80.84, 35.22], name: null }] },
      { fetchedAt: NOW, signals: [{ id: 'clt-1', position: [-80.84, 95], name: null }] },
      { fetchedAt: NOW, signals: [{ id: 'clt-1', position: [-80.84, 35.22] }] },
      // An OpenStreetMap tile is not a city snapshot: the two stores cannot be read as each other.
      { tileId: '-809_352', fetchedAt: NOW, nodes: [] },
    ]) {
      expect(isCharlotteSnapshot(bad)).toBe(false)
    }
  })
})
