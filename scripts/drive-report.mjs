#!/usr/bin/env node
// Reads the iPhone app's "RouteIQ drive diagnostics" text (src/device/native/diagnostics.ts)
// and says what happened on the drive: a short plain-language report and a JSON object (#202).
//
//   node scripts/drive-report.mjs drive.txt          the report
//   node scripts/drive-report.mjs --json < drive.txt the JSON object
//
// Every version of the text since the first shell build is read: the request lines of #80,
// the probe and path-check counts of #82, the per-check outcomes of #176 and the probe skip
// reasons of #190. A line this tool does not know is counted, never shown.
//
// Privacy: the diagnostics hold counts, times of day and words from fixed lists, nothing
// about where the car was. This tool shows only lines it recognised, and every pattern it
// recognises is made of whole numbers and those fixed words, so it cannot pass on a
// coordinate or a place name. A line that looks as if it held one (a decimal number, a token,
// a link) is left out and the report says so: a future log version would then need a look.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Every threshold of the report, in one place. The first three are the app's own
 * (tests/driveReport.test.ts checks they still match); the rest decide what the report flags.
 */
export const DEFAULT_REPORT_OPTIONS = Object.freeze({
  /** DEFAULT_LIVE_OPTIONS.pollIntervalSec: a check for faster routes is due this often, in seconds. */
  pollIntervalSec: 60,
  /** DEFAULT_LIVE_OPTIONS.maxRequests: the most route requests one drive may make. */
  requestBudget: 60,
  /** DEFAULT_REROUTE_OPTIONS.minSavingSec: the smallest saving the app switches for, in seconds. */
  minSavingSec: 120,
  /** The checks stop with this many requests of the budget unused or fewer: "about the whole budget". */
  budgetSlack: 2,
  /** No plain check for this long while the GPS is on is a blind stretch, in seconds (two checks missed in a row). */
  blindAfterSec: 180,
  /** A plain request this soon after the one before it is off the minute-by-minute cycle (a re-plan), in seconds. */
  offCycleBelowSec: 45,
  /** An answer slower than this is worth a look, in milliseconds. */
  slowRequestMs: 8000,
  /** A gap in the fixes or the ticks this long is worth a look, in seconds. */
  longGapSec: 30,
})

/** CHECK_OUTCOMES of diagnostics.ts, label to code (the test keeps them in step). */
export const CHECK_LABELS = Object.freeze({
  'yours was the fastest': 'current-best',
  'no other route came back': 'no-alternative',
  'another was faster, by less than the minimum saving': 'saving-too-small',
  'another was faster, by too small a share of the trip': 'saving-share-too-small',
  'a faster one, waiting for the next check to confirm it': 'confirming',
  'a faster one, held back by the cooldown after a switch': 'cooldown',
  'switched to a faster one': 'faster-route',
  'a faster one, but its turn was too close': 'too-late',
  'a faster one you had just left': 'recently-abandoned',
  'a faster one you had declined': 'driver-declined',
  'a side street might be faster, not confirmed': 'probe-unconfirmed',
  'your route was not among the answers': 'route-unconfirmed',
  'your route was no longer offered': 'route-lost',
  'off the route': 'off-route',
  'no time for your route': 'no-eta',
  'no traffic data': 'no-traffic-data',
  'no routes': 'no-routes',
  'the check failed': 'poll-failed',
  'kept the previous answer': 'kept-previous',
  'took the faster route on offer': 'taken-offer',
  other: 'other',
})

/** PROBE_SKIPS of diagnostics.ts (#190), label to code. */
export const PROBE_SKIP_LABELS = Object.freeze({
  'no request to spare (kept for the checks until arrival, or the cap reached)': 'budget',
  'your route was not among the answers': 'route-not-found',
  'your route was not held up': 'not-held-up',
  'no side street to try (freeway only, or near the end)': 'nothing-to-probe',
  'backing off: the last probes all lost and the traffic has not changed': 'backing-off',
  other: 'other',
})

/**
 * Check outcomes where a faster route was there and was not offered, with why in a few words.
 * ('confirming' and 'cooldown' are not here: the driver sees those as an offer.)
 */
export const FASTER_NOT_OFFERED = Object.freeze({
  'saving-too-small': 'saving below the minimum',
  'saving-share-too-small': 'saving too small a share of the trip',
  'too-late': 'its turn was too close',
  'recently-abandoned': 'a route just left',
  'driver-declined': 'declined by the driver',
  'probe-unconfirmed': 'a side street not confirmed',
})

