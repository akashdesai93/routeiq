/**
 * Drive diagnostics for the iPhone shell: what iOS let the app do during a
 * drive, to be read (and copied or shared) afterwards. This log is in memory;
 * its text is also kept on the phone as the "last drive" (lastDrive.ts).
 *
 * Privacy, by construction: this holds counts, times of day, whole
 * milliseconds, HTTP status codes and words from fixed lists. No method takes
 * a position, a URL, a token or any free text, and every number is rounded to
 * a whole one before it is kept, so a coordinate cannot be stored even by
 * mistake (tests/shellHttp.test.ts checks the output by pattern).
 */


/** How many events are kept; older ones are dropped and counted. */
export const DIAGNOSTICS_EVENT_LIMIT = 200
/** A wait this long between two ticks while the GPS is on is logged as an event, in milliseconds. */
export const TICK_GAP_EVENT_MS = 5_000
/** The same for position fixes (a tunnel does this too). */
export const FIX_GAP_EVENT_MS = 10_000

export type DiagnosticsAppState = 'active' | 'inactive' | 'background' | 'unknown'
/** 'answered': Mapbox answered, with any HTTP status. The others: no answer. */
export type RequestOutcome = 'answered' | 'network' | 'timeout' | 'cancelled' | 'not-allowed'

const APP_STATES: readonly DiagnosticsAppState[] = ['active', 'inactive', 'background']
const OUTCOMES: readonly RequestOutcome[] = ['answered', 'network', 'timeout', 'cancelled', 'not-allowed']
/** The test drive's presets (src/drive/testDrive.ts), as the log may name them. */
const SIMULATED_KINDS: readonly string[] = ['follow', 'wrong-turn', 'turn-around']

/**
 * What a drive check concluded (RerouteCode in src/core/reroute.ts, plus the live drive's
 * 'kept-previous'), in the words the log uses. A code not listed is kept as 'other'.
 */
export const CHECK_OUTCOMES: Readonly<Record<string, string>> = Object.freeze({
  'current-best': 'yours was the fastest',
  'no-alternative': 'no other route came back',
  'saving-too-small': 'another was faster, by less than the minimum saving',
  'saving-share-too-small': 'another was faster, by too small a share of the trip',
  confirming: 'a faster one, waiting for the next check to confirm it',
  cooldown: 'a faster one, held back by the cooldown after a switch',
  'faster-route': 'switched to a faster one',
  'too-late': 'a faster one, but its turn was too close',
  'recently-abandoned': 'a faster one you had just left',
  'driver-declined': 'a faster one you had declined',
  'probe-unconfirmed': 'a side street might be faster, not confirmed',
  'route-unconfirmed': 'your route was not among the answers',
  'route-lost': 'your route was no longer offered',
  'off-route': 'off the route',
  'no-eta': 'no time for your route',
  'no-traffic-data': 'no traffic data',
  'no-routes': 'no routes',
  'poll-failed': 'the check failed',
  'kept-previous': 'kept the previous answer',
})

/** A route count above this is logged as this: the log needs "a few", not an exact number. */
export const CHECK_ROUTES_CAP = 9

export interface DriveDiagnostics {
  /** When this log began, milliseconds since 1970. */
  readonly startedAtMs: number
  /** A test drive began: the positions that follow are made up. `kind`: the preset, from a fixed list. `speed`: 1 for 1x. */
  simulated(kind: string, speed: number): void
  /** The location stream was switched on or off. Gaps are measured only while it is on. */
  gps(on: boolean): void
  /** A position arrived. Nothing about the position is passed in. */
  fix(): void
  /** The live session was asked "is anything due?". */
  tick(): void
  /**
   * A route request went out. Returns its number, for requestEnded. `kind`: a
   * side-street probe or a path check is marked as such in the log (a probe
   * that finds no road is a normal answer, not a fault). A word from a fixed
   * list; anything else is not kept.
   */
  requestSent(kind?: 'routes' | 'path' | 'probe'): number
  /** A route request ended. `status`: the HTTP status. `nativeMs`: how long the native side says it took. */
  requestEnded(n: number, outcome: RequestOutcome, status?: number, nativeMs?: number): void
  /**
   * A drive check was decided (LiveState.lastDecision). `code`: its outcome, a word from
   * CHECK_OUTCOMES. `routes`: how many routes its answer had, null when none came back.
   * `savingSec`: what the alternative the engine considered saves against the route driven,
   * like for like; 0 when none was faster, null when the engine could not compare. The log
   * tallies the outcomes, keeps the largest saving seen and notes when the outcome changes.
   */
  checked(code: unknown, routes: number | null, savingSec: number | null): void
  speechStarted(): void
  /** `finished` false: the line was cut off or failed. */
  speechEnded(finished: boolean): void
  /** From the native side: 'active', 'inactive' or 'background'. Anything else is kept as 'unknown'. */
  appState(state: unknown): void
  /** The whole log as text, for the panel and the Copy button. */
  text(): string
}

