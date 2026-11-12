// The simulator drive's page script. SIMULATOR BUILDS ONLY.
//
// sim/prepare.mjs bundles this file into www/routeiq-sim.js and loads it right
// after the bridge script, for the run in the iOS Simulator on GitHub Actions
// (.github/workflows/sim-drive.yml). The phone build never contains it: the
// app's own source does not refer to it, scripts/build-web.mjs fails if it is
// in www/, and the phone workflow searches the finished app for it.
//
// What it does, so that the real app can be driven with nobody tapping:
//
// - Puts a made-up public token in the app's storage, so the app opens on the
//   trip instead of the "paste your token" screen. (With the optional secret
//   MAPBOX_PUBLIC_TOKEN_SIM it is that token, and the map is Mapbox's own.)
// - Wraps the plugin the bridge put on the page: `httpGet` (route requests)
//   is answered by the stub server on the build machine, from the made-up
//   road network of the e2e scenarios. GPS, voice, ticks and the screen lock
//   stay the real Swift plugin's.
// - Answers the map's own requests (the style) from the stub too, so no
//   request needs a token.
// - Reports once a second to the stub what the screen shows and what the
//   plugin did (counts, the spoken lines, words on the screen: no position),
//   and carries out the driver script's commands: press Start drive, press
//   End, read the Drive diagnostics text.
//
// The first half of this file is pure functions (tests/sim.test.mjs); the
// second half is `install`, which only runs in a page whose script tag names
// a stub server on this machine.

export const SIM_TOKEN = 'pk.routeiq-sim-drive'
/** The same key as src/shellToken.ts. */
export const SHELL_TOKEN_KEY = 'routeiq.shell.mapboxToken'
const MAPBOX_API = 'https://api.mapbox.com'

/** The stub server's address when it is on this machine, null for anything else. */
export function simBase(raw) {
  return typeof raw === 'string' && /^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(raw) ? raw : null
}

/** A path and query without the access token: the stub never sees one. */
export function withoutToken(pathAndQuery) {
  const at = pathAndQuery.indexOf('?')
  if (at === -1) return pathAndQuery
  const params = new URLSearchParams(pathAndQuery.slice(at + 1))
  params.delete('access_token')
  const query = params.toString()
  return query === '' ? pathAndQuery.slice(0, at) : `${pathAndQuery.slice(0, at)}?${query}`
}

/**
 * Where a request of the page goes during a simulator drive.
 *
 * - `{ kind: 'stub', path }`: answered by the stub server (route requests
 *   always; the map style when the map is stubbed too).
 * - `{ kind: 'quiet' }`: answered in the page with "204 No Content"
 *   (Mapbox's telemetry and map sessions, with the made-up token).
 * - `{ kind: 'busy' }`: answered in the page with 504 (Overpass: the bundled
 *   signal tiles are used, as when Overpass is busy).
 * - null: left alone (the app's own files, and Mapbox itself when the run has a real token).
 *
 * @param {string} url
 * @param {{ mapStub: boolean }} options mapStub: no real token, so the map's requests are stubbed as well
 */
export function simRoute(url, { mapStub }) {
  if (typeof url !== 'string') return null
  if (url.startsWith('https://overpass-api.de/')) return { kind: 'busy' }
  if (url.startsWith(`${MAPBOX_API}/directions/`)) return { kind: 'stub', path: withoutToken(url.slice(MAPBOX_API.length)) }
  if (!mapStub) return null
  if (url.startsWith('https://events.mapbox.com/') || url.startsWith(`${MAPBOX_API}/map-sessions/`)) return { kind: 'quiet' }
  if (url.startsWith(`${MAPBOX_API}/`)) return { kind: 'stub', path: withoutToken(url.slice(MAPBOX_API.length)) }
  return null
}

