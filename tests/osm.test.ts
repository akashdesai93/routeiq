import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildOverpassQuery,
  isOsmSignalTile,
  osmSignalPoints,
  parseOverpassSignals,
  type OsmSignalTile,
} from '../src/providers/osm/adapter.ts'
import {
  createOverpassClient,
  fetchSignalTile,
  isOverpassPause,
  OVERPASS_COOLDOWN_MS,
  OVERPASS_ENDPOINT,
  OVERPASS_MAX_CONCURRENT,
  type OsmTileResult,
  type OverpassPause,
} from '../src/providers/osm/client.ts'
import { memoryBundleLayer } from '../src/providers/osm/bundleLayer.ts'
import {
  createTileSource,
  memoryTileStore,
  overpassLayer,
  TILE_TTL_MS,
  tileStoreFrom,
  type TileLayer,
} from '../src/providers/osm/tileSource.ts'
import { memoryStore } from '../src/storage/kv.ts'
import { fakeClock, fakeOverpass, overpassBody, settle } from './helpers/overpass.ts'

// Hand-written bodies shaped like Overpass API JSON answers. No test here touches the network.
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8'))
}
const TILE_BODY = fixture('overpass.tile.json')
const TIMEOUT_BODY = fixture('overpass.timeout.json')

/** Uptown Charlotte's tile, and the one south of it. */
const UPTOWN = '-809_352'
const SOUTH = '-809_351'
const UPTOWN_QUERY = '[out:json][timeout:25];node[highway=traffic_signals](35.2,-80.9,35.3,-80.8);out;'

function tileOf(result: OsmTileResult) {
  if (!result.ok) throw new Error(`expected a tile, got ${result.kind}`)
  return result.tile
}

function failureOf(result: OsmTileResult) {
  if (result.ok) throw new Error('expected a failure')
  return result
}

const DAY_MS = 24 * 60 * 60 * 1000

describe('buildOverpassQuery', () => {
  it('asks for the traffic signal nodes inside the tile box, south,west,north,east', () => {
    expect(buildOverpassQuery(UPTOWN)).toBe(UPTOWN_QUERY)
    expect(buildOverpassQuery('0_0')).toBe('[out:json][timeout:25];node[highway=traffic_signals](0.0,0.0,0.1,0.1);out;')
    expect(buildOverpassQuery('-1_-1')).toBe(
      '[out:json][timeout:25];node[highway=traffic_signals](-0.1,-0.1,0.0,0.0);out;',
    )
    expect(buildOverpassQuery('1512_-339')).toBe(
      '[out:json][timeout:25];node[highway=traffic_signals](-33.9,151.2,-33.8,151.3);out;',
    )
  })

  it('is null for anything that is not a tile id', () => {
    expect(buildOverpassQuery('')).toBeNull()
    expect(buildOverpassQuery('35.2,-80.9')).toBeNull()
    expect(buildOverpassQuery('1800_0')).toBeNull()
  })
})

describe('parseOverpassSignals', () => {
  it('keeps each usable node once and skips everything else', () => {
    const parsed = parseOverpassSignals(TILE_BODY)
    if (!parsed.ok) throw new Error('expected nodes')
    // The fixture also holds a repeated node, a way, a text id, a latitude of 95, a node with no latitude, junk
    // and four nodes with an excluded signal subtype.
    expect(parsed.nodes).toEqual([
      { id: 9000001, lng: -80.8502, lat: 35.2501 },
      { id: 9000002, lng: -80.8504, lat: 35.2503 },
      { id: 9000003, lng: -80.8301, lat: 35.2702 },
      { id: 9000012, lng: -80.8516, lat: 35.2515 },
      { id: 9000013, lng: -80.8517, lat: 35.2516 },
    ])
  })

  it('leaves out excluded signal subtypes, as bundled tiles do', () => {
    const parsed = parseOverpassSignals(TILE_BODY)
    if (!parsed.ok) throw new Error('expected nodes')
    const ids = parsed.nodes.map((node) => node.id)
    // blinker, emergency, pedestrian_crossing (any case) and a list of only excluded kinds are dropped.
    for (const dropped of [9000008, 9000009, 9000010, 9000011]) expect(ids).not.toContain(dropped)
    // An ordinary subtype, and a list with at least one ordinary kind, are kept.
    expect(ids).toEqual(expect.arrayContaining([9000012, 9000013]))
  })

  it('reads a tile without signals as empty, not as a failure', () => {
    expect(parseOverpassSignals({ version: 0.6, elements: [] })).toEqual({ ok: true, nodes: [] })
  })

  it('treats a timeout remark as a failure, never as a short tile', () => {
    const parsed = parseOverpassSignals(TIMEOUT_BODY)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.kind).toBe('busy')
  })

  it('reports anything else as malformed instead of throwing', () => {
    for (const body of [null, undefined, 'busy', 7, [], {}, { elements: 'none' }, { remark: 'x' }]) {
      const parsed = parseOverpassSignals(body)
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.kind).toBe('malformed')
    }
  })
})

