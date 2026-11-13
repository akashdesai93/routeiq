import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DEFAULT_LIVE_OPTIONS, DEFAULT_REROUTE_OPTIONS } from '../src/core'
import * as diagnostics from '../src/device/native/diagnostics.ts'
import { createDriveDiagnostics } from '../src/device/native/diagnostics.ts'
import {
  CHECK_LABELS,
  DEFAULT_REPORT_OPTIONS,
  PROBE_SKIP_LABELS,
  analyse,
  parseTally,
  reportText,
  type DriveReport,
} from '../scripts/drive-report.mjs'

// #202: the drive report reads the diagnostics text the owner pastes after a commute.
// The fixtures are written by hand in the app's format, never a real drive's log.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/drive-report/${name}`, import.meta.url), 'utf8')

const ids = (r: DriveReport) => r.findings.map((f) => f.id)
const finding = (r: DriveReport, id: string) => r.findings.find((f) => f.id === id)

/** A diagnostics text from header lines and "HH:MM:SS what [state]" event lines. */
const text = (head: string[], events: string[]) =>
  ['RouteIQ drive diagnostics', 'log started 09:00:00, now 10:00:00, app active, gps off', ...head, 'events (oldest first):', ...events].join('\n')

/** A plain check every `every` seconds from `fromMin` past nine, `n` of them, numbered from `first`. */
function checks(fromMin: number, n: number, first = 1, every = 60): string[] {
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    const at = 9 * 3600 + fromMin * 60 + i * every
    const t = (s: number) => [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((v) => String(v).padStart(2, '0')).join(':')
    out.push(`${t(at)} request ${first + i} sent [active]`, `${t(at + 1)} request ${first + i} answered, HTTP 200, 600 ms [active]`)
  }
  return out
}

