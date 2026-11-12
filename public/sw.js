// RouteIQ's offline shell (#9): keeps the app's own files so it opens with no signal.
//
// What it stores: the page, its scripts, styles, fonts, icons and the bundled signal
// tiles, all from this site and only once they were fetched with a connection.
// What it never touches: anything from another site (Mapbox Directions, Search, the map
// style and tiles, Overpass) and any address with a query string, so no Mapbox answer
// and no address with `access_token` is ever stored. Those requests are not even
// answered here: the browser sends them as if there were no service worker.
//
// Not registered inside the iPhone shell (src/device/offline.ts); the shell ships its files.
// The rules are in `requestPolicy`, a pure function that tests/offline.test.ts runs.
/* global self, caches, fetch, URL, Response */

const CACHE = 'routeiq-shell-v1'

/**
 * What to do with one request.
 *   'pass'       not ours: the browser sends it as if there were no service worker.
 *   'page'       opening the app: the network first; the stored page when offline.
 *   'immutable'  a built file whose name holds its hash (assets/): stored, then served from store.
 *   'refresh'    another file of ours (icons, manifest, signal tiles): the network first, the stored copy offline.
 * @param {{ url: string, method: string, mode: string }} request
 * @param {string} scope the service worker's scope, e.g. "https://example.org/routeiq/"
 */
function requestPolicy(request, scope) {
  if (request.method !== 'GET') return 'pass'
  let url
  try {
    url = new URL(request.url)
  } catch {
    return 'pass'
  }
  const base = new URL(scope)
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return 'pass'
  // A query string means data, not a file of the app (and an access_token would be in one).
  if (url.search !== '' || /access_token/i.test(request.url)) return 'pass'
  const path = url.pathname.slice(base.pathname.length)
  if (path === 'sw.js') return 'pass'
  if (request.mode === 'navigate') return path === '' || path === 'index.html' ? 'page' : 'pass'
  if (path.startsWith('assets/')) return 'immutable'
  return 'refresh'
}

/** The app's own files that index.html names (scripts, styles, icons, manifest), as paths under the scope. */
function shellFiles(html, scope) {
  const base = new URL(scope)
  const files = new Set(['', 'manifest.webmanifest'])
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const url = new URL(match[1], scope)
    if (url.origin === base.origin && url.pathname.startsWith(base.pathname) && url.search === '') {
      files.add(url.pathname.slice(base.pathname.length))
    }
  }
  return [...files]
}

/** Only a whole, plain answer from this site is kept. */
function storable(response) {
  return response.ok && response.status === 200 && response.type === 'basic'
}

if (typeof self !== 'undefined' && typeof self.addEventListener === 'function' && typeof caches !== 'undefined') {
  const scope = self.registration.scope

  self.addEventListener('install', (event) => {
    event.waitUntil(
      (async () => {
        const cache = await caches.open(CACHE)
        const page = await fetch(scope, { cache: 'no-cache' })
        if (!storable(page)) throw new Error('the page could not be fetched')
        const files = shellFiles(await page.clone().text(), scope).filter((f) => f !== '')
        await cache.put(scope, page)
        await cache.addAll(files.map((f) => new URL(f, scope).href))
        await self.skipWaiting()
      })(),
    )
  })

  self.addEventListener('activate', (event) => {
    event.waitUntil(
      (async () => {
        for (const name of await caches.keys()) if (name.startsWith('routeiq-') && name !== CACHE) await caches.delete(name)
        await self.clients.claim()
      })(),
    )
  })

  // The files the page loaded before this worker took over (fonts, the map's script):
  // the page names them once (src/device/offline.ts) and the ones that pass the rules are stored.
  self.addEventListener('message', (event) => {
    const urls = event.data?.type === 'routeiq-store' && Array.isArray(event.data.urls) ? event.data.urls : []
    const ours = urls.filter((u) => typeof u === 'string' && requestPolicy({ url: u, method: 'GET', mode: 'no-cors' }, scope) !== 'pass')
    if (ours.length === 0) return
    event.waitUntil(
      (async () => {
        const cache = await caches.open(CACHE)
        for (const url of ours) {
          if (await cache.match(url, { ignoreVary: true })) continue
          try {
            const response = await fetch(url)
            if (storable(response)) await cache.put(url, response)
          } catch {
            // Offline or gone: it is stored on its next use instead.
          }
        }
      })(),
    )
  })

  self.addEventListener('fetch', (event) => {
    const policy = requestPolicy(event.request, scope)
    if (policy === 'pass') return
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE)
        const key = policy === 'page' ? scope : event.request
        if (policy === 'immutable') {
          const stored = await cache.match(key, { ignoreVary: true })
          if (stored) return stored
        }
        try {
          const response = await fetch(event.request)
          if (storable(response)) await cache.put(key, response.clone())
          return response
        } catch (error) {
          const stored = await cache.match(key, { ignoreVary: true })
          if (stored) return stored
          if (policy === 'page') return new Response('RouteIQ needs one visit with a connection before it opens offline.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
          throw error
        }
      })(),
    )
  })
}