/** How an offer ended, in the log's words (#202 part 2). */
export const OFFER_ENDINGS = Object.freeze({
  'taken by the driver': 'taken',
  'kept by the driver': 'kept',
  'confirmed by the app': 'confirmed',
  withdrawn: 'withdrawn',
  expired: 'expired',
})

/** Why an offer was withdrawn or expired, in the log's words. */
export const OFFER_END_WORDS = Object.freeze(['no longer faster', 'could not be confirmed', 'a different one took its place', 'its turn came too close', 'off the route', 'the drive ended'])

/** What must never be passed on: a number with a decimal point (a coordinate has one), a Mapbox token, a link. */
const LOOKS_PRIVATE = /\d[.,]\d|\b[ps]k\.|https?:|:\/\//i

const TIME = '(\\d{2}):(\\d{2}):(\\d{2})'
const STATES = ['active', 'inactive', 'background', 'unknown']

/** Seconds since midnight of a "HH:MM:SS". */
const secondsOf = (h, m, s) => Number(h) * 3600 + Number(m) * 60 + Number(s)

/** "HH:MM:SS" of seconds since the log's first midnight (a drive past midnight goes over 24 h). */
export function clockOf(sec) {
  const day = ((Math.round(sec) % 86_400) + 86_400) % 86_400
  const two = (n) => String(n).padStart(2, '0')
  return `${two(Math.floor(day / 3600))}:${two(Math.floor((day % 3600) / 60))}:${two(day % 60)}`
}

/** "12 min 5 s", "40 s". */
export function lengthOf(sec) {
  const s = Math.round(sec)
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 === 0 ? `${m} min` : `${m} min ${s % 60} s`
  return `${Math.floor(m / 60)} h ${m % 60} min`
}

/**
 * "label 3, label 2" against a fixed list of labels (which may hold commas themselves):
 * code to count. Null when the text does not read as such a list.
 */
export function parseTally(body, labels) {
  const tally = {}
  let rest = body
  while (rest.length > 0) {
    const label = Object.keys(labels).find((l) => rest.startsWith(`${l} `) && /^ \d+(, |$)/.test(rest.slice(l.length)))
    if (label === undefined) return null
    const m = rest.slice(label.length).match(/^ (\d+)(, |$)/)
    tally[labels[label]] = (tally[labels[label]] ?? 0) + Number(m[1])
    rest = rest.slice(label.length + m[0].length)
  }
  return tally
}

const HEADER = [
  ['started', new RegExp(`^log started ${TIME}, now ${TIME}, app (\\w+), gps (on|off)$`)],
  ['fixes', /^fixes: (\d+) \((\d+) while not active\), longest gap (\d+) s$/],
  ['ticks', /^ticks: (\d+) \((\d+) while not active\), longest gap (\d+) s$/],
  ['requests', /^requests: (\d+) sent \((\d+) while not active\), (\d+) answered, (\d+) failed, (\d+) cancelled, (\d+) waiting$/],
  ['requestTime', /^request time: average (\d+) ms, longest (\d+) ms$/],
  ['ofThose', /^of those: (\d+) side-street probes \(no road or no route is a normal answer for one\), (\d+) path checks$/],
  ['checks', /^checks: (\d+): (.+)$/],
  ['bestSaving', /^best saving another route offered: (?:(\d+) s|(unknown))$/],
  ['skips', /^probes skipped: (\d+): (.+)$/],
  ['offers', /^offers: (\d+) shown: taken (\d+), kept (\d+), confirmed (\d+), withdrawn (\d+), expired (\d+), directions unchanged (\d+)$/],
  ['speech', /^speech: (\d+) lines started, (\d+) finished, (\d+) cut off or failed$/],
  ['simulated', /^SIMULATED GPS: (\d+) test drives? \(positions made up, requests and speech real\)$/],
  ['events', /^events \(oldest first(?:, (\d+) earlier ones dropped)?\):$/],
]

const EVENT = new RegExp(`^${TIME} (.+) \\[(active|inactive|background|unknown)\\]$`)
const EVENTS = [
  ['gps', /^gps (on|off)$/],
  ['gap', /^no (fix|tick) for (\d+) s$/],
  ['sent', /^request (\d+)( \(probe\)| \(path check\))? sent$/],
  ['answered', /^request (\d+)( \(probe\)| \(path check\))? answered, HTTP (\d+), (\d+) ms(?:, native (\d+) ms)?$/],
  ['failed', /^request (\d+)( \(probe\)| \(path check\))? (network|timeout|cancelled|not-allowed) after (\d+) ms$/],
  ['check', /^check: (.+) \((?:(\d+) routes|(no answer))(?:, the best other saves (\d+) s)?\)$/],
  ['skip', /^probe skipped: (.+)$/],
  ['speechCut', /^speech line cut off or failed$/],
  ['app', /^app (active|inactive|background|unknown)$/],
  // The life of a switch offer (#202 part 2): shown, then exactly one ending.
  ['offerShown', /^offer shown: (.+) \((?:saves (\d+) s|(saving unknown))\)$/],
  ['offerEnded', /^offer (taken by the driver|kept by the driver|confirmed by the app|withdrawn|expired) after (\d+) s(?:: ([a-z ]+))?(?:, (directions changed|directions unchanged|no directions on the new route))?$/],
  ['simulated', /^SIMULATED GPS test drive: ([\w-]+), (\d+)x speed$/],
]