describe('drive report: the format it reads (#202)', () => {
  it("uses the app's own thresholds", () => {
    expect(DEFAULT_REPORT_OPTIONS.pollIntervalSec).toBe(DEFAULT_LIVE_OPTIONS.pollIntervalSec)
    expect(DEFAULT_REPORT_OPTIONS.requestBudget).toBe(DEFAULT_LIVE_OPTIONS.maxRequests)
    expect(DEFAULT_REPORT_OPTIONS.minSavingSec).toBe(DEFAULT_REROUTE_OPTIONS.minSavingSec)
  })

  it('knows every check outcome and probe skip reason the app can write', () => {
    for (const [code, label] of Object.entries(diagnostics.CHECK_OUTCOMES)) expect(CHECK_LABELS[label], label).toBe(code)
    // PROBE_SKIPS arrives with #190; until then there is nothing to keep in step.
    const skips = (diagnostics as unknown as { PROBE_SKIPS?: Record<string, string> }).PROBE_SKIPS ?? {}
    for (const [code, label] of Object.entries(skips)) expect(PROBE_SKIP_LABELS[label], label).toBe(code)
  })

  it('reads every line the app writes today, and its numbers', () => {
    let now = new Date(2026, 10, 12, 7, 50, 0).getTime()
    const log = createDriveDiagnostics(() => now)
    const step = (sec: number) => (now += sec * 1000)
    const request = (kind?: 'probe' | 'path', ms = 500) => {
      const n = log.requestSent(kind)
      step(ms / 1000)
      log.requestEnded(n, 'answered', 200, ms - 20)
    }
    request()
    request('probe')
    step(30)
    log.gps(true)
    for (let i = 0; i < 4; i++) {
      step(60)
      log.fix()
      log.tick()
      request()
      log.checked(i === 2 ? 'saving-too-small' : 'current-best', 2, i === 2 ? 50 : 0)
    }
    log.appState('background')
    step(30)
    log.fix()
    log.appState('active')
    log.speechStarted()
    log.speechEnded(false)
    const failed = log.requestSent()
    step(30)
    log.requestEnded(failed, 'timeout')
    step(10)
    log.gps(false)
    const r = analyse(log.text())
    expect(r.log).toMatchObject({ recognised: true, unknownLines: 0, privateLines: 0 })
    expect(r.drive).toMatchObject({ start: '07:50:31', end: '07:55:43', lengthSec: 312, notActiveSec: 30 })
    expect(r.requests).toMatchObject({ sent: 7, answered: 6, failed: 1, plainChecksInDrive: 5, blindStretchSec: 0 })
    expect(r.probes).toMatchObject({ total: 1, duringDrive: 0, atPlanTime: 1 })
    expect(r.checks).toMatchObject({ count: 4, fastest: 3, bestSavingSec: 50, fasterNotOffered: { 'saving-too-small': 1 } })
    expect(r.speech).toEqual({ started: 1, finished: 0, cutOff: 1 })
    expect(ids(r)).toEqual(expect.arrayContaining(['probes-only-at-plan', 'requests-failed', 'not-active', 'speech-cut']))
  })

  it('reads the first shell build, before probes and check outcomes were logged', () => {
    const r = analyse(fixture('old-format.txt'))
    expect(r.log).toMatchObject({ unknownLines: 0, has: { probeCounts: false, checkOutcomes: false, probeSkips: false } })
    expect(r.checks).toBeNull()
    expect(r.probes.total).toBeNull()
    expect(r.routeChanges.switches).toBeNull()
    expect(r.drive).toMatchObject({ start: '17:30:00', end: '17:50:00', lengthSec: 1200, notActiveSec: 260 })
    expect(reportText(r)).toContain('this log version does not say what each check found')
  })

  it('splits a tally whose labels hold commas', () => {
    expect(parseTally('another was faster, by less than the minimum saving 3, yours was the fastest 9', CHECK_LABELS)).toEqual({
      'saving-too-small': 3,
      'current-best': 9,
    })
    expect(parseTally('no time for your route 1, a faster one, held back by the cooldown after a switch 2', CHECK_LABELS)).toEqual({ 'no-eta': 1, cooldown: 2 })
    expect(parseTally('something new 3', CHECK_LABELS)).toBeNull()
  })

  it('a log whose start was dropped takes the app state from its first event', () => {
    const events = ['09:00:00 no fix for 12 s [background]', '09:04:00 app active [active]', ...checks(5, 2), '09:06:30 gps off [active]']
    const r = analyse(text([], events).replace('events (oldest first):', 'events (oldest first, 150 earlier ones dropped):'))
    expect(r.drive).toMatchObject({ startInLog: false, notActiveSec: 240 })
  })

  it('a drive past midnight keeps its length', () => {
    const r = analyse(
      [
        'RouteIQ drive diagnostics',
        'log started 23:40:00, now 00:30:00, app active, gps off',
        'events (oldest first):',
        '23:50:00 gps on [active]',
        '00:20:00 gps off [active]',
      ].join('\n'),
    )
    expect(r.drive).toMatchObject({ start: '23:50:00', end: '00:20:00', lengthSec: 1800 })
  })
})

