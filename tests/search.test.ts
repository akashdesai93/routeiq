import { describe, expect, it } from 'vitest'
import {
  MIN_SEARCH_CHARS,
  SEARCH_DEBOUNCE_MS,
  SEARCH_RESULT_LIMIT,
  searchQuery,
  SESSION_IDLE_MS,
  SESSION_MAX_SUGGESTS,
  sessionForSuggest,
  type LngLat,
  type SearchSession,
} from '../src/core/index.ts'
import {
  parseRetrieved,
  parseSuggestions,
  type RetrieveResult,
  type SuggestResult,
} from '../src/providers/mapbox/searchAdapter.ts'
import {
  buildRetrieveUrl,
  buildSuggestUrl,
  fetchPlace,
  fetchSuggestions,
  SEARCH_TYPES,
} from '../src/providers/mapbox/searchClient.ts'
import { createSearchRunner, type SearchState } from '../src/search/searchRunner.ts'
import { fixture } from './helpers/fixtures.ts'

// Hand-written bodies shaped like Search Box API responses, about public landmarks only.
// No test here touches the network.
const SUGGEST = fixture('search.suggest.json') as { suggestions: unknown[] }
const RETRIEVE = fixture('search.retrieve.json') as { features: Record<string, unknown>[] }
const ERROR = fixture('search.error.json')

/** Placeholders, not a real token or session. */
const TOKEN = 'pk.test-token'
const SESSION = '00000000-0000-4000-8000-000000000001'
const UPTOWN: LngLat = [-80.8431, 35.2271]

function suggestionsOf(result: SuggestResult) {
  if (!result.ok) throw new Error(`expected suggestions, got ${result.kind}`)
  return result.suggestions
}
function placeOf(result: RetrieveResult) {
  if (!result.ok) throw new Error(`expected a place, got ${result.kind}`)
  return result.place
}
function failureOf(result: SuggestResult | RetrieveResult) {
  if (result.ok) throw new Error('expected a failure')
  return result
}

describe('searchQuery', () => {
  it('waits for three characters and tidies the text', () => {
    expect(MIN_SEARCH_CHARS).toBe(3)
    expect(searchQuery('')).toBeNull()
    expect(searchQuery('ca')).toBeNull()
    // Spaces do not count toward the minimum.
    expect(searchQuery('  c  a ')).toBe('c a')
    expect(searchQuery(' a ')).toBeNull()
    expect(searchQuery('car')).toBe('car')
    expect(searchQuery('  Carowinds   theme\tpark ')).toBe('Carowinds theme park')
    expect(searchQuery('x'.repeat(400))).toHaveLength(256)
  })
})

describe('sessionForSuggest', () => {
  const tokens = () => {
    let n = 0
    return () => `token-${++n}`
  }

  it('starts a session, keeps it while it is open, and counts the requests', () => {
    const make = tokens()
    const first = sessionForSuggest(null, 1_000, make)
    expect(first).toEqual({ token: 'token-1', suggests: 1, lastUsedMs: 1_000 })
    const second = sessionForSuggest(first, 2_000, make)
    expect(second).toEqual({ token: 'token-1', suggests: 2, lastUsedMs: 2_000 })
  })

  it('starts a new one after 50 suggest requests, after sitting idle, and when the clock went backwards', () => {
    const make = tokens()
    let session: SearchSession | null = null
    for (let i = 0; i < SESSION_MAX_SUGGESTS; i++) session = sessionForSuggest(session, 1_000 + i, make)
    expect(session).toMatchObject({ token: 'token-1', suggests: 50 })
    session = sessionForSuggest(session, 2_000, make)
    expect(session).toMatchObject({ token: 'token-2', suggests: 1 })
    // Just inside the idle limit the session is kept; at it, a new one starts.
    const kept = sessionForSuggest(session, 2_000 + SESSION_IDLE_MS - 1, make)
    expect(kept.token).toBe('token-2')
    expect(sessionForSuggest(kept, kept.lastUsedMs + SESSION_IDLE_MS, make).token).toBe('token-3')
    expect(SESSION_IDLE_MS).toBeLessThan(180_000)
    expect(sessionForSuggest(kept, kept.lastUsedMs - 5, make).token).toBe('token-4')
  })
})