const kindOf = (tag) => (tag === ' (probe)' ? 'probe' : tag === ' (path check)' ? 'path' : 'plain')

/**
 * The diagnostics text, read line by line. Lines it does not know are counted (`unknown`),
 * lines that look as if they held a position or a token are counted (`private`); neither is kept.
 */
export function parseDiagnostics(text) {
  const out = { title: false, header: {}, events: [], unknown: 0, private: 0, dropped: 0, inEvents: false }
  let day = 0
  let lastSec = null
  // A drive past midnight: a time of day that goes back by more than 12 h is the next day.
  const at = (h, m, s) => {
    let sec = secondsOf(h, m, s) + day
    if (lastSec !== null && sec < lastSec - 43_200) {
      day += 86_400
      sec += 86_400
    }
    lastSec = sec
    return sec
  }
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    if (LOOKS_PRIVATE.test(line)) {
      out.private++
      continue
    }
    if (line === 'RouteIQ drive diagnostics') {
      out.title = true
      continue
    }
    const event = out.inEvents ? line.match(EVENT) : null
    if (event) {
      const [, h, m, s, what, state] = event
      const hit = EVENTS.map(([kind, re]) => [kind, what.match(re)]).find(([, mm]) => mm)
      if (!hit) {
        out.unknown++
        continue
      }
      const [kind, mm] = hit
      const e = { kind, atSec: at(h, m, s), state, line, i: out.events.length }
      if (kind === 'gps') e.on = mm[1] === 'on'
      if (kind === 'gap') Object.assign(e, { of: mm[1], sec: Number(mm[2]) })
      if (kind === 'sent') Object.assign(e, { n: Number(mm[1]), type: kindOf(mm[2]) })
      if (kind === 'answered') Object.assign(e, { n: Number(mm[1]), type: kindOf(mm[2]), status: Number(mm[3]), ms: Number(mm[4]) })
      if (kind === 'failed') Object.assign(e, { n: Number(mm[1]), type: kindOf(mm[2]), outcome: mm[3], ms: Number(mm[4]) })
      if (kind === 'check') {
        if (!Object.hasOwn(CHECK_LABELS, mm[1])) {
          out.unknown++
          continue
        }
        Object.assign(e, { code: CHECK_LABELS[mm[1]], routes: mm[3] ? null : Number(mm[2]), savingSec: mm[4] === undefined ? null : Number(mm[4]) })
      }
      if (kind === 'skip') {
        if (!Object.hasOwn(PROBE_SKIP_LABELS, mm[1])) {
          out.unknown++
          continue
        }
        e.code = PROBE_SKIP_LABELS[mm[1]]
      }
      if (kind === 'app') e.to = mm[1]
      if (kind === 'offerShown') {
        if (!Object.hasOwn(CHECK_LABELS, mm[1])) {
          out.unknown++
          continue
        }
        Object.assign(e, { why: CHECK_LABELS[mm[1]], savingSec: mm[3] ? null : Number(mm[2]) })
      }
      if (kind === 'offerEnded') {
        if (mm[3] !== undefined && !OFFER_END_WORDS.includes(mm[3])) {
          out.unknown++
          continue
        }
        Object.assign(e, { how: OFFER_ENDINGS[mm[1]], afterSec: Number(mm[2]), because: mm[3] ?? null, directions: mm[4] ?? null })
      }
      out.events.push(e)
      continue
    }
    const head = HEADER.map(([key, re]) => [key, line.match(re)]).find(([, mm]) => mm)
    if (!head) {
      out.unknown++
      continue
    }
    const [key, mm] = head
    const n = (i) => Number(mm[i])
    const h = out.header
    if (key === 'started') {
      h.startedSec = at(mm[1], mm[2], mm[3])
      h.nowSec = at(mm[4], mm[5], mm[6])
      // The events come after "now" in the text but happened before it: the clock goes on from the start.
      lastSec = h.startedSec
      day = 0
      h.appNow = STATES.includes(mm[7]) ? mm[7] : 'unknown'
      h.gpsOnNow = mm[8] === 'on'
    }
    if (key === 'fixes') h.fixes = { count: n(1), away: n(2), longestGapSec: n(3) }
    if (key === 'ticks') h.ticks = { count: n(1), away: n(2), longestGapSec: n(3) }
    if (key === 'requests') h.requests = { sent: n(1), away: n(2), answered: n(3), failed: n(4), cancelled: n(5), waiting: n(6) }
    if (key === 'requestTime') h.requestTime = { averageMs: n(1), longestMs: n(2) }
    if (key === 'ofThose') h.ofThose = { probes: n(1), paths: n(2) }
    if (key === 'checks') {
      const tally = parseTally(mm[2], CHECK_LABELS)
      if (tally === null) out.unknown++
      else h.checks = { count: n(1), tally }
    }
    if (key === 'bestSaving') h.bestSavingSec = mm[2] ? null : n(1)
    if (key === 'skips') {
      const tally = parseTally(mm[2], PROBE_SKIP_LABELS)
      if (tally === null) out.unknown++
      else h.skips = { count: n(1), tally }
    }
    if (key === 'offers') h.offers = { shown: n(1), taken: n(2), kept: n(3), confirmed: n(4), withdrawn: n(5), expired: n(6), directionsUnchanged: n(7) }
    if (key === 'speech') h.speech = { started: n(1), finished: n(2), cutOff: n(3) }
    if (key === 'simulated') h.simulatedDrives = n(1)
    if (key === 'events') {
      out.inEvents = true
      out.dropped = mm[1] === undefined ? 0 : n(1)
    }
  }
  delete out.inEvents
  return out
}