describe('drive report: the request budget and the blind stretch (#202)', () => {
  it('says when the minute-by-minute checks stopped and how long the drive went on without them', () => {
    const r = analyse(fixture('checks-stop.txt'))
    expect(r.requests).toMatchObject({ plainChecksInDrive: 15, checksStoppedAt: '07:55:00', blindStretchSec: 1200 })
    const f = finding(r, 'checks-stopped')
    expect(f?.says).toContain('stopped at 07:55:00')
    expect(f?.says).toContain('20 min without one')
    expect(f?.lines).toEqual(['07:55:00 request 16 sent [active]', '08:15:00 gps off [active]'])
  })

  it('a drive checked to the end has no blind stretch', () => {
    const r = analyse(text([], ['09:00:00 gps on [active]', ...checks(1, 20), '09:21:30 gps off [active]']))
    expect(r.requests.blindStretchSec).toBe(0)
    expect(ids(r)).not.toContain('checks-stopped')
    expect(ids(r)).not.toContain('check-gap')
  })

  it('says the budget was used up when that many requests had gone out', () => {
    const r = analyse(text([], ['09:00:00 gps on [active]', ...checks(1, 60), '10:20:00 gps off [active]']))
    expect(finding(r, 'checks-stopped')?.says).toContain('about the whole budget of 60')
  })

  it('the budget boundary: 58 requests is about the whole budget, 57 is not', () => {
    const at = (n: number) => analyse(text([], ['09:00:00 gps on [active]', ...checks(1, n), '10:30:00 gps off [active]']))
    expect(finding(at(58), 'checks-stopped')?.says).toContain('58 requests had gone out on this drive by then, about the whole budget of 60')
    expect(finding(at(57), 'checks-stopped')?.says).toContain('57 requests had gone out on this drive by then (the budget is 60)')
  })

  it('a long drive whose start the log dropped: the budget is read from the request numbers, and partial counts say so', () => {
    // The app keeps 200 events: 2 planning requests, 58 one-minute checks, then 25 minutes with none.
    let now = new Date(2026, 10, 12, 7, 0, 0).getTime()
    const log = createDriveDiagnostics(() => now)
    const step = (sec: number) => (now += sec * 1000)
    const request = (kind?: 'probe') => {
      const n = log.requestSent(kind)
      step(1)
      log.requestEnded(n, 'answered', 200, 500)
    }
    request()
    request()
    log.gps(true)
    for (let i = 0; i < 58; i++) {
      // A fix a minute (a weak signal): each gap is an event too, as on a long drive with tunnels.
      log.fix()
      step(59)
      request()
      log.checked(i % 2 === 0 ? 'current-best' : 'saving-too-small', 2, i % 2 === 0 ? 0 : 30)
    }
    step(25 * 60)
    log.gps(false)
    const r = analyse(log.text())
    expect(r.log.eventsDropped).toBeGreaterThan(0)
    expect(r.drive?.startInLog).toBe(false)
    const says = finding(r, 'checks-stopped')?.says ?? ''
    expect(says).toContain('request 60 was the last to go out, which may be the whole budget of 60')
    expect(says).toContain("The log dropped the drive's start")
    expect(r.requests.plainChecksPartial).toBe(true)
    expect(reportText(r)).toMatch(/checks during the drive: ≥ \d+ \(partial\)/)
  })

  it('a stretch with no check in the middle of a drive is a gap, and says the app was away', () => {
    const events = ['09:00:00 gps on [active]', ...checks(1, 5), '09:05:30 app background [background]', '09:09:00 app active [active]', ...checks(10, 5, 6), '09:14:30 gps off [active]']
    const r = analyse(text([], events))
    const f = finding(r, 'check-gap')
    expect(f?.says).toContain('from 09:05:00 to 09:10:00')
    expect(f?.says).toContain('not active for 3 min 30 s')
    expect(f?.lines).toContain('09:05:30 app background [background]')
  })

  it('a gap shorter than three minutes is not flagged', () => {
    const events = ['09:00:00 gps on [active]', ...checks(1, 5), ...checks(7, 5, 6), '09:11:30 gps off [active]']
    expect(ids(analyse(text([], events)))).not.toContain('check-gap')
  })

  it('a GPS spell with no check at all says so', () => {
    const r = analyse(text([], ['09:00:00 gps on [active]', '09:10:00 gps off [active]']))
    expect(finding(r, 'no-checks')?.says).toContain('no check for faster routes went out')
  })

  it('counts a plain request soon after another as off the cycle (a re-plan)', () => {
    const events = ['09:00:00 gps on [active]', ...checks(1, 3), '09:03:20 check: off the route (1 routes) [active]', '09:03:20 request 4 sent [active]', '09:03:21 request 4 answered, HTTP 200, 600 ms [active]', '09:03:30 gps off [active]']
    const r = analyse(text([], events))
    expect(r.routeChanges).toMatchObject({ offCycleRequests: 1, offCycleTimes: ['09:03:20'] })
  })
})