describe('parseSuggestions', () => {
  it('keeps the places, in order, with the fullest description each one has', () => {
    const suggestions = suggestionsOf(parseSuggestions(SUGGEST))
    expect(suggestions).toEqual([
      {
        id: 'dXJuOm1ieHBvaTpzdGFkaXVtLXRlc3Q',
        name: 'Bank of America Stadium',
        detail: '800 S Mint St, Charlotte, North Carolina 28202, United States',
        kind: 'poi',
      },
      {
        id: 'dXJuOm1ieHBvaTphaXJwb3J0LXRlc3Q',
        name: 'Charlotte Douglas International Airport',
        // No full_address: the street address and the formatted place, joined.
        detail: '5501 Josh Birmingham Pkwy, Charlotte, North Carolina 28208, United States',
        kind: 'poi',
      },
      { id: 'dXJuOm1ieHBsYzpjaGFybG90dGUtdGVzdA', name: 'Charlotte', detail: 'North Carolina, United States', kind: 'place' },
    ])
  })

  it('leaves out categories, entries without a name or an id, non-objects and repeated ids', () => {
    const names = suggestionsOf(parseSuggestions(SUGGEST)).map((s) => s.name)
    expect(names).not.toContain('Stadium')
    expect(names).not.toContain('No id')
    expect(names.filter((n) => n === 'Bank of America Stadium')).toHaveLength(1)
    expect(names).toHaveLength(3)
  })

  it('returns a handful at most', () => {
    expect(SEARCH_RESULT_LIMIT).toBe(5)
    const many = {
      suggestions: Array.from({ length: 9 }, (_, i) => ({ name: `Gate ${i}`, mapbox_id: `id-${i}`, feature_type: 'poi' })),
    }
    expect(suggestionsOf(parseSuggestions(many))).toHaveLength(5)
    expect(suggestionsOf(parseSuggestions(many, 2)).map((s) => s.name)).toEqual(['Gate 0', 'Gate 1'])
    expect(suggestionsOf(parseSuggestions(many))[0]!.detail).toBe('')
  })

  it('treats an empty list as an answer', () => {
    expect(parseSuggestions({ suggestions: [], attribution: '' })).toEqual({ ok: true, suggestions: [] })
  })

  it('fails in a typed way on error bodies and on anything that is not a response', () => {
    const api = failureOf(parseSuggestions(ERROR))
    expect(api.kind).toBe('api')
    expect(api.message).toBe('Mapbox Search error: Bad request')
    for (const body of [null, undefined, 'text', 42, [], {}, { suggestions: 'none' }, { suggestions: null }]) {
      expect(failureOf(parseSuggestions(body)).kind, JSON.stringify(body)).toBe('malformed')
    }
  })
})

