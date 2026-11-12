import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

// The offline shell's rules (public/sw.js, #9): what the service worker may store.
// sw.js is a plain script for the browser, so it is run here in a bare context, where
// it only defines its functions (there is no `self` or `caches` to hook into).
type Policy = 'pass' | 'page' | 'immutable' | 'refresh'
const source = readFileSync(join(import.meta.dirname, '..', 'public', 'sw.js'), 'utf8')
const sw = runInNewContext(`${source}\n;({ requestPolicy, shellFiles })`, { URL }) as {
  requestPolicy: (request: { url: string; method: string; mode: string }, scope: string) => Policy
  shellFiles: (html: string, scope: string) => string[]
}

const SCOPE = 'https://example.org/routeiq/'
const get = (url: string, mode = 'cors') => sw.requestPolicy({ url, method: 'GET', mode }, SCOPE)

describe('offline shell: what the service worker stores', () => {
  it('never touches Mapbox or any other site: Directions, Search, the map style and tiles, Overpass', () => {
    for (const url of [
      'https://api.mapbox.com/directions/v5/mapbox/driving-traffic/-80.84,35.22;-80.83,35.15?access_token=pk.test&alternatives=true',
      'https://api.mapbox.com/search/searchbox/v1/suggest?q=freedom&access_token=pk.test&session_token=abc',
      'https://api.mapbox.com/styles/v1/mapbox/dark-v11?access_token=pk.test',
      'https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/14/4512/6512.vector.pbf',
      'https://events.mapbox.com/events/v2',
      'https://overpass-api.de/api/interpreter',
      'https://example.org/elsewhere/assets/index-abc.js',
    ]) {
      expect(get(url), url).toBe('pass')
    }
  })

  it('at the site root (the default base, "/"), another site is still never touched', () => {
    // There every path starts with the scope's path, so only the origin check keeps a
    // query-less file of another site (a tile, a script, a font) out of the store.
    const atRoot = (url: string) => sw.requestPolicy({ url, method: 'GET', mode: 'cors' }, 'https://example.org/')
    for (const url of [
      'https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/14/4512/6512.vector.pbf',
      'https://api.mapbox.com/mapbox-gl-js/v3.0.0/mapbox-gl.js',
      'https://overpass-api.de/api/interpreter',
      'https://fonts.example.net/inter.woff2',
    ]) {
      expect(atRoot(url), url).toBe('pass')
    }
  })

  it('never stores an address of this site with a query string, so no access_token is ever kept', () => {
    expect(get('https://example.org/routeiq/assets/index-abc.js?access_token=pk.test')).toBe('pass')
    expect(get('https://example.org/routeiq/seed/osm-signals/index.json?v=2')).toBe('pass')
    expect(get('https://example.org/routeiq/?lab=1', 'navigate')).toBe('pass')
  })

  it('only reads: anything but GET passes', () => {
    expect(sw.requestPolicy({ url: 'https://example.org/routeiq/', method: 'POST', mode: 'navigate' }, SCOPE)).toBe('pass')
  })

  it('keeps the app: the page, hashed files from the store, icons and signal tiles fresh when online', () => {
    expect(get('https://example.org/routeiq/', 'navigate')).toBe('page')
    expect(get('https://example.org/routeiq/index.html', 'navigate')).toBe('page')
    expect(get('https://example.org/routeiq/assets/index-abc.js')).toBe('immutable')
    expect(get('https://example.org/routeiq/assets/inter-latin-600-normal-xyz.woff2')).toBe('immutable')
    expect(get('https://example.org/routeiq/icons/icon-192.png')).toBe('refresh')
    expect(get('https://example.org/routeiq/manifest.webmanifest')).toBe('refresh')
    expect(get('https://example.org/routeiq/seed/osm-signals/14_4512_6512.json')).toBe('refresh')
  })

  it('leaves the worker script itself and pages outside the app to the browser', () => {
    expect(get('https://example.org/routeiq/sw.js')).toBe('pass')
    expect(get('https://example.org/routeiq/drives.html', 'navigate')).toBe('pass')
  })

  it('at the site root, a link to another site is still not one of the app files', () => {
    const html = '<link rel="preconnect" href="https://api.mapbox.com/"><script src="https://api.mapbox.com/x.js"></script><script src="/assets/a.js"></script>'
    expect(sw.shellFiles(html, 'https://example.org/').sort()).toEqual(['', 'assets/a.js', 'manifest.webmanifest'])
  })

  it('stores at install only the files of this site that index.html names', () => {
    const html = `<link rel="manifest" href="/routeiq/manifest.webmanifest" />
      <link rel="apple-touch-icon" href="/routeiq/icons/apple-touch-icon.png" />
      <script type="module" crossorigin src="/routeiq/assets/index-abc.js"></script>
      <link rel="stylesheet" crossorigin href="/routeiq/assets/index-def.css">
      <link rel="preconnect" href="https://api.mapbox.com">
      <script src="/routeiq/assets/x.js?access_token=pk.test"></script>`
    expect(sw.shellFiles(html, SCOPE).sort()).toEqual(
      ['', 'assets/index-abc.js', 'assets/index-def.css', 'icons/apple-touch-icon.png', 'manifest.webmanifest'].sort(),
    )
  })
})
