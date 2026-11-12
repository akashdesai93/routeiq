// What the phone lab checks (docs/phone-lab.md). Pure: text in, verdicts out, so every check
// is shown to pass and to fail in tests/phoneLab.test.ts without a phone.
//
// The text comes from the app: the drive diagnostics (src/device/native/diagnostics.ts) and the
// lab's report around it (src/lab/lab.ts). Both hold counts, times of day and fixed words only.

/** The thresholds of the checks, in one place. */
export const DEFAULT_LAB_CHECKS = Object.freeze({
  /** Position fixes that must arrive while the app is not in front. */
  minFixesAway: 30,
  /** Ticks (the live session being asked "is anything due?") that must arrive while not in front. */
  minTicksAway: 30,
  /** For the soak: fixes and ticks per minute spent away, at least. */
  minBeatsPerAwayMinute: 30,
  /** A screenshot with this share of its pixels in one flat colour, or more, is a screen that was not drawn. */
  maxFlatShare: 0.97,
  /** drive-screen: the driving screen must be drawn this soon after Start drive, in seconds (#136). */
  maxDrawnSec: 2,
  /** drive-screen: how long the screen is watched after Start drive, in seconds. */
  drawWatchSec: 40,
  /** The longest the drive may stand still (no tick) while the app is away, in seconds. The app logs waits from 5 s up. */
  maxStallSec: 5,
})

const count = (text, pattern) => {
  const m = text.match(pattern)
  return m === null ? null : m.slice(1).map(Number)
}

/**
 * The drive diagnostics text as numbers and events. Null when the text is not a diagnostics log.
 * An event: { time: 'HH:MM:SS', what, state } where state is the app's state when it was logged.
 */
export function parseDiagnostics(text) {
  if (typeof text !== 'string' || !text.includes('RouteIQ drive diagnostics')) return null
  const head = text.match(/log started (\d\d:\d\d:\d\d), now (\d\d:\d\d:\d\d), app (\w+), gps (on|off)/)
  const fixes = count(text, /^fixes: (\d+) \((\d+) while not active\), longest gap (\d+) s$/m)
  const ticks = count(text, /^ticks: (\d+) \((\d+) while not active\), longest gap (\d+) s$/m)
  const requests = count(text, /^requests: (\d+) sent \((\d+) while not active\), (\d+) answered, (\d+) failed, (\d+) cancelled, (\d+) waiting$/m)
  const speech = count(text, /^speech: (\d+) lines started, (\d+) finished, (\d+) cut off or failed$/m)
  if (head === null || fixes === null || ticks === null || requests === null || speech === null) return null
  const events = []
  const after = text.slice(text.indexOf('\nevents ('))
  for (const m of after.matchAll(/^(\d\d:\d\d:\d\d) (.+) \[(active|inactive|background|unknown)\]$/gm)) {
    events.push({ time: m[1], what: m[2], state: m[3] })
  }
  return {
    startedAt: head[1],
    now: head[2],
    appState: head[3],
    gpsOn: head[4] === 'on',
    fixes: { count: fixes[0], away: fixes[1], longestGapSec: fixes[2] },
    ticks: { count: ticks[0], away: ticks[1], longestGapSec: ticks[2] },
    requests: { sent: requests[0], away: requests[1], answered: requests[2], failed: requests[3], cancelled: requests[4], waiting: requests[5] },
    speech: { started: speech[0], finished: speech[1], cutOff: speech[2] },
    events,
    eventsDropped: /earlier ones dropped/.test(after),
  }
}