interface Entry {
  readonly atMs: number
  readonly what: string
}

/** A whole number that is at least 0; anything else is 0. */
const whole = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0)

const two = (n: number) => String(n).padStart(2, '0')

/** Time of day on the phone's clock, to the second. */
function clock(ms: number): string {
  const d = new Date(ms)
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

const seconds = (ms: number) => `${Math.round(ms / 1000)} s`

export function createDriveDiagnostics(now: () => number = Date.now, limit: number = DIAGNOSTICS_EVENT_LIMIT): DriveDiagnostics {
  const startedAt = now()
  const events: Entry[] = []
  let dropped = 0
  let state: DiagnosticsAppState = 'active'
  let gpsOn = false

  const stream = () => ({ count: 0, away: 0, lastAt: null as number | null, longestGapMs: 0 })
  const fixes = stream()
  const ticks = stream()
  const requests = { sent: 0, answered: 0, failed: 0, cancelled: 0, away: 0, totalMs: 0, longestMs: 0, probes: 0, paths: 0 }
  const sentAt = new Map<number, number>()
  const tagOf = new Map<number, string>()
  const speech = { started: 0, finished: 0, cutOff: 0 }
  let simulatedDrives = 0
  const checks = { count: 0, tally: new Map<string, number>(), last: null as string | null, mostFasterSec: null as number | null }

  const log = (what: string) => {
    events.push({ atMs: now(), what: `${what} [${state}]` })
    if (events.length > limit) {
      events.shift()
      dropped++
    }
  }

  const beat = (s: ReturnType<typeof stream>, name: string, eventGapMs: number) => {
    const at = now()
    s.count++
    if (state !== 'active') s.away++
    if (gpsOn && s.lastAt !== null) {
      const gap = whole(at - s.lastAt)
      if (gap > s.longestGapMs) s.longestGapMs = gap
      if (gap >= eventGapMs) log(`no ${name} for ${seconds(gap)}`)
    }
    s.lastAt = at
  }

  return {
    startedAtMs: startedAt,
    simulated(kind, speed) {
      simulatedDrives++
      log(`SIMULATED GPS test drive: ${SIMULATED_KINDS.includes(kind) ? kind : 'unknown'}, ${Math.min(whole(speed), 99)}x speed`)
    },
    gps(on) {
      if (on === gpsOn) return
      gpsOn = on
      // A gap is time between two beats of one drive, never the time between two drives.
      fixes.lastAt = ticks.lastAt = null
      log(on ? 'gps on' : 'gps off')
    },
    fix: () => beat(fixes, 'fix', FIX_GAP_EVENT_MS),
    tick: () => beat(ticks, 'tick', TICK_GAP_EVENT_MS),
    requestSent(kind) {
      const n = ++requests.sent
      if (state !== 'active') requests.away++
      sentAt.set(n, now())
      const tag = kind === 'probe' ? ' (probe)' : kind === 'path' ? ' (path check)' : ''
      if (kind === 'probe') requests.probes++
      if (kind === 'path') requests.paths++
      if (tag !== '') tagOf.set(n, tag)
      log(`request ${n}${tag} sent`)
      return n
    },
    requestEnded(n, outcome, status, nativeMs) {
      const began = sentAt.get(n)
      if (began === undefined) return
      sentAt.delete(n)
      const tag = tagOf.get(n) ?? ''
      tagOf.delete(n)
      const ms = whole(now() - began)
      const kind: RequestOutcome = OUTCOMES.includes(outcome) ? outcome : 'network'
      if (kind === 'answered') {
        requests.answered++
        requests.totalMs += ms
        if (ms > requests.longestMs) requests.longestMs = ms
        const native = nativeMs === undefined ? '' : `, native ${whole(nativeMs)} ms`
        log(`request ${whole(n)}${tag} answered, HTTP ${Math.min(whole(status), 999)}, ${ms} ms${native}`)
      } else {
        if (kind === 'cancelled') requests.cancelled++
        else requests.failed++
        log(`request ${whole(n)}${tag} ${kind} after ${ms} ms`)
      }
    },
    checked(code, routes, saving) {
      const known = typeof code === 'string' && Object.hasOwn(CHECK_OUTCOMES, code) ? code : 'other'
      checks.count++
      checks.tally.set(known, (checks.tally.get(known) ?? 0) + 1)
      // Unknown stays unknown; a slower alternative saves nothing (0), it is not a negative number in the log.
      const by = typeof saving === 'number' && Number.isFinite(saving) ? whole(saving) : null
      if (by !== null && (checks.mostFasterSec === null || by > checks.mostFasterSec)) checks.mostFasterSec = by
      // Once a minute for a whole drive would push everything else out of the events: only a change is noted.
      if (known !== checks.last) {
        checks.last = known
        const answer = routes === null ? 'no answer' : `${Math.min(whole(routes), CHECK_ROUTES_CAP)} routes`
        log(`check: ${CHECK_OUTCOMES[known] ?? 'other'} (${answer}${by !== null && by > 0 ? `, the best other saves ${by} s` : ''})`)
      }
    },
    speechStarted() {
      speech.started++
    },
    speechEnded(finished) {
      if (finished) speech.finished++
      else {
        speech.cutOff++
        log('speech line cut off or failed')
      }
    },
    appState(next) {
      const known = APP_STATES.find((s) => s === next) ?? 'unknown'
      if (known === state) return
      state = known
      log(`app ${known}`)
    },
    text() {
      const average = requests.answered === 0 ? 0 : Math.round(requests.totalMs / requests.answered)
      const lines = [
        'RouteIQ drive diagnostics',
        `log started ${clock(startedAt)}, now ${clock(now())}, app ${state}, gps ${gpsOn ? 'on' : 'off'}`,
        `fixes: ${fixes.count} (${fixes.away} while not active), longest gap ${seconds(fixes.longestGapMs)}`,
        `ticks: ${ticks.count} (${ticks.away} while not active), longest gap ${seconds(ticks.longestGapMs)}`,
        `requests: ${requests.sent} sent (${requests.away} while not active), ${requests.answered} answered, ${requests.failed} failed, ${requests.cancelled} cancelled, ${sentAt.size} waiting`,
        `request time: average ${average} ms, longest ${requests.longestMs} ms`,
        `of those: ${requests.probes} side-street probes (no road or no route is a normal answer for one), ${requests.paths} path checks`,
        ...(checks.count === 0
          ? []
          : [
              `checks: ${checks.count}: ${[...checks.tally.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([code, n]) => `${CHECK_OUTCOMES[code] ?? 'other'} ${n}`)
                .join(', ')}`,
              `best saving another route offered: ${checks.mostFasterSec === null ? 'unknown' : `${checks.mostFasterSec} s`}`,
            ]),
        `speech: ${speech.started} lines started, ${speech.finished} finished, ${speech.cutOff} cut off or failed`,
        ...(simulatedDrives > 0
          ? [`SIMULATED GPS: ${simulatedDrives} test ${simulatedDrives === 1 ? 'drive' : 'drives'} (positions made up, requests and speech real)`]
          : []),
        `events (oldest first${dropped > 0 ? `, ${dropped} earlier ones dropped` : ''}):`,
        ...events.map((e) => `${clock(e.atMs)} ${e.what}`),
      ]
      return lines.join('\n')
    },
  }
}

/** The one log of the running app: the shell's adapters write to it, the panel shows it. */
export const shellDiagnostics: DriveDiagnostics = createDriveDiagnostics()