describe('drive report: probes, checks and faults (#202)', () => {
  it('says when the side-street probes went out only while planning, with why the checks sent none', () => {
    const r = analyse(fixture('probes-at-plan.txt'))
    expect(r.probes).toMatchObject({ total: 2, duringDrive: 0, atPlanTime: 2, skipped: { count: 11, tally: { 'not-held-up': 9, budget: 2 } } })
    expect(r.pathChecks).toMatchObject({ total: 1, atPlanTime: 1 })
    const f = finding(r, 'probes-only-at-plan')
    expect(f?.says).toContain('not-held-up 9')
    expect(f?.lines).toEqual(['07:59:21 request 2 (probe) sent [active]', '07:59:22 request 3 (probe) sent [active]'])
  })

  it('a gap in the fixes before the GPS was switched on for the drive is not a position gap of the drive', () => {
    const r = analyse(text([], ['08:59:00 no fix for 40 s [active]', '09:00:00 gps on [active]', ...checks(1, 2), '09:02:30 gps off [active]']))
    expect(ids(r)).not.toContain('position-gaps')
  })

  it('a probe during the drive is not "only at plan time"', () => {
    const events = ['09:00:00 request 1 (probe) sent [active]', '09:00:30 gps on [active]', ...checks(1, 3, 2), '09:02:02 request 5 (probe) sent [active]', '09:03:30 gps off [active]']
    const r = analyse(text([], events))
    expect(r.probes).toMatchObject({ duringDrive: 1, atPlanTime: 1 })
    expect(ids(r)).not.toContain('probes-only-at-plan')
  })

  it('a faster route by the minimum saving that was never taken is a thing to look at, with why', () => {
    const head = ['checks: 3: yours was the fastest 1, a faster one, but its turn was too close 2', 'best saving another route offered: 150 s']
    const events = ['09:00:00 gps on [active]', ...checks(1, 3), '09:02:01 check: a faster one, but its turn was too close (3 routes, the best other saves 150 s) [active]', '09:03:30 gps off [active]']
    const r = analyse(text(head, events))
    const f = finding(r, 'faster-not-taken')
    expect(f?.says).toContain('2 min 30 s faster')
    expect(f?.says).toContain('its turn was too close 2')
    expect(f?.lines).toEqual(['09:02:01 check: a faster one, but its turn was too close (3 routes, the best other saves 150 s) [active]'])
  })

  it('a faster route below the minimum saving, or one switched to, is not', () => {
    const below = ['checks: 2: another was faster, by less than the minimum saving 2', 'best saving another route offered: 119 s']
    const switched = ['checks: 2: a faster one, waiting for the next check to confirm it 1, switched to a faster one 1', 'best saving another route offered: 300 s']
    for (const head of [below, switched]) expect(ids(analyse(text(head, ['09:00:00 gps on [active]', ...checks(1, 2), '09:02:30 gps off [active]'])))).not.toContain('faster-not-taken')
  })

  it('lists failed, error, slow and waiting requests, fix gaps, cut-off speech and dropped events', () => {
    const r = analyse(fixture('old-format.txt'))
    expect(finding(r, 'requests-failed')?.lines).toEqual(['17:43:30 request 10 timeout after 30000 ms [active]'])
    expect(finding(r, 'slow-answers')?.lines).toEqual(['17:42:09 request 9 answered, HTTP 200, 9400 ms, native 9310 ms [active]'])
    expect(finding(r, 'position-gaps')?.lines).toEqual(['17:38:15 no fix for 45 s [background]'])
    expect(finding(r, 'speech-cut')?.lines).toEqual(['17:44:40 speech line cut off or failed [active]'])
    expect(finding(r, 'not-active')?.says).toContain('4 min 20 s')
    // A cancelled request is the app's own choice, not a fault.
    expect(finding(r, 'requests-failed')?.says).toContain('1 request got no answer (timeout)')

    const other = analyse(
      text(
        ['requests: 3 sent (0 while not active), 2 answered, 0 failed, 0 cancelled, 1 waiting'],
        ['09:00:00 gps on [active]', '09:01:00 request 1 sent [active]', '09:01:01 request 1 answered, HTTP 429, 300 ms [active]', '09:01:30 gps off [active]'],
      ).replace('events (oldest first):', 'events (oldest first, 12 earlier ones dropped):'),
    )
    expect(finding(other, 'http-errors')?.says).toContain('(429)')
    expect(ids(other)).toEqual(expect.arrayContaining(['requests-waiting', 'events-dropped']))
  })
})

