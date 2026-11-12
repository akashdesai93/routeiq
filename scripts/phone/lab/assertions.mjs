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
  return {
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

/**
 * The car left the route and got a new one: the screen showed "off the route", a route request
 * (not a side-street probe) went out and was answered after that, and the screen went back to
 * driving.
 */
export function checkOffRouteThenNewRoute(report) {
  const name = 'off the route, then a new route: asked for, answered, and driving again'
  const d = report.diagnostics
  const off = report.history.findIndex((h) => h.what === 'status off-route')
  if (off === -1) return verdict(name, false, 'the screen never showed "off the route"')
  const offAt = report.history[off].time
  const back = report.history.slice(off + 1).find((h) => h.what === 'status driving')
  if (back === undefined) return verdict(name, false, `off the route at ${offAt}, and never driving again after it`)
  if (d === null) return verdict(name, false, 'no diagnostics to find the route request in')
  const asked = d.events.filter((e) => e.time >= offAt && e.time <= back.time).flatMap((e) => (e.what.match(/^request (\d+) sent$/) ?? []).slice(1))
  const answered = asked.filter((n) => d.events.some((e) => new RegExp(`^request ${n} answered, HTTP 2\\d\\d,`).test(e.what)))
  return verdict(
    name,
    answered.length > 0,
    `off the route at ${offAt}, driving again at ${back.time}, ${asked.length} route request(s) in between, ${answered.length} answered`,
  )
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
export function checkLockedWrongTurn(report) {
  const d = report?.diagnostics ?? null
  if (d === null) return [notRun('drive diagnostics', 'no lab report with diagnostics came back from the app')]
  return [checkFixesWhileAway(d), checkTicksWhileAway(d), checkRequestAnsweredWhileAway(d), checkOffRouteThenNewRoute(report), checkSpeechFinished(d)]
}

/** The checks of the soak. */
export function checkSoak(report, awayMinutes) {
  const d = report?.diagnostics ?? null
  if (d === null) return [notRun('drive diagnostics', 'no lab report with diagnostics came back from the app')]
  return [checkSteadyWhileAway(d, awayMinutes), checkTicksWhileAway(d), checkRequestAnsweredWhileAway(d), checkNoFailedRequests(d), checkSpeechFinished(d)]
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
    .replace(/-?\d{1,3}\.\d{4,}/g, '<number>')
    .replace(/(dev\.routeiq\.shell)\.[A-Z0-9]{6,}/g, '$1.<team>')
}