/** The lab's report file: its header, the history of what the screen showed, and the diagnostics. Null when it is not one. */
export function parseLabReport(text) {
  if (typeof text !== 'string' || !text.startsWith('RouteIQ lab report')) return null
  const head = text.match(/^scenario ([a-z0-9-]+), written (\d\d:\d\d:\d\d), number (\d+)$/m)
  const screen = text.match(/^screen (\w+), status ([\w-]+), routes (\d+), turn card (shown|none), arrival time (shown|none), warnings (\d+)$/m)
  const split = text.indexOf('\n--- diagnostics ---\n')
  if (head === null || screen === null || split === -1) return null
  const history = []
  for (const m of text.slice(0, split).matchAll(/^(\d\d:\d\d:\d\d) (.+)$/gm)) history.push({ time: m[1], what: m[2] })
  const native = text.match(/^native (\{.*\})$/m)
  let nativeProbe = null
  try {
    nativeProbe = native === null ? null : JSON.parse(native[1])
  } catch {
    nativeProbe = null
  }
  return {
    native: nativeProbe,
    startPressedAt: history.find((h) => h.what === 'pressed "Start drive"')?.time ?? null,
    scenario: head[1],
    writtenAt: head[2],
    number: Number(head[3]),
    screen: screen[1],
    status: screen[2],
    routes: Number(screen[3]),
    turnCard: screen[4] === 'shown',
    arrivalTime: screen[5] === 'shown',
    warnings: Number(screen[6]),
    history,
    diagnostics: parseDiagnostics(text.slice(split + '\n--- diagnostics ---\n'.length)),
  }
}

/**
 * What the accessibility service read off the plan screen (one caption per element), for a
 * build without the lab: how many routes are listed and whether Start drive is there.
 */
export function planFromCaptions(captions) {
  const list = Array.isArray(captions) ? captions.filter((c) => typeof c === 'string') : []
  return {
    routes: list.filter((c) => /^Route \d+ /.test(c)).length,
    startDrive: list.some((c) => /^Start drive, Button/.test(c)),
    tokenScreen: list.some((c) => /token/i.test(c) && /paste|save/i.test(c)) && !list.some((c) => /^Origin/.test(c)),
  }
}

const verdict = (name, pass, detail) => ({ name, pass, detail })
/** A check that could not be made: counts as not passed, and says why. */
export const notRun = (name, why) => ({ name, pass: false, notRun: true, detail: why })

const isAway = (state) => state !== 'active'

/** Fixes kept arriving while the app was not in front. */
export function checkFixesWhileAway(d, min = DEFAULT_LAB_CHECKS.minFixesAway) {
  return verdict('position fixes kept arriving while the app was not in front', d.fixes.away > min, `${d.fixes.away} fixes while not active (more than ${min} needed), ${d.fixes.count} in all`)
}

/**
 * Ticks kept coming while away: enough of them, and no wait of 5 s or more from the moment the
 * app first left the front. (The app logs "no tick for N s" for every wait of 5 s or more while
 * the GPS is on; one logged just after coming back is a wait that happened while away.)
 */
export function checkTicksWhileAway(d, min = DEFAULT_LAB_CHECKS.minTicksAway) {
  const name = 'the drive kept running while not in front: no wait of 5 s or more between ticks'
  const left = d.events.findIndex((e) => /^app (inactive|background)$/.test(e.what))
  if (left === -1) return verdict(name, false, 'the app never left the front, so this shows nothing')
  const gaps = d.events.slice(left).filter((e) => /^no tick for \d+ s$/.test(e.what))
  if (gaps.length > 0) return verdict(name, false, `${gaps.length} long wait(s): ${gaps.map((e) => `${e.time} ${e.what} [${e.state}]`).join('; ')}`)
  // The log keeps the newest 200 events. When older ones were dropped, the longest wait of the
  // whole drive (which is never dropped) has to be under 5 s as well.
  if (d.eventsDropped && d.ticks.longestGapSec >= 5) return verdict(name, false, `the longest wait between ticks was ${d.ticks.longestGapSec} s (its event was dropped from the log)`)
  return verdict(name, d.ticks.away > min, `${d.ticks.away} ticks while not active (more than ${min} needed), no wait of 5 s or more`)
}

/** At least one route request was sent while away, and Mapbox answered it. */
export function checkRequestAnsweredWhileAway(d) {
  const name = 'a route request went out while not in front and was answered'
  const sent = d.events.filter((e) => isAway(e.state)).flatMap((e) => (e.what.match(/^request (\d+)(?: \((?:probe|path check)\))? sent$/) ?? []).slice(1))
  if (sent.length === 0) return verdict(name, false, `no request was sent while not active (${d.requests.sent} sent in all)`)
  const answered = sent.filter((n) => d.events.some((e) => new RegExp(`^request ${n}(?: \\((?:probe|path check)\\))? answered, HTTP 2\\d\\d,`).test(e.what)))
  return verdict(name, answered.length > 0, `${sent.length} sent while not active, ${answered.length} of them answered with HTTP 2xx`)
}