describe('drive report: the life of each offer (#202 part 2)', () => {
  it('pairs each offer with its one ending, and flags a switch whose directions stayed the same', () => {
    const r = analyse(fixture('offers.txt'))
    expect(r.log.unknownLines).toBe(0)
    expect(r.routeChanges).toMatchObject({ switches: 2, offersShown: 4 })
    expect(r.offers?.ended).toEqual({ taken: 1, kept: 1, confirmed: 1, withdrawn: 1, expired: 0 })
    expect(r.offers?.list.map((f) => [f.at, f.savingSec, f.how, f.directions])).toEqual([
      ['17:01:01', 240, 'taken', 'directions unchanged'],
      ['17:10:01', 150, 'kept', null],
      ['17:20:01', null, 'withdrawn', null],
      ['17:30:01', 200, 'confirmed', 'directions changed'],
    ])
    expect(r.offers?.list[2].because).toBe('could not be confirmed')
    // An offer waiting to be confirmed, or held by the cooldown, was on screen: it is not "faster but not offered".
    expect(r.checks?.fasterNotOffered).toEqual({})
    expect(finding(r, 'directions-unchanged')?.lines).toEqual(['17:01:40 offer taken by the driver after 39 s, directions unchanged [active]'])
  })

  it('an offer still showing when the log was copied has no ending, and a switch that changed the directions is not flagged', () => {
    const events = [
      '09:00:00 gps on [active]',
      ...checks(1, 3),
      '09:01:01 offer shown: a faster one, waiting for the next check to confirm it (saves 130 s) [active]',
      '09:02:30 offer shown: a faster one, waiting for the next check to confirm it (saves 140 s) [active]',
      '09:03:01 offer confirmed by the app after 31 s, directions changed [active]',
      '09:03:10 offer shown: a faster one, held back by the cooldown after a switch (saves 150 s) [active]',
      '09:03:30 gps off [active]',
    ]
    const r = analyse(text([], events))
    expect(r.offers?.list.map((f) => [f.at, f.how])).toEqual([
      ['09:01:01', null],
      ['09:02:30', 'confirmed'],
      ['09:03:10', null],
    ])
    expect(ids(r)).not.toContain('directions-unchanged')
  })

  it('an ending written in the same second as the next offer belongs to the offer before it', () => {
    const events = [
      '09:00:00 gps on [active]',
      ...checks(1, 3),
      '09:01:01 offer shown: a faster one, waiting for the next check to confirm it (saves 130 s) [active]',
      '09:02:01 offer withdrawn after 60 s: a different one took its place [active]',
      '09:02:01 offer shown: a faster one, waiting for the next check to confirm it (saves 140 s) [active]',
      '09:03:30 gps off [active]',
    ]
    expect(analyse(text([], events)).offers?.list.map((f) => [f.at, f.how])).toEqual([
      ['09:01:01', 'withdrawn'],
      ['09:02:01', null],
    ])
  })

  it('without offer lines the report says the log version does not record them', () => {
    const r = analyse(fixture('checks-stop.txt'))
    expect(r.offers).toBeNull()
    expect(reportText(r)).toContain('offers unknown (not in this log version)')
  })
})

describe('drive report: privacy (#202)', () => {
  it('never passes on a line that looks like a position, a token or a link, and says it saw one', () => {
    const r = analyse(text([], ['09:00:00 gps on [active]', '09:00:10 fix at 35.2271, -80.8431 [active]', '09:00:20 sent to https://example.test/x [active]', '09:01:00 gps off [active]']))
    expect(r.log.privateLines).toBe(2)
    expect(finding(r, 'looks-private')?.says).toContain('2 lines look as if they hold a position')
    const out = reportText(r) + JSON.stringify(r)
    expect(out).not.toMatch(/\d[.,]\d|https?:/)
  })

  it('never shows a line it does not know (a place name in a future log)', () => {
    const events = ['08:59:00 request 1 (to Freedom Park) sent [active]', '09:00:00 gps on [active]', '09:00:10 turned onto Elm Street [active]', 'Destination: Freedom Park', '09:01:00 gps off [active]']
    const r = analyse(text([], events))
    expect(r.log.unknownLines).toBe(3)
    const out = reportText(r) + JSON.stringify(r)
    expect(out).not.toMatch(/Elm|Freedom/)
  })
})