describe('isOsmSignalTile and osmSignalPoints', () => {
  const tile: OsmSignalTile = { tileId: UPTOWN, fetchedAt: 1_800_000_000_000, nodes: [{ id: 5, lng: -80.85, lat: 35.25 }] }

  it('accepts a well-formed tile, such as a seed file, and nothing else', () => {
    expect(isOsmSignalTile(tile)).toBe(true)
    expect(isOsmSignalTile({ ...tile, nodes: [] })).toBe(true)
    // The JSON shape a seed file has, read from text.
    const fromFile: unknown = JSON.parse(
      '{ "tileId": "-809_352", "fetchedAt": 1794355200000, "nodes": [{ "id": 123, "lng": -80.8431, "lat": 35.2271 }] }',
    )
    expect(isOsmSignalTile(fromFile)).toBe(true)
    for (const bad of [
      null,
      'tile',
      {},
      { ...tile, tileId: 'uptown' },
      { ...tile, tileId: 7 },
      { ...tile, fetchedAt: '2026-11-01' },
      { ...tile, fetchedAt: NaN },
      { ...tile, nodes: null },
      { ...tile, nodes: [{ id: '5', lng: -80.85, lat: 35.25 }] },
      { ...tile, nodes: [{ id: 5, lng: -80.85, lat: 95 }] },
      { ...tile, nodes: [[5, -80.85, 35.25]] },
    ]) {
      expect(isOsmSignalTile(bad)).toBe(false)
    }
  })

  it('turns tiles into signal points, each node once however many tiles list it', () => {
    const east: OsmSignalTile = {
      tileId: '-808_352',
      fetchedAt: 1,
      // Node 5 sits on the shared edge and came back from both tiles.
      nodes: [{ id: 6, lng: -80.79, lat: 35.25 }, { id: 5, lng: -80.85, lat: 35.25 }],
    }
    expect(osmSignalPoints([tile, east])).toEqual([
      { id: 'osm-5', position: [-80.85, 35.25], name: null },
      { id: 'osm-6', position: [-80.79, 35.25], name: null },
    ])
    expect(osmSignalPoints([])).toEqual([])
  })
})