const toSec = (time) => {
  const [h, m, sec] = time.split(':').map(Number)
  return h * 3600 + m * 60 + sec
}

/** A new route is asked for at once when the car is off the route; the banner follows the answer within this many seconds. */
const NEW_ROUTE_WINDOW_SEC = 15

/**
 * The car left the route and got a new one. The app shows "New route from here" only for a
 * route it took because the car was off the route, so that banner is the evidence, together
 * with the route request (not a side-street probe) that went out just before it and was
 * answered, and the drive going on afterwards. "Off the route" itself is on the screen for
 * less than a second when Mapbox answers quickly, so it is not required to have been seen.
 */
export function checkOffRouteThenNewRoute(report) {
  const name = 'off the route while away, then a new route: asked for, answered, and driving again'
  const d = report.diagnostics
  const newRoutes = report.history.filter((h) => h.what === 'banner new-route-after-off-route')
  if (newRoutes.length === 0) {
    const off = report.history.find((h) => h.what === 'status off-route')
    return verdict(name, false, off === undefined ? 'the car never left the route: no "New route from here" on the screen' : `off the route at ${off.time}, and no new route after it`)
  }
  if (d === null) return verdict(name, false, 'no diagnostics to find the route request in')
  const away = awayWindows(d)
  const whileAway = newRoutes.filter((h) => away.some((w) => toSec(h.time) >= w.from && toSec(h.time) <= w.to))
  if (whileAway.length === 0) return verdict(name, false, `a new route at ${newRoutes.map((h) => h.time).join(', ')}, but the app was in front then: that shows nothing about being away`)
  const answeredFor = (h) => {
    const at = toSec(h.time)
    const asked = d.events.filter((e) => at - toSec(e.time) >= 0 && at - toSec(e.time) <= NEW_ROUTE_WINDOW_SEC).flatMap((e) => (e.what.match(/^request (\d+) sent$/) ?? []).slice(1))
    return asked.filter((n) => d.events.some((e) => new RegExp(`^request ${n} answered, HTTP 2\\d\\d,`).test(e.what))).length
  }
  const good = whileAway.filter((h) => answeredFor(h) > 0)
  const driving = report.status === 'driving'
  return verdict(
    name,
    good.length > 0 && driving,
    `${whileAway.length} new route(s) from where the car was while away (${whileAway.map((h) => h.time).join(', ')}), ${good.length} with an answered route request just before, ${driving ? 'driving on at the end' : `at the end the screen showed "${report.status}"`}`,
  )
}

/** The stretches the app spent in the background, in seconds of the day: from "app background" to the next "app active" (or the end of the log). */
export function awayWindows(d) {
  const windows = []
  let from = null
  for (const e of d.events) {
    if (e.what === 'app background' && from === null) from = toSec(e.time)
    else if (e.what === 'app active' && from !== null) {
      windows.push({ from, to: toSec(e.time) })
      from = null
    }
  }
  if (from !== null) windows.push({ from, to: toSec(d.now) })
  return windows
}

/**
 * The app stayed in the background for the time the lab meant it to. If iOS brought it back
 * to the front early (or it never left), the other checks cover less than they claim.
 */
export function checkStayedAway(d, expectedSec) {
  const name = 'the app stayed in the background until the lab brought it back'
  const windows = awayWindows(d)
  const longest = windows.reduce((best, w) => Math.max(best, w.to - w.from), 0)
  const need = Math.round(expectedSec * 0.9)
  return verdict(name, longest >= need, windows.length === 0 ? 'the app never went to the background' : `in the background for ${longest} s in one stretch (${need} s needed, ${windows.length} stretch(es))`)
}

/**
 * The screen was drawn: a screenshot is not (nearly) all one flat colour. `look` is what
 * device.py measured on the screenshot: { flat, shade }, or null when it could not.
 */
export function checkScreenDrawn(look, when, max = DEFAULT_LAB_CHECKS.maxFlatShare) {
  const name = `the screen is drawn ${when}`
  if (look === null || look === undefined) return notRun(name, 'the screenshot could not be taken or measured')
  const percent = Math.round(look.flat * 1000) / 10
  const colour = look.shade < 40 ? 'black' : look.shade > 215 ? 'white' : `grey ${look.shade}`
  return verdict(name, look.flat < max, look.flat < max ? `${percent} % of the screen is one flat colour (under ${max * 100} %)` : `${percent} % of the screen is ${colour}: nothing was painted`)
}