describe('parseRetrieved', () => {
  it('turns the feature into a place, routed to the point on the road when there is one', () => {
    const place = placeOf(parseRetrieved(RETRIEVE))
    expect(place).toEqual({
      id: 'mapbox:dXJuOm1ieHBvaTpzdGFkaXVtLXRlc3Q',
      label: 'Bank of America Stadium',
      position: [-80.8519, 35.2249],
    })
  })

  it('falls back on the feature point, then on properties.coordinates', () => {
    const feature = RETRIEVE.features[0]!
    const properties = feature.properties as Record<string, unknown>
    const noRoutable = { features: [{ ...feature, properties: { ...properties, coordinates: { longitude: -80.8528, latitude: 35.2258 } } }] }
    expect(placeOf(parseRetrieved(noRoutable)).position).toEqual([-80.8528, 35.2258])
    const badRoutable = {
      features: [{ ...feature, properties: { ...properties, coordinates: { routable_points: [{ longitude: 'x' }, null] } } }],
    }
    expect(placeOf(parseRetrieved(badRoutable)).position).toEqual([-80.8528, 35.2258])
    const noGeometry = { features: [{ type: 'Feature', properties: { ...properties, coordinates: { longitude: -80.9431, latitude: 35.214 } } }] }
    expect(placeOf(parseRetrieved(noGeometry)).position).toEqual([-80.9431, 35.214])
  })

  it('labels an address by its full address without the country, a landmark by its name', () => {
    const address = {
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [-80.8303, 35.1517] },
          properties: {
            name: '4400 Sharon Rd',
            mapbox_id: 'dXJuOmFkZHJlc3MtdGVzdA',
            feature_type: 'address',
            full_address: '4400 Sharon Rd, Charlotte, North Carolina 28211, United States',
            place_formatted: 'Charlotte, North Carolina 28211, United States',
          },
        },
      ],
    }
    expect(placeOf(parseRetrieved(address)).label).toBe('4400 Sharon Rd, Charlotte, North Carolina 28211')
    const city = {
      features: [
        {
          geometry: { coordinates: [-80.9414, 35.1037] },
          properties: { name: 'Fort Mill', feature_type: 'place', place_formatted: 'South Carolina, United States' },
        },
      ],
    }
    const place = placeOf(parseRetrieved(city))
    expect(place.label).toBe('Fort Mill, South Carolina')
    // Without an id from Mapbox the label stands in.
    expect(place.id).toBe('mapbox:Fort Mill, South Carolina')
  })

  it('fails in a typed way: no usable feature, error bodies, anything else', () => {
    expect(failureOf(parseRetrieved({ type: 'FeatureCollection', features: [] })).kind).toBe('not-found')
    const outOfRange = { features: [{ geometry: { coordinates: [-80.85, 135.2] }, properties: { name: 'Nowhere', feature_type: 'poi' } }] }
    expect(failureOf(parseRetrieved(outOfRange)).kind).toBe('not-found')
    const unnamed = { features: [{ geometry: { coordinates: [-80.85, 35.2] }, properties: {} }, 'junk', { properties: null }] }
    expect(failureOf(parseRetrieved(unnamed)).kind).toBe('not-found')
    expect(failureOf(parseRetrieved(ERROR)).kind).toBe('api')
    for (const body of [null, 'text', [], {}, { features: {} }]) {
      expect(failureOf(parseRetrieved(body)).kind, JSON.stringify(body)).toBe('malformed')
    }
  })
})

describe('buildSuggestUrl', () => {
  const options = { query: 'Carowinds', token: TOKEN, sessionToken: SESSION, proximity: UPTOWN }

  it('asks the Search Box suggest endpoint for a handful of places near the given point', () => {
    const url = new URL(buildSuggestUrl(options)!)
    expect(url.origin + url.pathname).toBe('https://api.mapbox.com/search/searchbox/v1/suggest')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: 'Carowinds',
      language: 'en',
      limit: '5',
      types: SEARCH_TYPES,
      // Longitude first, then latitude.
      proximity: '-80.8431,35.2271',
      session_token: SESSION,
      access_token: TOKEN,
    })
    expect(SEARCH_TYPES.split(',')).not.toContain('category')
  })

  it('percent-encodes the typed text and tidies it first', () => {
    const url = buildSuggestUrl({ ...options, query: '  SouthPark Mall & café #1?  ' })!
    expect(url).toContain('q=SouthPark+Mall+%26+caf%C3%A9+%231%3F&')
    expect(new URL(url).searchParams.get('q')).toBe('SouthPark Mall & café #1?')
    // Nothing typed can add a parameter of its own.
    const sneaky = new URL(buildSuggestUrl({ ...options, query: 'Carowinds&proximity=ip&limit=10' })!)
    expect(sneaky.searchParams.get('proximity')).toBe('-80.8431,35.2271')
    expect(sneaky.searchParams.getAll('limit')).toEqual(['5'])
  })

  it('rounds the proximity to four decimals and keeps the limit within what Mapbox allows', () => {
    const url = new URL(buildSuggestUrl({ ...options, proximity: [-80.943139, 35.214012], limit: 50 })!)
    expect(url.searchParams.get('proximity')).toBe('-80.9431,35.214')
    expect(url.searchParams.get('limit')).toBe('10')
    expect(new URL(buildSuggestUrl({ ...options, limit: 0 })!).searchParams.get('limit')).toBe('1')
  })

  it('gives no URL for text too short, a missing session token or a bad coordinate', () => {
    expect(buildSuggestUrl({ ...options, query: 'ca' })).toBeNull()
    expect(buildSuggestUrl({ ...options, sessionToken: '' })).toBeNull()
    expect(buildSuggestUrl({ ...options, proximity: [NaN, 35] })).toBeNull()
    expect(buildSuggestUrl({ ...options, proximity: [35.2271, -180.8431] })).toBeNull()
  })
})