/** The spells with the GPS on, from the events: [{ startSec, endSec, startInLog, endInLog }]. */
function gpsWindows(log) {
  const windows = []
  let open = null
  const events = log.events
  for (const e of events) {
    if (e.kind !== 'gps') continue
    if (e.on && open === null) open = { startSec: e.atSec, startInLog: true }
    else if (!e.on) {
      // Off with no "on" before it: the start was among the dropped events (or before the log).
      const start = open ?? { startSec: events[0].atSec, startInLog: false }
      windows.push({ ...start, endSec: e.atSec, endInLog: true })
      open = null
    }
  }
  const lastSec = log.header.nowSec ?? events.at(-1)?.atSec
  if (open !== null) windows.push({ ...open, endSec: Math.max(lastSec ?? open.startSec, open.startSec), endInLog: false })
  else if (windows.length === 0 && log.header.gpsOnNow && events.length > 0) {
    windows.push({ startSec: events[0].atSec, startInLog: false, endSec: lastSec, endInLog: false })
  }
  return windows
}

/** Seconds of [from, to] the app spent other than active, from the app events (it starts active). */
function notActiveSec(log, from, to) {
  // The log begins with the app active; with its start dropped, the first event's tag is the best guess.
  const first = log.events[0]
  let state = log.dropped > 0 && first !== undefined ? first.state : 'active'
  let since = log.events[0]?.atSec ?? from
  let total = 0
  const add = (a, b, s) => {
    if (s === 'active') return
    const lo = Math.max(a, from)
    const hi = Math.min(b, to)
    if (hi > lo) total += hi - lo
  }
  for (const e of log.events) {
    if (e.kind !== 'app') continue
    add(since, e.atSec, state)
    state = e.to
    since = e.atSec
  }
  add(since, to, state)
  return total
}

/** "1 request", "3 requests". */
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

const inside = (w, sec) => sec >= w.startSec && sec <= w.endSec

