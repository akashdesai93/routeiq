import { describe, expect, it } from 'vitest'
import { createDriveDiagnostics } from '../src/device/native/diagnostics.ts'
import { createLab } from '../src/lab/lab.ts'
import {
  awayWindows,
  checkFixesWhileAway,
  checkLockedWrongTurn,
  checkNoFailedRequests,
  checkOffRouteThenNewRoute,
  checkPlanShowsRoutes,
  checkRequestAnsweredWhileAway,
  checkScreenDrawn,
  checkSoak,
  checkSpeechFinished,
  checkStayedAway,
  checkSteadyWhileAway,
  checkTicksWhileAway,
  longestStallSec,
  parseDiagnostics,
  parseLabReport,
  planFromCaptions,
  redact,
  runMetrics,
} from '../scripts/phone/lab/assertions.mjs'
import { parseArgs, summaryMarkdown } from '../scripts/phone/lab/run.mjs'

// The phone lab's checks (scripts/phone/lab/assertions.mjs, docs/phone-lab.md). Each check is
// shown to pass on a drive that went well and to fail on the one thing it is there to catch.
// The reports are made by the app's own code (the real diagnostics log and the real lab hook)
// driven through a scripted drive, so a change of their wording that the runner could no
// longer read fails here.

interface Script {
  /** Seconds in the background. */
  awaySec?: number
  /** Stop ticking for this many seconds in the middle of the time away. */
  tickGapSec?: number
  /** No fixes while away. */
  fixesStopAway?: boolean
  /** The car leaves the route while away. */
  offRoute?: boolean
  /** How the request for the new route ends; null: none is sent. */
  reroute?: 'answered' | 'network' | 'http-500' | null
  /** The new route never brings the screen back to driving. */
  staysOffRoute?: boolean
  /** The "New route" line is cut off. */
  speechCutOff?: boolean
  /** The app is never sent to the background. */
  neverAway?: boolean
}

/** A drive as the phone would log it: 20 s in front, the time away, 10 s back in front. */
function drive(script: Script = {}): string {
  const { awaySec = 120, tickGapSec = 0, fixesStopAway = false, offRoute = true, reroute = 'answered', staysOffRoute = false, speechCutOff = false, neverAway = false } = script
  let nowMs = new Date(2026, 10, 11, 21, 40, 0).getTime()
  const status = { textContent: 'Finding your position…' }
  const found: Record<string, unknown[]> = {
    '.live-top': [{ textContent: '300 ft Left: Providence Road' }],
    '.live-bottom': [{ textContent: '' }],
    '.live-turn-distance': [{ textContent: '300 ft' }],
    '.live-eta': [{ textContent: '9:58 12 min 5.1 mi' }],
    '.live-eta strong': [{ textContent: '9:58' }],
    '.live-status': [status],
  }
  const log = createDriveDiagnostics(() => nowMs)
  const lab = createLab({
    scenario: 'drive',
    doc: { querySelector: (s) => found[s]?.[0] ?? null, querySelectorAll: (s) => found[s] ?? [] },
    diagnostics: log,
    now: () => nowMs,
  })
  const second = (ticking = true, fixing = true) => {
    nowMs += 1000
    if (fixing) log.fix()
    if (ticking) log.tick()
    lab.sample()
  }
  const say = (finished = true) => {
    log.speechStarted()
    log.speechEnded(finished)
  }

  lab.sample()
  log.gps(true)
  const first = log.requestSent('routes')
  nowMs += 300
  log.requestEnded(first, 'answered', 200, 280)
  status.textContent = 'Watching for a faster route.'
  say()
  for (let s = 0; s < 20; s++) second()

  if (!neverAway) {
    log.appState('inactive')
    log.appState('background')
  }
  const half = Math.floor(awaySec / 2)
  for (let s = 0; s < half; s++) second(true, !fixesStopAway)
  if (offRoute) {
    status.textContent = 'Off the route. Finding a new one…'
    second(true, !fixesStopAway)
    say()
    if (reroute !== null) {
      const n = log.requestSent('routes')
      nowMs += 400
      if (reroute === 'answered') log.requestEnded(n, 'answered', 200, 380)
      else if (reroute === 'http-500') log.requestEnded(n, 'answered', 500, 380)
      else log.requestEnded(n, 'network')
      if (reroute === 'answered' && !staysOffRoute) {
        status.textContent = 'Watching for a faster route.'
        found['.live-banner'] = [{ textContent: 'New route from here' }]
        say(!speechCutOff)
      }
    }
  }
  if (tickGapSec > 0) nowMs += tickGapSec * 1000
  for (let s = half; s < awaySec; s++) {
    second(true, !fixesStopAway)
    if (s === half + 8) delete found['.live-banner']
  }
  log.appState('active')
  for (let s = 0; s < 10; s++) second()
  return lab.report()
}