describe('buildRetrieveUrl', () => {
  it('names the suggestion in the path and carries the same session token', () => {
    const url = new URL(buildRetrieveUrl('dXJuOm1ieHBvaTpzdGFkaXVtLXRlc3Q', TOKEN, SESSION)!)
    expect(url.pathname).toBe('/search/searchbox/v1/retrieve/dXJuOm1ieHBvaTpzdGFkaXVtLXRlc3Q')
    expect(Object.fromEntries(url.searchParams)).toEqual({ session_token: SESSION, access_token: TOKEN })
  })

  it('encodes an id that is not URL-safe, and refuses an empty one', () => {
    expect(buildRetrieveUrl('a/b?c=d e', TOKEN, SESSION)).toContain('/retrieve/a%2Fb%3Fc%3Dd%20e?')
    expect(buildRetrieveUrl(' ', TOKEN, SESSION)).toBeNull()
    expect(buildRetrieveUrl('id', TOKEN, '')).toBeNull()
  })
})

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; signal: AbortSignal | null | undefined }[] = []
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), signal: init?.signal })
    return Promise.resolve(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }))
  }) as typeof fetch
  return { fetchImpl, calls }
}

describe('fetchSuggestions and fetchPlace', () => {
  const where = { query: 'Bank of America Stadium', token: TOKEN, sessionToken: SESSION, proximity: UPTOWN }
  const picked = { id: 'dXJuOm1ieHBvaTpzdGFkaXVtLXRlc3Q', token: TOKEN, sessionToken: SESSION }

  it('one suggest request, with the abort signal, gives suggestions', async () => {
    const { fetchImpl, calls } = fakeFetch(200, SUGGEST)
    const controller = new AbortController()
    const result = await fetchSuggestions({ ...where, signal: controller.signal, fetchImpl })
    expect(suggestionsOf(result)).toHaveLength(3)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(buildSuggestUrl(where))
    expect(calls[0]!.signal).toBe(controller.signal)
  })

  it('one retrieve request on the same session gives the place', async () => {
    const { fetchImpl, calls } = fakeFetch(200, RETRIEVE)
    const result = await fetchPlace({ ...picked, fetchImpl })
    expect(placeOf(result).label).toBe('Bank of America Stadium')
    expect(calls.map((c) => c.url)).toEqual([buildRetrieveUrl(picked.id, TOKEN, SESSION)])
  })

  it('sends nothing for text under three characters', async () => {
    const { fetchImpl, calls } = fakeFetch(200, SUGGEST)
    expect(await fetchSuggestions({ ...where, query: ' c ', fetchImpl })).toEqual({ ok: true, suggestions: [] })
    expect(calls).toHaveLength(0)
    expect(failureOf(await fetchPlace({ ...picked, id: '', fetchImpl })).kind).toBe('malformed')
    expect(calls).toHaveLength(0)
  })

  it('explains 401, 403 and 429 without ever showing the token', async () => {
    for (const [status, kind, text] of [
      [401, 'token', 'rejected the token'],
      [403, 'token', 'allowed URLs'],
      [429, 'rate-limit', 'rate limiting search'],
    ] as const) {
      for (const run of [
        (fetchImpl: typeof fetch) => fetchSuggestions({ ...where, fetchImpl }),
        (fetchImpl: typeof fetch) => fetchPlace({ ...picked, fetchImpl }),
      ]) {
        const failure = failureOf(await run(fakeFetch(status, { message: 'Not authorized' }).fetchImpl))
        expect(failure.kind).toBe(kind)
        expect(failure.message).toContain(text)
        expect(failure.message).not.toContain(TOKEN)
      }
    }
  })

  it('keeps the words of a 400, and names the status of anything else', async () => {
    const bad = failureOf(await fetchSuggestions({ ...where, fetchImpl: fakeFetch(400, ERROR).fetchImpl }))
    expect(bad).toMatchObject({ kind: 'api', message: 'Mapbox Search error: Bad request' })
    const down = failureOf(await fetchSuggestions({ ...where, fetchImpl: fakeFetch(503, 'Service Unavailable').fetchImpl }))
    expect(down.kind).toBe('api')
    expect(down.message).toContain('HTTP 503')
    // A 2xx with a body that is not JSON is unreadable, not a crash.
    const html = failureOf(await fetchPlace({ ...picked, fetchImpl: fakeFetch(200, '<html>').fetchImpl }))
    expect(html.kind).toBe('malformed')
  })

  it('redacts a token that an error body echoes back', async () => {
    const echo = { message: `Bad request: access_token=${TOKEN}` }
    const failure = failureOf(await fetchSuggestions({ ...where, fetchImpl: fakeFetch(400, echo).fetchImpl }))
    expect(failure.message).not.toContain(TOKEN)
    expect(failure.message).toContain('[token]')
  })

  it('offline: a readable network failure, with neither the token nor the typed text in it', async () => {
    const fetchImpl = (() => Promise.reject(new TypeError(`Failed to fetch ${TOKEN} ${where.query}`))) as typeof fetch
    for (const failure of [
      failureOf(await fetchSuggestions({ ...where, fetchImpl })),
      failureOf(await fetchPlace({ ...picked, fetchImpl })),
    ]) {
      expect(failure).toMatchObject({
        kind: 'network',
        message: 'Could not reach Mapbox search. Check your internet connection, or drag a pin instead.',
      })
      expect(failure.message).not.toContain(TOKEN)
      expect(failure.message).not.toContain(where.query)
    }
  })

  it('aborting resolves as aborted, before or after the answer', async () => {
    const hanging = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })) as typeof fetch
    const controller = new AbortController()
    const pending = fetchSuggestions({ ...where, signal: controller.signal, fetchImpl: hanging })
    controller.abort()
    expect(failureOf(await pending)).toMatchObject({ kind: 'aborted', message: 'Search cancelled.' })

    const late = new AbortController()
    const answered = ((): Promise<Response> => {
      late.abort()
      return Promise.resolve(new Response(JSON.stringify(RETRIEVE), { status: 200 }))
    }) as typeof fetch
    expect(failureOf(await fetchPlace({ ...picked, signal: late.signal, fetchImpl: answered })).kind).toBe('aborted')
  })
})