/** The report as data. `options`: DEFAULT_REPORT_OPTIONS, any of them replaced. */
export function analyse(text, options = {}) {
  const o = { ...DEFAULT_REPORT_OPTIONS, ...options }
  const log = parseDiagnostics(text)
  const h = log.header
  const findings = []
  const find = (id, says, lines) => findings.push({ id, says, lines: lines.slice(0, 6) })

  const windows = gpsWindows(log)
  const drive = windows.reduce((a, w) => (a === null || w.endSec - w.startSec > a.endSec - a.startSec ? w : a), null)
  const inDrive = (sec) => windows.some((w) => inside(w, sec))
  const lengthSec = drive === null ? null : drive.endSec - drive.startSec
  // The header counts cover the whole log: per second of all the spells with the GPS on.
  const gpsSec = windows.reduce((sum, w) => sum + (w.endSec - w.startSec), 0)
  // With a spell's start dropped, the GPS-on time in the log is short of the real one: no rate (unknown, not a guess).
  const partialSpells = windows.some((w) => !w.startInLog)
  const perSec = (count) => (count === undefined || !gpsSec || partialSpells ? null : Math.round((count / gpsSec) * 100) / 100)

  const sent = log.events.filter((e) => e.kind === 'sent')
  const ended = log.events.filter((e) => e.kind === 'answered' || e.kind === 'failed')
  const slowest = ended.filter((e) => e.kind === 'answered').reduce((a, e) => (a === null || e.ms > a.ms ? e : a), null)

  // The minute-by-minute checks, per drive: plain requests while the GPS is on.
  const perWindow = windows.map((w) => {
    const plain = sent.filter((e) => e.type === 'plain' && inside(w, e.atSec))
    const offCycle = plain.filter((e, i) => i > 0 && e.atSec - plain[i - 1].atSec < o.offCycleBelowSec)
    const gaps = []
    let prev = w.startSec
    let prevLine = log.events.find((e) => e.kind === 'gps' && e.atSec === w.startSec)?.line ?? null
    for (const e of plain) {
      gaps.push({ fromSec: prev, toSec: e.atSec, fromLine: prevLine, toLine: e.line, trailing: false })
      prev = e.atSec
      prevLine = e.line
    }
    const endLine = log.events.find((e) => e.kind === 'gps' && !e.on && e.atSec === w.endSec)?.line ?? null
    gaps.push({ fromSec: prev, toSec: w.endSec, fromLine: prevLine, toLine: endLine, trailing: true })
    const last = plain.at(-1) ?? null
    // Counted from the request numbers, which run on without a gap. That equals the "sent" lines kept,
    // since the log drops its oldest events first. With the drive's start dropped the count is only a
    // lower bound, and the report says so (unknown is never a plain number).
    const first = sent.find((e) => inside(w, e.atSec))
    const usedBy = last === null || first === undefined ? 0 : last.n - first.n + 1
    const usedPartial = !w.startInLog
    return { w, plain, offCycle, gaps, last, usedBy, usedPartial }
  })

  for (const { w, plain, gaps, last, usedBy, usedPartial } of perWindow) {
    for (const g of gaps) {
      const len = g.toSec - g.fromSec
      if (len < o.blindAfterSec) continue
      const away = notActiveSec(log, g.fromSec, g.toSec)
      const lines = [g.fromLine, ...log.events.filter((e) => e.kind === 'app' && e.atSec > g.fromSec && e.atSec < g.toSec).map((e) => e.line), g.toLine].filter(Boolean)
      if (g.trailing && last !== null) {
        // The budget counts as spent this close to it: the last check may leave a request or two unused.
        const nearBudget = (n) => n >= o.requestBudget - o.budgetSlack
        const used = usedPartial
          ? `The log dropped the drive's start, so how many requests this drive made is not known: at least ${usedBy}, and request ${last.n} was the last to go out (numbered since the app started, so it may count requests before the drive)${
              nearBudget(last.n) ? `, which may be the whole budget of ${o.requestBudget}` : ` (the budget is ${o.requestBudget})`
            }.`
          : `${count(usedBy, 'request')} had gone out on this drive by then${nearBudget(usedBy) ? `, about the whole budget of ${o.requestBudget}` : ` (the budget is ${o.requestBudget})`}.`
        find(
          'checks-stopped',
          `The minute-by-minute checks stopped at ${clockOf(last.atSec)} and the drive went on ${lengthOf(len)} without one${
            w.endInLog ? '' : ' (and was still going when the log was copied)'
          }. ${used}${away > 0 ? ` The app was not active for ${lengthOf(away)} of it.` : ''}`,
          lines,
        )
      } else if (g.trailing && plain.length === 0) {
        find(
          'no-checks',
          w.startInLog
            ? `The GPS was on for ${lengthOf(len)} from ${clockOf(w.startSec)} and no check for faster routes went out.`
            : `No check for faster routes in the ${lengthOf(len)} of the drive still in the log, from ${clockOf(w.startSec)} (its start was dropped, so earlier checks are not known).`,
          lines,
        )
      } else {
        find(
          'check-gap',
          `No check for faster routes from ${clockOf(g.fromSec)} to ${clockOf(g.toSec)} (${lengthOf(len)}) while the GPS was on${
            away > 0 ? `; the app was not active for ${lengthOf(away)} of it` : ''
          }. Standing still also pauses the checks, which the log cannot show.`,
          lines,
        )
      }
    }
  }

  const blind = perWindow.find((p) => p.w === drive)
  const trailing = blind?.gaps.at(-1)
  const blindStretchSec = trailing && trailing.toSec - trailing.fromSec >= o.blindAfterSec ? trailing.toSec - trailing.fromSec : 0

  // Probes and path checks: while the GPS was on (the drive) or not (planning).
  const byType = (type) => {
    const all = sent.filter((e) => e.type === type)
    const during = all.filter((e) => inDrive(e.atSec))
    return { inEvents: all.length, duringDrive: during.length, atPlanTime: all.length - during.length, times: all.map((e) => clockOf(e.atSec)) }
  }
  const probes = { total: h.ofThose?.probes ?? null, ...byType('probe') }
  const paths = { total: h.ofThose?.paths ?? null, ...byType('path') }
  if (probes.atPlanTime > 0 && probes.duringDrive === 0 && windows.length > 0) {
    find(
      'probes-only-at-plan',
      `Side-street probes went out only while planning (${probes.atPlanTime}), none during the drive.${
        h.skips
          ? ` Why the checks sent none: ${Object.entries(h.skips.tally).map(([c, n]) => `${c} ${n}`).join(', ')}.`
          : ' This log version does not say why a check sent none.'
      }`,
      sent.filter((e) => e.type === 'probe').map((e) => e.line),
    )
  }

  const failures = ended.filter((e) => e.kind === 'failed' && e.outcome !== 'cancelled')
  if (failures.length > 0) {
    find('requests-failed', `${count(failures.length, 'request')} got no answer (${[...new Set(failures.map((e) => e.outcome))].join(', ')}).`, failures.map((e) => e.line))
  }
  const errors = ended.filter((e) => e.kind === 'answered' && e.status >= 400)
  if (errors.length > 0) find('http-errors', `${count(errors.length, 'answer was an HTTP error', 'answers were HTTP errors')} (${[...new Set(errors.map((e) => e.status))].join(', ')}).`, errors.map((e) => e.line))
  const slow = ended.filter((e) => e.kind === 'answered' && e.ms >= o.slowRequestMs)
  if (slow.length > 0) find('slow-answers', `${count(slow.length, 'answer', 'answers')} took ${o.slowRequestMs / 1000} s or more (slowest ${slowest.ms} ms).`, slow.map((e) => e.line))
  if ((h.requests?.waiting ?? 0) > 0) find('requests-waiting', `${count(h.requests.waiting, 'request was', 'requests were')} still waiting for an answer when the log was copied.`, [])

  const longGaps = log.events.filter((e) => e.kind === 'gap' && e.sec >= o.longGapSec && inDrive(e.atSec))
  if (longGaps.length > 0) find('position-gaps', `${count(longGaps.length, 'gap')} of ${o.longGapSec} s or more in the fixes or ticks during the drive.`, longGaps.map((e) => e.line))

  const awaySec = drive === null ? null : notActiveSec(log, drive.startSec, drive.endSec)
  if (awaySec !== null && awaySec > 0) {
    find('not-active', `The app was not active for ${drive.startInLog ? '' : 'at least '}${lengthOf(awaySec)} of the drive.`, log.events.filter((e) => e.kind === 'app' && inside(drive, e.atSec)).map((e) => e.line))
  }

  // Route changes: off-cycle plain requests (re-plans), switches, offers.
  const offCycle = perWindow.flatMap((p) => p.offCycle)
  const checkEvents = log.events.filter((e) => e.kind === 'check')
  const switchEvents = checkEvents.filter((e) => e.code === 'faster-route' || e.code === 'taken-offer')
  const tally = h.checks?.tally ?? null
  const switches = tally === null ? (h.checks === undefined && checkEvents.length === 0 ? null : switchEvents.length) : (tally['faster-route'] ?? 0) + (tally['taken-offer'] ?? 0)

  let checks = null
  if (h.checks !== undefined) {
    const notOffered = Object.fromEntries(Object.keys(FASTER_NOT_OFFERED).filter((c) => tally[c] > 0).map((c) => [c, tally[c]]))
    checks = { count: h.checks.count, tally, fastest: tally['current-best'] ?? 0, bestSavingSec: h.bestSavingSec ?? null, fasterNotOffered: notOffered }
    const big = checkEvents.filter((e) => e.savingSec !== null && e.savingSec >= o.minSavingSec && Object.hasOwn(FASTER_NOT_OFFERED, e.code))
    if (switches === 0 && h.bestSavingSec !== null && h.bestSavingSec !== undefined && h.bestSavingSec >= o.minSavingSec) {
      const why = Object.entries(notOffered).map(([c, n]) => `${FASTER_NOT_OFFERED[c]} ${n}`).join(', ')
      find(
        'faster-not-taken',
        `A route ${lengthOf(h.bestSavingSec)} faster was seen and no switch was made${why === '' ? '' : ` (${why})`}.`,
        big.map((e) => e.line),
      )
    }
  }

  // The life of each offer (#202 part 2): shown, then one ending; a switch whose directions stayed the same.
  const shown = log.events.filter((e) => e.kind === 'offerShown')
  const endings = log.events.filter((e) => e.kind === 'offerEnded')
  const offers =
    h.offers !== undefined || shown.length > 0 || endings.length > 0
      ? {
          shown: h.offers?.shown ?? shown.length,
          ended: Object.fromEntries(Object.values(OFFER_ENDINGS).map((how) => [how, h.offers?.[how] ?? endings.filter((e) => e.how === how).length])),
          list: shown.map((e) => {
            const end = endings.find((x) => x.i > e.i && !shown.some((y) => y.i > e.i && y.i < x.i))
            return { at: clockOf(e.atSec), savingSec: e.savingSec, why: e.why, how: end?.how ?? null, afterSec: end?.afterSec ?? null, because: end?.because ?? null, directions: end?.directions ?? null }
          }),
        }
      : null
  const unchanged = endings.filter((e) => e.directions === 'directions unchanged' || e.directions === 'no directions on the new route')
  if (unchanged.length > 0) {
    find('directions-unchanged', `${count(unchanged.length, 'switch', 'switches')} to an offered route left the next turn the same (or had no directions).`, unchanged.map((e) => e.line))
  }

  if (log.dropped > 0) find('events-dropped', `${count(log.dropped, 'earlier event was', 'earlier events were')} dropped from the log, so the start of the drive may be missing from what follows.`, [])
  if (log.private > 0) {
    find('looks-private', `${log.private} ${log.private === 1 ? 'line looks' : 'lines look'} as if ${log.private === 1 ? 'it holds' : 'they hold'} a position, a token or a link. They are left out of this report; the log should never hold any.`, [])
  }
  const cut = log.events.filter((e) => e.kind === 'speechCut')
  if (cut.length > 0) find('speech-cut', `${count(h.speech?.cutOff ?? cut.length, 'spoken line was', 'spoken lines were')} cut off or failed.`, cut.map((e) => e.line))

  return {
    report: 'drive-report 1',
    log: {
      recognised: log.title,
      eventsDropped: log.dropped,
      unknownLines: log.unknown,
      privateLines: log.private,
      has: { probeCounts: h.ofThose !== undefined, checkOutcomes: h.checks !== undefined, probeSkips: h.skips !== undefined, offers: offers !== null },
      simulatedDrives: h.simulatedDrives ?? 0,
    },
    drive:
      drive === null
        ? null
        : {
            start: clockOf(drive.startSec),
            end: clockOf(drive.endSec),
            startInLog: drive.startInLog,
            endInLog: drive.endInLog,
            lengthSec,
            spells: windows.length,
            fixes: h.fixes?.count ?? null,
            ticks: h.ticks?.count ?? null,
            fixesPerSec: perSec(h.fixes?.count),
            ticksPerSec: perSec(h.ticks?.count),
            longestFixGapSec: h.fixes?.longestGapSec ?? null,
            longestTickGapSec: h.ticks?.longestGapSec ?? null,
            notActiveSec: awaySec,
          },
    requests: {
      sent: h.requests?.sent ?? null,
      answered: h.requests?.answered ?? null,
      failed: h.requests?.failed ?? null,
      cancelled: h.requests?.cancelled ?? null,
      waiting: h.requests?.waiting ?? null,
      averageMs: h.requestTime?.averageMs ?? null,
      slowestMs: h.requestTime?.longestMs ?? slowest?.ms ?? null,
      plainChecksInDrive: blind?.plain.length ?? 0,
      // True when the drive's start was dropped from the log: the count above is then at least that many.
      plainChecksPartial: drive !== null && !drive.startInLog,
      checksStoppedAt: blindStretchSec > 0 && blind.last !== null ? clockOf(blind.last.atSec) : null,
      blindStretchSec,
      longestCheckGapSec: blind ? Math.max(...blind.gaps.map((g) => g.toSec - g.fromSec)) : null,
    },
    probes: { ...probes, skipped: h.skips ?? null },
    pathChecks: paths,
    routeChanges: { offCycleRequests: offCycle.length, offCycleTimes: offCycle.map((e) => clockOf(e.atSec)), switches, offersShown: offers?.shown ?? null },
    offers,
    checks,
    speech: h.speech ?? null,
    findings,
  }
}