const report = (script?: Script) => {
  const parsed = parseLabReport(drive(script))
  if (parsed === null || parsed.diagnostics === null) throw new Error('the report could not be read')
  return { ...parsed, diagnostics: parsed.diagnostics }
}
const failed = (script: Script) =>
  checkLockedWrongTurn(report(script))
    .filter((c) => !c.pass)
    .map((c) => c.name)

const NAMES = {
  fixes: 'position fixes kept arriving while the app was not in front',
  ticks: 'the drive kept running while not in front: no wait of 5 s or more between ticks',
  request: 'a route request went out while not in front and was answered',
  offRoute: 'off the route while away, then a new route: asked for, answered, and driving again',
  speech: 'every spoken line that started also finished',
}

describe('reading what the app wrote', () => {
  it('reads the counts and the events of a drive out of the lab report', () => {
    const r = report()
    expect(r).toMatchObject({ scenario: 'drive', screen: 'drive', status: 'driving', turnCard: true, arrivalTime: true })
    expect(r.diagnostics.fixes).toEqual({ count: 151, away: 121, longestGapSec: 1 })
    expect(r.diagnostics.ticks.away).toBe(121)
    expect(r.diagnostics.requests).toEqual({ sent: 2, away: 1, answered: 2, failed: 0, cancelled: 0, waiting: 0 })
    expect(r.diagnostics.speech).toEqual({ started: 3, finished: 3, cutOff: 0 })
    expect(r.diagnostics.events.find((e) => e.what === 'request 2 sent')).toEqual({ time: '21:41:21', what: 'request 2 sent', state: 'background' })
    expect(r.history.map((h) => h.what)).toEqual(['status locating', 'status driving', 'status off-route', 'status driving', 'banner new-route-after-off-route', 'banner gone'])
  })

  it('text that is not a report or not a diagnostics log is null, not zeros', () => {
    expect(parseLabReport('')).toBeNull()
    expect(parseLabReport('RouteIQ lab report\nnothing else')).toBeNull()
    expect(parseDiagnostics('fixes: 3 (1 while not active), longest gap 1 s')).toBeNull()
    expect(parseDiagnostics(undefined)).toBeNull()
  })
})