/** The numbers the pass/fail check reads out of the app's Drive diagnostics text. Null when a line is missing. */
export function readDiagnostics(text) {
  if (typeof text !== 'string') return null
  const fixes = /^fixes: (\d+) \((\d+) while not active\), longest gap (\d+) s/m.exec(text)
  const ticks = /^ticks: (\d+) \((\d+) while not active\), longest gap (\d+) s/m.exec(text)
  const requests = /^requests: (\d+) sent \((\d+) while not active\), (\d+) answered, (\d+) failed/m.exec(text)
  if (fixes === null || ticks === null || requests === null) return null
  return {
    fixes: Number(fixes[1]),
    fixesAway: Number(fixes[2]),
    fixGapSec: Number(fixes[3]),
    ticks: Number(ticks[1]),
    ticksAway: Number(ticks[2]),
    tickGapSec: Number(ticks[3]),
    sent: Number(requests[1]),
    sentAway: Number(requests[2]),
    answered: Number(requests[3]),
    failed: Number(requests[4]),
  }
}

// ---------------------------------------------------------------------------

const clip = (text, max = 240) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

/**
 * Starts the simulator drive in this page. Does nothing unless `script` (the
 * tag that loaded this file) names a stub server on this machine.
 */
export function install(win, script) {
  const base = simBase(script?.dataset?.base)
  if (base === null) return false
  const doc = win.document
  const realToken = script.dataset.token ?? ''
  const mapStub = realToken === ''
  const mapOff = script.dataset.map === 'off'
  if (mapOff) {
    // No WebGL: the app's map says it could not start and the drive goes on without it
    // (Mapbox GL crashes the web view's content process in a simulator without a GPU).
    const getContext = win.HTMLCanvasElement.prototype.getContext
    win.HTMLCanvasElement.prototype.getContext = function (kind, ...rest) {
      if (/webgl/i.test(String(kind))) return null
      return getContext.call(this, kind, ...rest)
    }
  }

  try {
    win.localStorage.setItem(SHELL_TOKEN_KEY, mapStub ? SIM_TOKEN : realToken)
  } catch {
    // The token screen then shows, and the driver script reports that.
  }

  const counts = { fixes: 0, ticks: 0, locationErrors: 0, httpSent: 0, httpAnswered: 0, httpFailed: 0, appStateChanges: 0 }
  const spoken = []
  const errors = []
  const results = []
  let appState = 'active'
  let transport = 'none'
  let nativeProblem = null

  const note = (what) => {
    if (errors.length < 40) errors.push(clip(what, 300))
  }
  win.addEventListener('error', (e) => note(`error: ${e.message}`))
  win.addEventListener('unhandledrejection', (e) => note(`rejection: ${e.reason?.message ?? e.reason}`))

  // --- Talking to the stub server -----------------------------------------
  // First choice: Capacitor's own native HTTP plugin (URLSession), which a
  // web view's rules about plain http from an app page do not apply to, and
  // which iOS does not hold back with the screen locked. Otherwise fetch.
  const pageFetch = win.fetch.bind(win)
  let useNative = typeof win.Capacitor?.nativePromise === 'function' && win.Capacitor?.isNativePlatform?.() === true
  async function stub(method, path, body) {
    const url = base + path
    if (useNative) {
      try {
        const answer = await win.Capacitor.nativePromise('CapacitorHttp', 'request', {
          url,
          method,
          headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
          data: body,
          responseType: 'text',
          connectTimeout: 10_000,
          readTimeout: 15_000,
        })
        transport = 'native'
        return { status: Number(answer.status), text: typeof answer.data === 'string' ? answer.data : JSON.stringify(answer.data ?? null) }
      } catch (e) {
        nativeProblem = clip(e?.message ?? e, 200)
        // One native failure after it has worked is a failed request; before that, try fetch from now on.
        if (transport === 'native') throw e
        useNative = false
      }
    }
    const response = await pageFetch(url, {
      method,
      // text/plain: a "simple" request, so the web view sends no preflight.
      headers: body === undefined ? undefined : { 'Content-Type': 'text/plain' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    transport = 'fetch'
    return { status: response.status, text: await response.text() }
  }

  // --- The page's own requests (the map) ----------------------------------
  win.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof win.URL ? input.href : input?.url
    const to = simRoute(url, { mapStub })
    if (to === null) return pageFetch(input, init)
    if (to.kind === 'quiet') return Promise.resolve(new win.Response(null, { status: 204 }))
    if (to.kind === 'busy') {
      return Promise.resolve(new win.Response('{"remark":"busy"}', { status: 504, headers: { 'Content-Type': 'application/json' } }))
    }
    return stub('GET', to.path).then(
      (answer) => new win.Response(answer.text, { status: answer.status === 204 ? 200 : answer.status, headers: { 'Content-Type': 'application/json' } }),
    )
  }

  // --- The plugin ----------------------------------------------------------
  const real = win.RouteIQNative
  if (real !== undefined && real !== null) {
    const cancelled = new Set()
    const failure = (code) => Object.assign(new Error(`The request failed: ${code}`), { code })
    const httpGet = async ({ id, url } = {}) => {
      counts.httpSent++
      const to = simRoute(url, { mapStub })
      // The same rule as the Swift side: Mapbox's API host only.
      if (typeof url !== 'string' || !url.startsWith(`${MAPBOX_API}/`) || to === null || to.kind !== 'stub') {
        counts.httpFailed++
        throw failure('not-allowed')
      }
      const startedAt = Date.now()
      let answer
      try {
        answer = await stub('GET', to.path)
      } catch {
        counts.httpFailed++
        throw failure('network')
      }
      if (cancelled.delete(id)) throw failure('cancelled')
      counts.httpAnswered++
      return { status: answer.status, body: answer.text, ms: Date.now() - startedAt }
    }
    const httpCancel = async ({ id } = {}) => {
      cancelled.add(id)
    }
    const speak = (options) => {
      spoken.push({ atMs: Date.now(), text: clip(options?.text, 200) })
      return real.speak(options)
    }
    const overrides = { httpGet, httpCancel, speak }
    win.RouteIQNative = new Proxy(real, {
      get: (target, name) => (Object.prototype.hasOwnProperty.call(overrides, name) ? overrides[name] : target[name]),
    })
    const listen = (event, fn) => {
      try {
        void Promise.resolve(real.addListener(event, fn)).catch(() => {})
      } catch {
        // Counted as zero then.
      }
    }
    listen('fix', () => counts.fixes++)
    listen('locationError', () => counts.locationErrors++)
    listen('appState', (change) => {
      appState = clip(change?.state, 20)
      counts.appStateChanges++
    })
    // A native event wakes the page even when its own timers are held back.
    listen('tick', () => {
      counts.ticks++
      report()
    })
  }

  // --- What the screen shows ----------------------------------------------
  const q = (selector) => doc.querySelector(selector)
  const text = (selector, max) => clip(q(selector)?.textContent, max)
  function screen() {
    const start = q('.start-drive-button')
    return {
      screen:
        q('[aria-label="Drive summary"]') !== null
          ? 'summary'
          : q('.live-top') !== null
            ? 'drive'
            : q('.live-summary') !== null
              ? 'failed'
              : q('.token-screen') !== null
                ? 'token'
                : start !== null
                  ? 'plan'
                  : 'other',
      turn: text('.live-top'),
      banner: text('.live-banner'),
      eta: text('.live-eta'),
      status: text('.live-status'),
      warnings: [...doc.querySelectorAll('.live-warning')].map((el) => clip(el.textContent)),
      alert: text('[role="alert"]'),
      routes: [...doc.querySelectorAll('ol.routes > li')].map((el) => clip(el.textContent, 160)),
      recommended: q('.route-badge') !== null,
      counting: (q('.panel')?.textContent ?? '').includes('Counting signals'),
      startEnabled: start !== null && !start.disabled,
      mapCanvas: q('canvas.mapboxgl-canvas') !== null,
      diagnosticsOpen: q('[aria-label="Diagnostics text"]') !== null,
      visibility: doc.visibilityState,
      size: [win.innerWidth, win.innerHeight],
    }
  }

  // --- The driver script's commands ---------------------------------------
  const sleep = (ms) => new Promise((resolve) => win.setTimeout(resolve, ms))
  const find = (selector, containing) =>
    [...doc.querySelectorAll(selector)].find((el) => containing === undefined || (el.textContent ?? '').includes(containing)) ?? null
  async function carryOut({ cmd, arg = {} }) {
    if (cmd === 'click') {
      // .click() also presses a button the drive view hides (the top bar's Drive diagnostics).
      const el = find(arg.selector, arg.text)
      if (el === null) return { ok: false, value: 'not on the screen' }
      if (el.disabled === true) return { ok: false, value: 'disabled' }
      el.click()
      return { ok: true }
    }
    if (cmd === 'diagnostics') {
      let field = q('[aria-label="Diagnostics text"]')
      const wasOpen = field !== null
      if (!wasOpen) {
        const open = find('.shell-actions button', 'Drive diagnostics')
        if (open === null) return { ok: false, value: 'no Drive diagnostics button' }
        open.click()
        for (let i = 0; i < 40 && field === null; i++) {
          await sleep(50)
          field = q('[aria-label="Diagnostics text"]')
        }
        if (field === null) return { ok: false, value: 'the panel did not open' }
      } else {
        // The panel refreshes every 2 s; Copy refreshes it now (and the clipboard is the simulator's own).
        find('.diagnostics-head button', 'Copy')?.click()
        await sleep(100)
        field = q('[aria-label="Diagnostics text"]')
      }
      const value = field?.value ?? ''
      if (arg.keepOpen !== true) find('.diagnostics-head button', 'Close')?.click()
      return { ok: value !== '', value }
    }
    return { ok: false, value: 'unknown command' }
  }

  // --- The report ----------------------------------------------------------
  let seq = 0
  let lastSentAt = 0
  let inFlightSince = 0
  let contact = false
  function report() {
    const now = Date.now()
    if (now - lastSentAt < 900) return
    // One at a time; a report that never came back is given up on after 8 s.
    if (inFlightSince !== 0 && now - inFlightSince < 8000) return
    lastSentAt = now
    inFlightSince = now
    const sending = results.splice(0)
    const body = {
      seq: ++seq,
      atMs: now,
      transport,
      nativeProblem,
      mapStub,
      mapOff,
      plugin: real !== undefined && real !== null,
      appState,
      counts: { ...counts },
      spoken: spoken.map((line) => line.text),
      ui: screen(),
      errors: errors.slice(),
      results: sending,
    }
    stub('POST', '/sim/report', body)
      .then((answer) => {
        contact = true
        hideProblem()
        const commands = JSON.parse(answer.text).commands ?? []
        for (const command of commands) {
          carryOut(command).then(
            (result) => results.push({ id: command.id, ...result }),
            (e) => results.push({ id: command.id, ok: false, value: clip(e?.message ?? e) }),
          )
        }
      })
      .catch((e) => {
        results.unshift(...sending)
        showProblem(`RouteIQ simulator drive: no answer from the stub server at ${base} (${clip(e?.message ?? e, 120)}${nativeProblem === null ? '' : `; native: ${nativeProblem}`})`)
      })
      .finally(() => {
        inFlightSince = 0
      })
  }

  // On the screen, so a screenshot says why nothing happens.
  let problemBox = null
  function showProblem(message) {
    if (contact || doc.body === null) return
    if (problemBox === null) {
      problemBox = doc.createElement('div')
      problemBox.style.cssText =
        'position:fixed;z-index:99;left:0;right:0;top:40%;padding:12px 16px;background:#a40e26;color:#fff;font:15px/1.4 system-ui;overflow-wrap:anywhere'
      doc.body.appendChild(problemBox)
    }
    problemBox.textContent = message
  }
  function hideProblem() {
    problemBox?.remove()
    problemBox = null
  }

  win.setInterval(report, 1000)
  report()
  return true
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  install(window, document.currentScript)
}