/** The report as plain language. */
export function reportText(r) {
  const out = []
  const or = (v, f) => (v === null || v === undefined ? 'unknown' : f(v))
  if (!r.log.recognised) out.push('This does not start like a RouteIQ drive diagnostics text; what follows is what could be read.')
  if (r.log.simulatedDrives > 0) out.push(`SIMULATED: ${r.log.simulatedDrives} test drive(s); the positions were made up.`)
  if (r.drive === null) out.push('Drive: the GPS was never on in this log.')
  else {
    const d = r.drive
    out.push(
      `Drive: ${d.startInLog ? '' : 'before '}${d.start} to ${d.end}${d.endInLog ? '' : ' (still on)'}, ${d.startInLog ? '' : 'at least '}${lengthOf(d.lengthSec)}${d.spells > 1 ? ` (the longest of ${d.spells} spells with the GPS on)` : ''}.`,
      `  fixes ${or(d.fixes, String)} (${or(d.fixesPerSec, String)}/s), ticks ${or(d.ticks, String)} (${or(d.ticksPerSec, String)}/s), longest gap ${or(d.longestFixGapSec, (v) => `${v} s`)} / ${or(d.longestTickGapSec, (v) => `${v} s`)}, not active ${d.startInLog ? '' : 'at least '}${or(d.notActiveSec, lengthOf)}.`,
    )
  }
  const q = r.requests
  out.push(
    `Requests: ${or(q.sent, String)} sent, ${or(q.answered, String)} answered, ${or(q.failed, String)} failed, slowest ${or(q.slowestMs, (v) => `${v} ms`)}.`,
    `  checks during the drive: ${q.plainChecksPartial ? `≥ ${q.plainChecksInDrive} (partial)` : q.plainChecksInDrive}${
      q.blindStretchSec > 0 ? `; they stopped at ${q.checksStoppedAt ?? (q.plainChecksPartial ? 'the start of what the log kept' : 'the start')} and the drive went on ${lengthOf(q.blindStretchSec)} without one` : ''
    }.`,
  )
  const p = r.probes
  out.push(
    `Probes: ${or(p.total, String)} (${p.duringDrive} during the drive, ${p.atPlanTime} while planning${p.times.length ? `: ${p.times.join(', ')}` : ''}); path checks ${or(r.pathChecks.total, String)} (${r.pathChecks.duringDrive} during, ${r.pathChecks.atPlanTime} planning).`,
  )
  if (p.skipped) out.push(`  checks with no probe: ${p.skipped.count} (${Object.entries(p.skipped.tally).map(([c, n]) => `${c} ${n}`).join(', ')}).`)
  const rc = r.routeChanges
  out.push(`Route changes: ${count(rc.offCycleRequests, 'off-cycle request')} (re-plans), ${or(rc.switches, String)} switches, offers ${or(rc.offersShown, String)}${r.log.has.offers ? '' : ' (not in this log version)'}.`)
  if (r.offers !== null) {
    for (const f of r.offers.list) {
      const end = f.how === null ? 'not ended in the log' : `${f.how} after ${lengthOf(f.afterSec)}${f.because ? ` (${f.because})` : ''}${f.directions ? `, ${f.directions}` : ''}`
      out.push(`  offer at ${f.at}, saves ${f.savingSec === null ? 'unknown' : lengthOf(f.savingSec)}: ${end}.`)
    }
  }
  if (r.checks === null) out.push('Checks: this log version does not say what each check found.')
  else {
    const c = r.checks
    const not = Object.entries(c.fasterNotOffered).map(([code, n]) => `${FASTER_NOT_OFFERED[code]} ${n}`)
    out.push(`Checks: ${c.count}, yours was the fastest ${c.fastest}, best saving seen ${or(c.bestSavingSec, (v) => `${v} s`)}${not.length ? `; faster but not offered: ${not.join(', ')}` : ''}.`)
  }
  out.push(`Speech: ${r.speech === null ? 'unknown' : `${r.speech.started} started, ${r.speech.finished} finished, ${r.speech.cutOff} cut off`}.`)
  if (r.log.unknownLines > 0) out.push(`(${r.log.unknownLines} lines this tool does not know were skipped and are not shown.)`)
  out.push('', r.findings.length === 0 ? 'Things to look at: none.' : 'Things to look at:')
  for (const f of r.findings) {
    out.push(`- ${f.says}`)
    for (const line of f.lines) out.push(`    ${line}`)
  }
  return out.join('\n')
}

function main() {
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  const file = args.find((a) => !a.startsWith('--'))
  const text = readFileSync(file ?? 0, 'utf8')
  const r = analyse(text)
  process.stdout.write(json ? `${JSON.stringify(r, null, 2)}\n` : `${reportText(r)}\n`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