describe('"drives locked with a wrong turn": each check passes on a good drive and fails on its own fault', () => {
  it('a good drive passes all five checks', () => {
    const checks = checkLockedWrongTurn(report())
    expect(checks.map((c) => c.name)).toEqual(Object.values(NAMES))
    expect(checks.every((c) => c.pass)).toBe(true)
  })

  it('the position NOT replayed (the car never leaves the route): the off-route check fails, and only checks that depend on it', () => {
    expect(failed({ offRoute: false })).toEqual([NAMES.request, NAMES.offRoute])
    expect(checkOffRouteThenNewRoute(report({ offRoute: false })).detail).toBe('the car never left the route: no "New route from here" on the screen')
  })

  it('fixes stop while away: the fixes check fails', () => {
    expect(failed({ fixesStopAway: true })).toEqual([NAMES.fixes])
  })

  it('too few fixes while away (30 or fewer): the fixes check fails; 31 pass', () => {
    const d = report().diagnostics
    expect(checkFixesWhileAway({ ...d, fixes: { ...d.fixes, away: 30 } }).pass).toBe(false)
    expect(checkFixesWhileAway({ ...d, fixes: { ...d.fixes, away: 31 } }).pass).toBe(true)
  })

  it('the web code stood still for 6 s while away: the ticks check fails and names the wait', () => {
    expect(failed({ tickGapSec: 6 })).toEqual([NAMES.ticks])
    expect(checkTicksWhileAway(report({ tickGapSec: 6 }).diagnostics).detail).toMatch(/no tick for 7 s \[background\]/)
  })

  it('a wait of 3 s is not a fault', () => {
    expect(failed({ tickGapSec: 3 })).toEqual([])
  })

  it('the app never left the front: the ticks check fails, because it showed nothing', () => {
    const check = checkTicksWhileAway(report({ neverAway: true }).diagnostics)
    expect(check.pass).toBe(false)
    expect(check.detail).toMatch(/never left the front/)
  })

  it('a long wait whose event fell out of the log is still caught, by the longest wait of the drive', () => {
    const d = report().diagnostics
    expect(checkTicksWhileAway({ ...d, eventsDropped: true, ticks: { ...d.ticks, longestGapSec: 9 } }).pass).toBe(false)
    expect(checkTicksWhileAway({ ...d, eventsDropped: true }).pass).toBe(true)
  })

  it('the route request went out while away but the network failed: the request and off-route checks fail', () => {
    expect(failed({ reroute: 'network' })).toEqual([NAMES.request, NAMES.offRoute])
  })

  it('an HTTP 500 is not an answer', () => {
    expect(checkRequestAnsweredWhileAway(report({ reroute: 'http-500' }).diagnostics).pass).toBe(false)
  })

  it('off the route and no request for a new one: the off-route check fails', () => {
    expect(failed({ reroute: null })).toContain(NAMES.offRoute)
  })

  it('off the route, a new route answered, but the screen never goes back to driving: the off-route check fails', () => {
    expect(failed({ staysOffRoute: true })).toEqual([NAMES.offRoute])
  })

  it('a route switched for being faster is not a new route after leaving the route', () => {
    const r = report()
    const switched = { ...r, history: r.history.map((h) => (h.what === 'banner new-route-after-off-route' ? { ...h, what: 'banner switched-route' } : h)) }
    expect(checkOffRouteThenNewRoute(switched).pass).toBe(false)
  })

  it('a new route whose request went out a minute earlier does not count as asked for off the route', () => {
    const r = report()
    const late = { ...r, history: r.history.map((h) => (h.what === 'banner new-route-after-off-route' ? { ...h, time: '21:42:40' } : h)) }
    expect(checkOffRouteThenNewRoute(r).pass).toBe(true)
    expect(checkOffRouteThenNewRoute(late).pass).toBe(false)
  })

  it('a new route that came with the app in front shows nothing about being away', () => {
    const r = report()
    const inFront = { ...r, history: r.history.map((h) => (h.what === 'banner new-route-after-off-route' ? { ...h, time: '21:40:10' } : h)) }
    const check = checkOffRouteThenNewRoute(inFront)
    expect(check.pass).toBe(false)
    expect(check.detail).toMatch(/the app was in front then/)
  })

  it('the app came back to the front by itself after 40 of 120 s: the stayed-away check fails; the full time passes', () => {
    const d = report().diagnostics
    expect(awayWindows(d)).toEqual([{ from: 21 * 3600 + 40 * 60 + 20, to: 21 * 3600 + 42 * 60 + 21 }])
    expect(checkStayedAway(d, 120).pass).toBe(true)
    const early = { ...d, events: d.events.map((e) => (e.what === 'app active' ? { ...e, time: '21:41:00' } : e)) }
    expect(checkStayedAway(early, 120).pass).toBe(false)
    expect(checkStayedAway(report({ neverAway: true }).diagnostics, 120).detail).toBe('the app never went to the background')
    expect(checkLockedWrongTurn(report(), 120)[0].name).toBe('the app stayed in the background until the lab brought it back')
  })

  it('a spoken line cut off: the speech check fails', () => {
    expect(failed({ speechCutOff: true })).toEqual([NAMES.speech])
  })

  it('nothing spoken at all is not "all finished"', () => {
    const d = report().diagnostics
    expect(checkSpeechFinished({ ...d, speech: { started: 0, finished: 0, cutOff: 0 } }).pass).toBe(false)
  })

  it('no report from the app: the checks are "not run", which is not a pass', () => {
    const checks = checkLockedWrongTurn(null)
    expect(checks).toHaveLength(1)
    expect(checks[0]).toMatchObject({ pass: false, notRun: true })
  })
})