/** The longest the drive stood still while the app was away, in seconds (0: never 5 s or more). */
export function longestStallSec(d) {
  const left = d.events.findIndex((e) => /^app (inactive|background)$/.test(e.what))
  if (left === -1) return 0
  return d.events.slice(left).reduce((longest, e) => Math.max(longest, Number((e.what.match(/^no tick for (\d+) s$/) ?? [0, 0])[1])), 0)
}

/** The numbers of a run, for the summary and for comparing one build with another. */
export function runMetrics(report) {
  const d = report?.diagnostics ?? null
  if (d === null) return []
  const away = awayWindows(d).reduce((sum, w) => sum + (w.to - w.from), 0)
  return [
    ['seconds in the background', away],
    ['fixes while not active', d.fixes.away],
    ['ticks while not active', d.ticks.away],
    [`longest stop while away, seconds (limit ${DEFAULT_LAB_CHECKS.maxStallSec})`, longestStallSec(d)],
    ['longest wait between fixes in the whole drive, seconds', d.fixes.longestGapSec],
    ['route requests sent while not active', d.requests.away],
    ['route requests: sent / answered / failed', `${d.requests.sent} / ${d.requests.answered} / ${d.requests.failed}`],
    ['spoken lines: started / finished / cut off', `${d.speech.started} / ${d.speech.finished} / ${d.speech.cutOff}`],
    ['new routes after leaving the route', report.history.filter((h) => h.what === 'banner new-route-after-off-route').length],
  ]
}

/** Every line the app started saying, it finished. */
export function checkSpeechFinished(d) {
  const { started, finished, cutOff } = d.speech
  return verdict('every spoken line that started also finished', started > 0 && finished === started && cutOff === 0, `${started} started, ${finished} finished, ${cutOff} cut off or failed`)
}

/** Nothing the app asked Mapbox failed or was left hanging. */
export function checkNoFailedRequests(d) {
  const { sent, answered, failed, waiting } = d.requests
  return verdict('no route request failed', sent > 0 && failed === 0 && waiting <= 1, `${sent} sent, ${answered} answered, ${failed} failed, ${waiting} waiting`)
}

/** For the soak: fixes and ticks at a steady rate for the whole time away. */
export function checkSteadyWhileAway(d, awayMinutes, perMinute = DEFAULT_LAB_CHECKS.minBeatsPerAwayMinute) {
  const need = Math.round(awayMinutes * perMinute)
  return verdict(
    `fixes and ticks kept coming for ${awayMinutes} min away`,
    d.fixes.away >= need && d.ticks.away >= need,
    `${d.fixes.away} fixes and ${d.ticks.away} ticks while not active (${need} each needed)`,
  )
}

/** The plan screen came up with routes on it. `seen`: { routes, startDrive } from the lab report or the screen reader. */
export function checkPlanShowsRoutes(seen) {
  return verdict('the app starts and the plan screen lists routes', seen.routes > 0 && seen.startDrive, `${seen.routes} route(s) listed, Start drive ${seen.startDrive ? 'there' : 'missing'}`)
}

/** The checks of the "drives locked with a wrong turn" scenario, from the last lab report. */
export function checkLockedWrongTurn(report, awaySec) {
  const d = report?.diagnostics ?? null
  if (d === null) return [notRun('drive diagnostics', 'no lab report with diagnostics came back from the app')]
  return [
    ...(awaySec === undefined ? [] : [checkStayedAway(d, awaySec)]),
    checkFixesWhileAway(d),
    checkTicksWhileAway(d),
    checkRequestAnsweredWhileAway(d),
    checkOffRouteThenNewRoute(report),
    checkSpeechFinished(d),
  ]
}

/** The checks of the soak. */
export function checkSoak(report, awayMinutes) {
  const d = report?.diagnostics ?? null
  if (d === null) return [notRun('drive diagnostics', 'no lab report with diagnostics came back from the app')]
  return [checkStayedAway(d, awayMinutes * 60), checkSteadyWhileAway(d, awayMinutes), checkTicksWhileAway(d), checkRequestAnsweredWhileAway(d), checkNoFailedRequests(d), checkSpeechFinished(d)]
}