describe('fetchSignalTile', () => {
  it('posts the tile query, and nothing else, to the Overpass endpoint', async () => {
    const { fetchImpl, calls } = fakeOverpass({ [UPTOWN]: [[11, -80.85, 35.25]] })
    const clock = fakeClock()
    const tile = tileOf(await fetchSignalTile(UPTOWN, { fetchImpl, now: clock.now }))
    expect(tile).toEqual({ tileId: UPTOWN, fetchedAt: clock.now(), nodes: [{ id: 11, lng: -80.85, lat: 35.25 }] })

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(OVERPASS_ENDPOINT).toBe('https://overpass-api.de/api/interpreter')
    // Nothing rides along in the URL.
    expect(call.url).toBe(OVERPASS_ENDPOINT)
    expect(call.init?.method).toBe('POST')
    // The body is one form field, the query, and the query is the tile box and fixed text.
    expect(call.init?.body).toBeInstanceOf(URLSearchParams)
    expect([...new URLSearchParams(call.body).keys()]).toEqual(['data'])
    expect(call.query).toBe(UPTOWN_QUERY)
    // No cookies. The referrer is cut down to the origin, not removed: the server requires one from browsers.
    expect(call.init?.credentials).toBe('omit')
    expect(call.init?.referrerPolicy).toBe('origin')
    // No custom headers, so the browser sends it cross-origin without a preflight request.
    expect(call.init?.headers).toBeUndefined()
  })

  it('uses another endpoint when given one', async () => {
    const { fetchImpl, calls } = fakeOverpass()
    await fetchSignalTile(UPTOWN, { fetchImpl, endpoint: 'https://overpass.example/api/interpreter' })
    expect(calls[0]!.url).toBe('https://overpass.example/api/interpreter')
  })

  it('reads a real-shaped answer, and an empty tile as empty', async () => {
    const answer = (body: unknown) => (() => Promise.resolve(new Response(JSON.stringify(body)))) as typeof fetch
    expect(tileOf(await fetchSignalTile(UPTOWN, { fetchImpl: answer(TILE_BODY) })).nodes).toHaveLength(5)
    expect(tileOf(await fetchSignalTile(UPTOWN, { fetchImpl: answer(overpassBody([])) })).nodes).toEqual([])
  })

  it('reports rate limiting and a server at capacity as busy, with the wait the server asked for', async () => {
    for (const status of [429, 502, 503, 504]) {
      const failure = failureOf(await fetchSignalTile(UPTOWN, { fetchImpl: fakeOverpass({ [UPTOWN]: status }).fetchImpl }))
      expect(failure.kind).toBe('busy')
      expect(failure.message).toContain(String(status))
      expect(failure.retryAfterSec).toBeUndefined()
    }
    const withHeader = (() =>
      Promise.resolve(new Response('Too many requests', { status: 429, headers: { 'Retry-After': '120' } }))) as typeof fetch
    expect(failureOf(await fetchSignalTile(UPTOWN, { fetchImpl: withHeader })).retryAfterSec).toBe(120)
    // A timeout reported inside a 200 answer is busy too.
    const remark = (() => Promise.resolve(new Response(JSON.stringify(TIMEOUT_BODY)))) as typeof fetch
    expect(failureOf(await fetchSignalTile(UPTOWN, { fetchImpl: remark })).kind).toBe('busy')
  })

  it('reports other HTTP errors, unreadable answers and network failures', async () => {
    const refused = failureOf(await fetchSignalTile(UPTOWN, { fetchImpl: fakeOverpass({ [UPTOWN]: 406 }).fetchImpl }))
    expect(refused.kind).toBe('api')
    expect(refused.message).toContain('406')
    const html = (() => Promise.resolve(new Response('<html>hello</html>'))) as typeof fetch
    expect(failureOf(await fetchSignalTile(UPTOWN, { fetchImpl: html })).kind).toBe('malformed')
    const offline = (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch
    const failure = failureOf(await fetchSignalTile(UPTOWN, { fetchImpl: offline }))
    expect(failure.kind).toBe('network')
    expect(failure.message).not.toContain('Failed to fetch')
  })

  it('reports an aborted request as aborted, before or during the fetch', async () => {
    const before = new AbortController()
    before.abort()
    const { fetchImpl, calls } = fakeOverpass()
    expect(failureOf(await fetchSignalTile(UPTOWN, { fetchImpl, signal: before.signal })).kind).toBe('aborted')
    expect(calls).toHaveLength(0)

    const during = new AbortController()
    const hanging = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })) as typeof fetch
    const pending = fetchSignalTile(UPTOWN, { fetchImpl: hanging, signal: during.signal })
    during.abort()
    expect(failureOf(await pending).kind).toBe('aborted')
  })

  it('gives up on a server that holds the connection open, and counts that as busy', async () => {
    const hanging = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })) as typeof fetch
    const failure = failureOf(await fetchSignalTile(UPTOWN, { fetchImpl: hanging, timeoutMs: 5 }))
    expect(failure.kind).toBe('busy')
    expect(failure.message).toContain('did not answer in time')
    // So the polite client pauses after it, like after a 429.
    const clock = fakeClock()
    let sent = 0
    const counting = ((...args: Parameters<typeof fetch>) => {
      sent++
      return hanging(...args)
    }) as typeof fetch
    const client = createOverpassClient({ fetchImpl: counting, now: clock.now, timeoutMs: 5 })
    await client.fetchTile(UPTOWN)
    await client.fetchTile(SOUTH)
    expect(sent).toBe(1)
  })

  it('does not call fetch for something that is not a tile', async () => {
    const { fetchImpl, calls } = fakeOverpass()
    expect(failureOf(await fetchSignalTile('everywhere', { fetchImpl })).kind).toBe('malformed')
    expect(calls).toHaveLength(0)
  })
})