describe('is the screen drawn, and how long did the drive stand still', () => {
  it('a screenshot that is all black fails; a drawn screen passes; no screenshot is "not run"', () => {
    const black = checkScreenDrawn({ flat: 1, shade: 0 }, '8 s after the drive started')
    expect(black.pass).toBe(false)
    expect(black.detail).toBe('100 % of the screen is black: nothing was painted')
    expect(checkScreenDrawn({ flat: 0.981, shade: 250 }, 'x').detail).toBe('98.1 % of the screen is white: nothing was painted')
    // The driving screen as drawn on the phone: the map takes most of it, in many shades.
    expect(checkScreenDrawn({ flat: 0.42, shade: 236 }, 'x').pass).toBe(true)
    expect(checkScreenDrawn({ flat: 0.969, shade: 5 }, 'x').pass).toBe(true)
    expect(checkScreenDrawn({ flat: 0.97, shade: 5 }, 'x').pass).toBe(false)
    expect(checkScreenDrawn(null, 'x')).toMatchObject({ pass: false, notRun: true })
  })

  it('the longest stop while away is the longest logged wait after leaving the front, and 0 when there was none', () => {
    expect(longestStallSec(report().diagnostics)).toBe(0)
    expect(longestStallSec(report({ tickGapSec: 38 }).diagnostics)).toBe(39)
    expect(longestStallSec(report({ neverAway: true, tickGapSec: 38 }).diagnostics)).toBe(0)
  })

  it('the numbers of a run are read off the report', () => {
    const numbers = Object.fromEntries(runMetrics(report({ tickGapSec: 38 })))
    expect(numbers['seconds in the background']).toBe(159)
    expect(numbers['fixes while not active']).toBe(121)
    expect(numbers['longest stop while away, seconds (limit 5)']).toBe(39)
    expect(numbers['route requests: sent / answered / failed']).toBe('2 / 2 / 0')
    expect(numbers['spoken lines: started / finished / cut off']).toBe('3 / 3 / 0')
    expect(numbers['new routes after leaving the route']).toBe(1)
    expect(runMetrics(null)).toEqual([])
  })
})

describe('the soak', () => {
  it('passes on a steady 10 minutes away, and fails when fixes come at half the rate', () => {
    const good = report({ awaySec: 600 })
    expect(checkSoak(good, 10).filter((c) => !c.pass)).toEqual([])
    const d = good.diagnostics
    expect(checkSteadyWhileAway({ ...d, fixes: { ...d.fixes, away: 299 } }, 10).pass).toBe(false)
    expect(checkSteadyWhileAway({ ...d, ticks: { ...d.ticks, away: 299 } }, 10).pass).toBe(false)
  })

  it('a failed route request fails the soak', () => {
    const d = report({ reroute: 'network' }).diagnostics
    expect(checkNoFailedRequests(d).pass).toBe(false)
    expect(checkNoFailedRequests(report().diagnostics).pass).toBe(true)
  })
})