describe('createSearchRunner', () => {
  /** A timer fired by hand, a search answered by hand, and every state the runner reports. */
  function harness() {
    const timers: { run: () => void; ms: number; cleared: boolean }[] = []
    const searches: { query: string; signal: AbortSignal; answer: (result: SuggestResult) => void }[] = []
    const states: SearchState[] = []
    const runner = createSearchRunner({
      onState: (state) => states.push(state),
      search: (query, signal) =>
        new Promise<SuggestResult>((answer) => {
          searches.push({ query, signal, answer })
        }),
      setTimer: (run, ms) => {
        const timer = { run, ms, cleared: false }
        timers.push(timer)
        return timer
      },
      clearTimer: (handle) => {
        ;(handle as { cleared: boolean }).cleared = true
      },
    })
    /** Fires the timers that are still set, as the clock would. */
    const elapse = () => {
      for (const timer of timers.splice(0)) if (!timer.cleared) timer.run()
    }
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
    return { runner, timers, searches, states, elapse, settle }
  }
  const found = (name: string): SuggestResult => ({ ok: true, suggestions: [{ id: name, name, detail: '', kind: 'poi' }] })

  it('searches nothing under three characters and sets no timer', () => {
    const { runner, timers, searches, states } = harness()
    runner.input('c')
    runner.input('ca')
    expect(timers).toHaveLength(0)
    expect(searches).toHaveLength(0)
    // Idle all along: nothing to report.
    expect(states).toEqual([])
  })

  it('waits for a pause in typing: one request for the last text', async () => {
    const { runner, timers, searches, states, elapse, settle } = harness()
    runner.input('car')
    runner.input('caro')
    runner.input('carowinds')
    expect(timers.map((t) => t.ms)).toEqual([SEARCH_DEBOUNCE_MS, SEARCH_DEBOUNCE_MS, SEARCH_DEBOUNCE_MS])
    expect(SEARCH_DEBOUNCE_MS).toBeGreaterThanOrEqual(300)
    expect(timers.map((t) => t.cleared)).toEqual([true, true, false])
    expect(searches).toHaveLength(0)
    elapse()
    expect(searches.map((s) => s.query)).toEqual(['carowinds'])
    searches[0]!.answer(found('Carowinds'))
    await settle()
    expect(states.map((s) => s.status)).toEqual(['waiting', 'waiting', 'waiting', 'searching', 'done'])
    expect(states.at(-1)).toMatchObject({ query: 'carowinds', suggestions: [{ name: 'Carowinds' }] })
  })

  it('aborts the request that is out when typing goes on, and ignores its late answer', async () => {
    const { runner, searches, states, elapse, settle } = harness()
    runner.input('south')
    elapse()
    runner.input('southpark')
    expect(searches[0]!.signal.aborted).toBe(true)
    elapse()
    expect(searches.map((s) => s.query)).toEqual(['south', 'southpark'])
    // The newer answer arrives first, the stale one after it.
    searches[1]!.answer(found('SouthPark Mall'))
    searches[0]!.answer(found('South Boulevard'))
    await settle()
    expect(states.at(-1)).toMatchObject({ status: 'done', query: 'southpark', suggestions: [{ name: 'SouthPark Mall' }] })
    expect(states.filter((s) => s.status === 'done')).toHaveLength(1)
  })

  it('does not search again when only the spacing changed', () => {
    const { runner, timers, searches, elapse } = harness()
    runner.input('bank of')
    elapse()
    runner.input('bank of ')
    runner.input(' bank  of')
    expect(timers).toHaveLength(0)
    expect(searches).toHaveLength(1)
    expect(searches[0]!.signal.aborted).toBe(false)
  })

  it('goes back to idle when the text is cleared, and drops what was pending', () => {
    const { runner, timers, searches, states, elapse } = harness()
    runner.input('airport')
    runner.input('ai')
    expect(timers[0]!.cleared).toBe(true)
    elapse()
    expect(searches).toHaveLength(0)
    expect(states.map((s) => s.status)).toEqual(['waiting', 'idle'])
  })

  it('reports a failure as an error, but never an aborted one', async () => {
    const { runner, searches, states, elapse, settle } = harness()
    runner.input('stadium')
    elapse()
    searches[0]!.answer({ ok: false, kind: 'rate-limit', message: 'Mapbox is rate limiting search requests (429).' })
    await settle()
    expect(states.at(-1)).toEqual({ status: 'error', query: 'stadium', message: 'Mapbox is rate limiting search requests (429).' })
    runner.input('stadium tour')
    elapse()
    searches[1]!.answer({ ok: false, kind: 'aborted', message: 'Search cancelled.' })
    await settle()
    expect(states.at(-1)!.status).toBe('searching')
  })

  it('cancel aborts, clears and goes idle; the same text can be searched again afterwards', async () => {
    const { runner, timers, searches, states, elapse, settle } = harness()
    runner.input('carowinds')
    elapse()
    runner.cancel()
    expect(searches[0]!.signal.aborted).toBe(true)
    searches[0]!.answer(found('Carowinds'))
    await settle()
    expect(states.map((s) => s.status)).toEqual(['waiting', 'searching', 'idle'])
    // Cancelling again, with nothing going on, reports nothing.
    runner.cancel()
    expect(states).toHaveLength(3)
    runner.input('carowinds')
    expect(timers).toHaveLength(1)
    runner.cancel()
    expect(timers[0]!.cleared).toBe(true)
  })
})