/**
 * Takes anything that looks like a device identifier, a coordinate or a token out of a line of
 * tool or system-log output before it is written to a report.
 */
export function redact(line) {
  return String(line)
    .replace(/\b[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}\b/g, '<id>')
    .replace(/\b[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\b/g, '<id>')
    .replace(/\b[0-9a-fA-F]{24,}\b/g, '<id>')
    .replace(/\b[ps]k\.[A-Za-z0-9_-]{10,}(\.[A-Za-z0-9_-]+)?/g, '<token>')
    .replace(/(?<![:\d])-?\d{1,3}\.\d{4,}/g, '<number>')
    .replace(/(dev\.routeiq\.shell)\.[A-Z0-9]{6,}/g, '$1.<team>')
}

/**
 * When the driving screen was first drawn, from screenshots taken one after another after Start
 * drive (#136): `samples` are `{ sec, look }` with `sec` the seconds since the drive started.
 * `drawnSec`: the first sample that was drawn, or null when none was. `blackAgain`: a sample
 * after it was flat again (the screen went black once more). `watchedSec`: the last sample.
 */
export function firstDrawn(samples, max = DEFAULT_LAB_CHECKS.maxFlatShare) {
  const list = (Array.isArray(samples) ? samples : []).filter((s) => typeof s?.sec === 'number' && s.look != null).sort((a, b) => a.sec - b.sec)
  const at = list.findIndex((s) => s.look.flat < max)
  return {
    drawnSec: at === -1 ? null : list[at].sec,
    blackAgain: at !== -1 && list.slice(at + 1).some((s) => s.look.flat >= max),
    watchedSec: list.length === 0 ? null : list[list.length - 1].sec,
    measured: list.length,
  }
}

/** The driving screen was drawn within `limitSec` of Start drive and stayed drawn. */
export function checkDrawnWithin(samples, limitSec = DEFAULT_LAB_CHECKS.maxDrawnSec, max = DEFAULT_LAB_CHECKS.maxFlatShare) {
  const name = `the driving screen is drawn within ${limitSec} s of Start drive and stays drawn`
  const seen = firstDrawn(samples, max)
  if (seen.measured === 0) return notRun(name, 'no screenshot could be taken or measured')
  if (seen.drawnSec === null) return verdict(name, false, `never drawn in ${Math.round(seen.watchedSec)} s (${seen.measured} screenshots)`)
  const when = `first drawn ${seen.drawnSec.toFixed(1)} s after Start drive`
  if (seen.blackAgain) return verdict(name, false, `${when}, then flat again`)
  return verdict(name, seen.drawnSec <= limitSec, `${when} (${seen.measured} screenshots over ${Math.round(seen.watchedSec)} s)`)
}

/** The native probe's numbers worth a line each in the summary (#136). Empty without a probe. */
export function nativeMetrics(probe) {
  if (probe === null || typeof probe !== 'object') return []
  const out = []
  const stall = probe.stall ?? {}
  if (typeof stall.longestMs === 'number') out.push(['longest main-thread stall, ms (at s after launch)', `${stall.longestMs} (${stall.longestAt})`])
  if (typeof stall.longestSinceDriveMs === 'number') out.push(['longest main-thread stall since Start drive, ms', stall.longestSinceDriveMs])
  if (typeof probe.terminations === 'number') out.push(['web content process ended', probe.terminations])
  const web = probe.webView
  if (web !== null && typeof web === 'object') {
    out.push(['web view: in window, hidden, opaque, layer in tree', `${web.inWindow}, ${web.hidden}, ${web.opaque}, ${web.layerInTree}`])
    out.push(['web view frame, safe area (top left bottom right)', `${JSON.stringify(web.frame)}, ${JSON.stringify(web.safeArea)}`])
  }
  const scroll = probe.scrollView
  if (scroll !== null && typeof scroll === 'object') out.push(['scroll view: offset, content size, adjusted inset, behaviour', `${JSON.stringify(scroll.offset)}, ${JSON.stringify(scroll.contentSize)}, ${JSON.stringify(scroll.adjustedInset)}, ${scroll.behavior}`])
  if (probe.snapshot) out.push(['native snapshot (flat share, shade)', `${probe.snapshot.flat ?? '?'}, ${probe.snapshot.shade ?? '?'}`])
  return out
}