describe('createOverpassClient', () => {
  /** A fetch whose answers the test releases one by one. */
  function gatedFetch() {
    const waiting: (() => void)[] = []
    let started = 0
    const fetchImpl = (() => {
      started++
      return new Promise<Response>((resolve) => {
        waiting.push(() => resolve(new Response(JSON.stringify(overpassBody([])))))
      })
    }) as typeof fetch
    return { fetchImpl, started: () => started, release: () => waiting.shift()?.() }
  }

  it('keeps at most two requests in flight and lets the rest wait their turn', async () => {
    expect(OVERPASS_MAX_CONCURRENT).toBe(2)
    const gate = gatedFetch()
    const client = createOverpassClient({ fetchImpl: gate.fetchImpl })
    const all = ['1_1', '2_2', '3_3', '4_4', '5_5'].map((id) => client.fetchTile(id))
    await settle()
    expect(gate.started()).toBe(2)
    gate.release()
    await settle()
    expect(gate.started()).toBe(3)
    gate.release()
    gate.release()
    await settle()
    expect(gate.started()).toBe(5)
    gate.release()
    gate.release()
    expect((await Promise.all(all)).every((r) => r.ok)).toBe(true)
    expect(gate.started()).toBe(5)
  })

  it('shares one request between callers asking for the same tile at once', async () => {
    const { fetchImpl, calls } = fakeOverpass({ [UPTOWN]: [[11, -80.85, 35.25]] })
    const client = createOverpassClient({ fetchImpl })
    const [a, b, c] = await Promise.all([client.fetchTile(UPTOWN), client.fetchTile(UPTOWN), client.fetchTile(SOUTH)])
    expect(calls.map((x) => x.tileId)).toEqual([UPTOWN, SOUTH])
    expect(a).toBe(b)
    expect(tileOf(c).tileId).toBe(SOUTH)
    // Once it has finished, asking again is a new request (remembering tiles is the tile source's job).
    await client.fetchTile(UPTOWN)
    expect(calls).toHaveLength(3)
  })

  it('stops asking for 30 seconds after a busy answer, and doubles the pause while it lasts', async () => {
    expect(OVERPASS_COOLDOWN_MS).toBe(30_000)
    const server = fakeOverpass({ [UPTOWN]: 429 })
    const clock = fakeClock()
    const client = createOverpassClient({ fetchImpl: server.fetchImpl, now: clock.now })

    expect(failureOf(await client.fetchTile(UPTOWN)).kind).toBe('busy')
    expect(server.calls).toHaveLength(1)
    // During the pause nothing is sent, for this tile or any other, and the caller hears at once.
    clock.advance(29_000)
    expect(failureOf(await client.fetchTile(UPTOWN)).kind).toBe('busy')
    expect(failureOf(await client.fetchTile(SOUTH)).kind).toBe('busy')
    expect(server.calls).toHaveLength(1)
    // After it, one request goes out. Still busy: the next pause is 60 seconds.
    clock.advance(2_000)
    expect(failureOf(await client.fetchTile(UPTOWN)).kind).toBe('busy')
    expect(server.calls).toHaveLength(2)
    clock.advance(59_000)
    await client.fetchTile(UPTOWN)
    expect(server.calls).toHaveLength(2)
    // The server recovers: the request after the pause works, and the pause goes back to 30 seconds.
    server.answers.set(UPTOWN, [[11, -80.85, 35.25]])
    clock.advance(2_000)
    expect((await client.fetchTile(UPTOWN)).ok).toBe(true)
    server.answers.set(SOUTH, 504)
    expect(failureOf(await client.fetchTile(SOUTH)).kind).toBe('busy')
    clock.advance(31_000)
    server.answers.set(SOUTH, [])
    expect((await client.fetchTile(SOUTH)).ok).toBe(true)
  })

  it('never pauses for longer than the limit, and waits as long as the server asks', async () => {
    const server = fakeOverpass({ [UPTOWN]: 502 })
    const clock = fakeClock()
    const client = createOverpassClient({ fetchImpl: server.fetchImpl, now: clock.now, cooldownMs: 1000, maxCooldownMs: 4000 })
    // Pauses of 1 s, 2 s, 4 s, then 4 s again.
    for (const pauseMs of [1000, 2000, 4000, 4000]) {
      const before = server.calls.length
      await client.fetchTile(UPTOWN)
      expect(server.calls).toHaveLength(before + 1)
      clock.advance(pauseMs - 1)
      await client.fetchTile(UPTOWN)
      expect(server.calls).toHaveLength(before + 1)
      clock.advance(2)
    }
    // Retry-After: 120 outlasts the 30 second default.
    const asking = (() =>
      Promise.resolve(new Response('', { status: 429, headers: { 'Retry-After': '120' } }))) as typeof fetch
    let sent = 0
    const counting = ((...args: Parameters<typeof fetch>) => {
      sent++
      return asking(...args)
    }) as typeof fetch
    const patient = createOverpassClient({ fetchImpl: counting, now: clock.now })
    await patient.fetchTile(UPTOWN)
    clock.advance(119_000)
    await patient.fetchTile(UPTOWN)
    expect(sent).toBe(1)
    clock.advance(2_000)
    await patient.fetchTile(UPTOWN)
    expect(sent).toBe(2)
  })

  it('fails the tiles already waiting in line when a busy answer arrives, without sending them', async () => {
    const server = fakeOverpass({ '1_1': 429, '2_2': 429 })
    const client = createOverpassClient({ fetchImpl: server.fetchImpl, now: fakeClock().now })
    const results = await Promise.all(['1_1', '2_2', '3_3', '4_4'].map((id) => client.fetchTile(id)))
    expect(results.map((r) => (r.ok ? 'ok' : r.kind))).toEqual(['busy', 'busy', 'busy', 'busy'])
    expect(server.requested()).toEqual(['1_1', '2_2'])
  })

  it('does not pause for failures that waiting would not fix', async () => {
    const server = fakeOverpass({ [UPTOWN]: 406 })
    const client = createOverpassClient({ fetchImpl: server.fetchImpl, now: fakeClock().now })
    expect(failureOf(await client.fetchTile(UPTOWN)).kind).toBe('api')
    expect((await client.fetchTile(SOUTH)).ok).toBe(true)
    expect(server.calls).toHaveLength(2)
  })

  it('remembers the pause across page loads when given somewhere to keep it', async () => {
    const pauseStore = memoryStore<OverpassPause>()
    const server = fakeOverpass({ [UPTOWN]: 429 })
    const clock = fakeClock()
    const options = { fetchImpl: server.fetchImpl, now: clock.now, pauseStore }
    await createOverpassClient(options).fetchTile(UPTOWN)
    await settle()
    expect(await pauseStore.get('pause')).toEqual({ until: clock.now() + 30_000, nextMs: 60_000 })
    // A reload makes a new client. It does not ask before the pause is over...
    clock.advance(10_000)
    const reloaded = createOverpassClient(options)
    expect(failureOf(await reloaded.fetchTile(UPTOWN)).kind).toBe('busy')
    expect(server.calls).toHaveLength(1)
    // ...and once it is, a busy answer continues the doubling instead of starting over.
    clock.advance(21_000)
    await reloaded.fetchTile(UPTOWN)
    expect(server.calls).toHaveLength(2)
    await settle()
    expect(await pauseStore.get('pause')).toEqual({ until: clock.now() + 60_000, nextMs: 120_000 })
    expect(isOverpassPause(await pauseStore.get('pause'))).toBe(true)
    expect(isOverpassPause({ until: 'soon', nextMs: 1 })).toBe(false)
    expect(isOverpassPause(null)).toBe(false)
  })
})