describe('"starts and plans"', () => {
  it('needs at least one route and the Start drive button', () => {
    expect(checkPlanShowsRoutes({ routes: 4, startDrive: true }).pass).toBe(true)
    expect(checkPlanShowsRoutes({ routes: 0, startDrive: true }).pass).toBe(false)
    expect(checkPlanShowsRoutes({ routes: 4, startDrive: false }).pass).toBe(false)
  })

  it('counts the routes a screen reader finds on a build without the lab hook', () => {
    const captions = ['Drive diagnostics, Button', 'Origin, Uptown Charlotte (Trade & Tryon)', 'Routes, 2, Header', 'Start drive, Button', 'Route 1 Recommended 18 min 9.2 mi 18 signals, 1, Button, Toggle', 'Route 2 18 min 6.4 mi 30 signals, 0, Button, Toggle']
    expect(planFromCaptions(captions)).toEqual({ routes: 2, startDrive: true, tokenScreen: false })
    expect(planFromCaptions(['Finding routes…'])).toMatchObject({ routes: 0, startDrive: false })
    expect(planFromCaptions(null)).toMatchObject({ routes: 0, startDrive: false })
  })
})

describe('what goes into a report folder', () => {
  it('identifiers, coordinates and tokens are taken out of tool and system-log lines', () => {
    const line = 'device 00008140-001A2B3C4D5E6F78 app dev.routeiq.shell.AB12CD34EF at 35.22716,-80.84316 pk.eyJ1Ijoibm90LWEtcmVhbC10b2tlbiJ9.c2lnbmF0dXJl 0123456789abcdef0123456789abcdef01234567 CF1BB90B-166E-43CF-9193-AC76C02B34C6'
    expect(redact(line)).toBe('device <id> app dev.routeiq.shell.<team> at <number>,<number> <token> <id> <id>')
    // A time of day with fractions of a second is not a coordinate.
    expect(redact('2026-11-11 22:09:36.123456 App at -80.84316')).toBe('2026-11-11 22:09:36.123456 App at <number>')
  })

  it('the summary says FAIL, NOT RUN and whether the simulated position was cleared', () => {
    const text = summaryMarkdown({
      scenario: 'locked-wrong-turn',
      options: 'app in the background',
      device: { model: 'iPhone', ios: '26' },
      app: 'RouteIQ 1.0 (1)',
      steps: ['21:40:00 app started'],
      checks: [
        { name: 'a', pass: true, detail: 'fine' },
        { name: 'b', pass: false, detail: 'broken' },
        { name: 'c', pass: false, notRun: true, detail: 'no report' },
      ],
      samples: [],
      simulated: { from: '21:40:00', to: '21:45:00', cleared: false },
      files: ['summary.md'],
      result: 'FAILED (1 of 3 checks)',
    })
    expect(text).toContain('| a | pass | fine |')
    expect(text).toContain('| b | FAIL | broken |')
    expect(text).toContain('| c | NOT RUN | no report |')
    expect(text).toContain('from 21:40:00 to 21:45:00. Cleared at the end: NO')
  })

  it('the runner refuses a scenario it does not know and reads its options', () => {
    expect(parseArgs([])).toHaveProperty('error')
    expect(parseArgs(['--scenario', 'nope'])).toHaveProperty('error')
    expect(parseArgs(['--scenario', 'locked-wrong-turn', '--no-gps', '--away-sec', '90'])).toMatchObject({ scenario: 'locked-wrong-turn', gps: false, lock: false, inApp: false, awaySec: 90 })
    // Sleep ends the PC's connection, so a locked run moves the car inside the app.
    expect(parseArgs(['--scenario', 'locked-wrong-turn', '--lock', '--owner-unlocks-after'])).toMatchObject({ lock: true, inApp: true })
    // It leaves the phone dark, so it has to be asked for in so many words.
    expect(parseArgs(['--scenario', 'locked-wrong-turn', '--lock'])).toHaveProperty('error')
    expect(parseArgs(['--scenario', 'locked-wrong-turn', '--lock', '--owner-unlocks-after', '--no-gps'])).toHaveProperty('error')
    expect(parseArgs(['--scenario', 'background-soak', '--lock', '--owner-unlocks-after'])).toHaveProperty('error')
    expect(parseArgs(['--scenario', 'drive-screen', '--fix', 'resize'])).toMatchObject({ scenario: 'drive-screen', fix: 'resize' })
    expect(parseArgs(['--scenario', 'locked-wrong-turn', '--fix', 'resize'])).toHaveProperty('error')
  })
})