describe('createTileSource without a bundle: cache, then network', () => {
  const node = (id: number) => ({ id, lng: -80.85, lat: 35.25 })
  const tileAt = (tileId: string, fetchedAt: number, ...ids: number[]): OsmSignalTile => ({
    tileId,
    fetchedAt,
    nodes: ids.map(node),
  })
  /** A network layer over the stand-in server, through the real client. */
  function network(answers: Parameters<typeof fakeOverpass>[0] = {}, clock = fakeClock()) {
    const server = fakeOverpass(answers)
    const layer = overpassLayer(createOverpassClient({ fetchImpl: server.fetchImpl, now: clock.now }))
    return { server, layer, clock }
  }

  it('fetches a tile no layer has, once, and keeps it in the cache', async () => {
    const { server, layer, clock } = network({ [UPTOWN]: [[11, -80.85, 35.25]] })
    const cache = memoryTileStore()
    const source = createTileSource({ cache, network: layer, now: clock.now })
    const first = await source.load([UPTOWN, SOUTH])
    expect([...first.tiles.keys()]).toEqual([UPTOWN, SOUTH])
    expect(first.missing).toEqual([])
    expect(first.tiles.get(UPTOWN)!.nodes).toEqual([{ id: 11, lng: -80.85, lat: 35.25 }])
    // A tile with no signals is a loaded tile, not a missing one.
    expect(first.tiles.get(SOUTH)!.nodes).toEqual([])
    expect(server.requested()).toEqual([UPTOWN, SOUTH])
    expect(await cache.get(UPTOWN)).toEqual(first.tiles.get(UPTOWN))

    // Asked again in the same session, and with the id repeated: no request.
    await source.load([UPTOWN, UPTOWN, SOUTH])
    expect(server.calls).toHaveLength(2)
  })

  it('does not fetch a tile that is in the cache, on a later visit either', async () => {
    const clock = fakeClock()
    const cache = memoryTileStore([tileAt(UPTOWN, clock.now() - 3 * DAY_MS, 21)])
    const { server, layer } = network({ [UPTOWN]: [[99, -80.85, 35.25]] }, clock)
    // Two sources on one cache: two visits to the page.
    for (let visit = 0; visit < 2; visit++) {
      const source = createTileSource({ cache, network: layer, now: clock.now })
      const loaded = await source.load([UPTOWN])
      expect(loaded.tiles.get(UPTOWN)!.nodes.map((n) => n.id)).toEqual([21])
      await settle()
    }
    expect(server.calls).toHaveLength(0)
  })

  it('takes a covered tile from the bundle before the cache, and the cache before the network', async () => {
    const clock = fakeClock()
    const bundle = memoryBundleLayer([tileAt(UPTOWN, clock.now() - 60 * DAY_MS, 31)])
    const cache = memoryTileStore([tileAt(UPTOWN, clock.now() - DAY_MS, 30), tileAt(SOUTH, clock.now(), 33)])
    const { server, layer } = network({ '1_1': [[41, 0.15, 0.15]] }, clock)
    const source = createTileSource({ bundle, cache, network: layer, now: clock.now })
    const loaded = await source.load([UPTOWN, SOUTH, '1_1'])
    // The bundle is the authority for the tile it covers, whatever the cache holds and however old it is.
    expect(loaded.tiles.get(UPTOWN)!.nodes.map((n) => n.id)).toEqual([31])
    expect(loaded.tiles.get(SOUTH)!.nodes.map((n) => n.id)).toEqual([33])
    await settle()
    // Only the tile neither had went to the network, and the bundled tile was never refreshed.
    expect(server.requested()).toEqual(['1_1'])
    // A bundled tile is not copied into the cache.
    expect((await cache.get(UPTOWN))!.nodes.map((n) => n.id)).toEqual([30])
  })

  it('serves a stale tile at once and refreshes it in the background', async () => {
    expect(TILE_TTL_MS).toBe(30 * DAY_MS)
    const clock = fakeClock()
    const cache = memoryTileStore([tileAt(UPTOWN, clock.now() - 31 * DAY_MS, 21)])
    const { server, layer } = network({ [UPTOWN]: [[22, -80.85, 35.25]] }, clock)
    const refreshed: string[] = []
    const source = createTileSource({ cache, network: layer, now: clock.now, onRefresh: (t) => refreshed.push(t.tileId) })

    // The stale tile is the answer; nobody waits for the network.
    const first = await source.load([UPTOWN])
    expect(first.tiles.get(UPTOWN)!.nodes.map((n) => n.id)).toEqual([21])
    expect(first.missing).toEqual([])
    await settle()
    // The refresh has replaced it, in the cache and for the next load.
    expect(server.requested()).toEqual([UPTOWN])
    expect(refreshed).toEqual([UPTOWN])
    expect((await cache.get(UPTOWN))!.fetchedAt).toBe(clock.now())
    expect((await source.load([UPTOWN])).tiles.get(UPTOWN)!.nodes.map((n) => n.id)).toEqual([22])
    await settle()
    expect(server.calls).toHaveLength(1)
  })

  it('is fresh up to 30 days, and stale just past them', async () => {
    const clock = fakeClock()
    const { server, layer } = network({}, clock)
    const cache = memoryTileStore([tileAt(UPTOWN, clock.now() - TILE_TTL_MS, 1), tileAt(SOUTH, clock.now() - TILE_TTL_MS - 1, 2)])
    await createTileSource({ cache, network: layer, now: clock.now }).load([UPTOWN, SOUTH])
    await settle()
    expect(server.requested()).toEqual([SOUTH])
    // The limit can be set.
    const hourly = createTileSource({ cache, network: layer, now: clock.now, ttlMs: 60 * 60 * 1000 })
    await hourly.load([UPTOWN])
    await settle()
    expect(server.requested()).toEqual([SOUTH, UPTOWN])
  })

  it('keeps the stale tile when the refresh fails, and tries only once per session', async () => {
    const clock = fakeClock()
    const stale = tileAt(UPTOWN, clock.now() - 90 * DAY_MS, 21)
    const cache = memoryTileStore([stale])
    const { server, layer } = network({ [UPTOWN]: 504 }, clock)
    const refreshed: string[] = []
    const source = createTileSource({ cache, network: layer, now: clock.now, onRefresh: (t) => refreshed.push(t.tileId) })
    for (let i = 0; i < 3; i++) {
      const loaded = await source.load([UPTOWN])
      expect(loaded.tiles.get(UPTOWN)).toEqual(stale)
      expect(loaded.missing).toEqual([])
      await settle()
    }
    expect(server.calls).toHaveLength(1)
    expect(refreshed).toEqual([])
    expect(await cache.get(UPTOWN)).toEqual(stale)
  })

  it('reports a tile no layer could supply as missing, and tries it again once its wait is over', async () => {
    const clock = fakeClock()
    const { server, layer } = network({ [UPTOWN]: 504, [SOUTH]: [[12, -80.85, 35.15]] }, clock)
    const cache = memoryTileStore()
    const source = createTileSource({ cache, network: layer, now: clock.now })
    const first = await source.load([SOUTH, UPTOWN])
    expect([...first.tiles.keys()]).toEqual([SOUTH])
    expect(first.missing).toEqual([UPTOWN])
    expect(await cache.get(UPTOWN)).toBeNull()
    expect(first.partial.size).toBe(0)
    // Asked again straight away (a recount a few seconds later): no request, still missing.
    expect((await source.load([SOUTH, UPTOWN])).missing).toEqual([UPTOWN])
    expect(server.calls).toHaveLength(2)
    // Later, with the server back: the missing tile is fetched, the loaded one is not asked for again.
    server.answers.set(UPTOWN, [[11, -80.85, 35.25]])
    clock.advance(OVERPASS_COOLDOWN_MS + 1)
    const second = await source.load([SOUTH, UPTOWN])
    expect(second.missing).toEqual([])
    expect(server.requested()).toEqual([SOUTH, UPTOWN, UPTOWN])
  })

  it('shares the work between loads that overlap', async () => {
    const { server, layer, clock } = network()
    const source = createTileSource({ cache: memoryTileStore(), network: layer, now: clock.now })
    const [a, b] = await Promise.all([source.load([UPTOWN, SOUTH]), source.load([SOUTH, UPTOWN])])
    expect(server.calls).toHaveLength(2)
    expect(a.tiles.get(UPTOWN)).toBe(b.tiles.get(UPTOWN))
    expect(await source.load([])).toEqual({ tiles: new Map(), missing: [], partial: new Map(), awaitingBundle: [] })
  })

  it('does not trust a layer that answers with the wrong tile, with junk, or by throwing', async () => {
    const clock = fakeClock()
    const wrong: TileLayer = { get: () => Promise.resolve(tileAt(SOUTH, clock.now(), 1)) }
    const junk = { get: () => Promise.resolve({ tileId: UPTOWN, nodes: 'many' }) } as unknown as TileLayer
    const broken: TileLayer = { get: () => Promise.reject(new Error('storage failed')) }
    const put = () => Promise.resolve()
    for (const untrusted of [wrong, junk, broken]) {
      const { server, layer } = network({ [UPTOWN]: [[11, -80.85, 35.25]] }, clock)
      const source = createTileSource({ cache: { get: untrusted.get, put }, network: layer, now: clock.now })
      expect((await source.load([UPTOWN])).tiles.get(UPTOWN)!.nodes.map((n) => n.id)).toEqual([11])
      expect(server.calls).toHaveLength(1)
      // The same from a bundle: what it hands back is not taken for the tile, and a bundle that
      // cannot even say what it covers has not said "not covered": the tile is missing, and the
      // network is not asked for it (#72).
      const bundled = createTileSource({
        bundle: { coverage: () => Promise.resolve('covered'), get: untrusted.get },
        cache: memoryTileStore(),
        network: layer,
        now: clock.now,
      })
      expect((await bundled.load([UPTOWN])).missing).toEqual([UPTOWN])
      const lost = createTileSource({
        bundle: { coverage: () => Promise.reject(new Error('no index')), get: untrusted.get },
        cache: memoryTileStore(),
        network: layer,
        now: clock.now,
      })
      expect((await lost.load([UPTOWN])).missing).toEqual([UPTOWN])
      expect(server.calls).toHaveLength(1)
    }
    // A cache that cannot store loses nothing but the saving.
    const readOnly = { get: () => Promise.resolve(null), put: () => Promise.reject(new Error('full')) }
    const { layer } = network({ [UPTOWN]: [[11, -80.85, 35.25]] }, clock)
    const loaded = await createTileSource({ cache: readOnly, network: layer, now: clock.now }).load([UPTOWN])
    expect(loaded.missing).toEqual([])
  })

  it('stores tiles in a key-value store under their tile id', async () => {
    const kv = memoryStore<OsmSignalTile>()
    const store = tileStoreFrom(kv)
    const tile = tileAt(UPTOWN, 5, 1)
    expect(await store.get(UPTOWN)).toBeNull()
    await store.put(tile)
    expect(await kv.get(UPTOWN)).toEqual(tile)
    expect(await store.get(UPTOWN)).toEqual(tile)
  })
})
