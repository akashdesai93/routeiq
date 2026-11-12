/**
 * The phone lab's test hook (docs/phone-lab.md): lets the PC run a drive on
 * the real iPhone with nobody touching it. It exists only inside the iPhone
 * shell and only when the app was started from the PC with the launch
 * argument `-routeiqLab <scenario>` (the Swift plugin reports that; see
 * RouteIQLab.swift). Started any other way, nothing here runs and
 * `window.__routeiqLab` is not there.
 *
 * The hook is a robot user: it presses the app's own buttons and reads the
 * app's own screen. It decides nothing and reaches into no state.
 *
 * What it writes out for the PC to pull (`report()`) holds the drive
 * diagnostics (counts and times only), which screen is up, fixed status
 * words and counts. No position, no address, no token and no road or place
 * name: `read()` returns those for a person at a Web Inspector console, and
 * they are never put in the report.
 */

import { distanceM } from '../core/geo.ts'
import type { DriveDiagnostics } from '../device/native/diagnostics.ts'

/** The two plugin methods the lab uses. Both are missing in a build without the lab. */
export interface LabPlugin {
  lab?: () => Promise<{ enabled?: boolean; scenario?: string }>
  labReport?: (options: { text: string }) => Promise<unknown>
  addListener?: (event: 'tick', listener: () => void) => Promise<unknown>
  getCurrentPosition?: () => Promise<{ lng: number; lat: number }>
}

/** How often the screen is looked at, and how often the report is written out, in milliseconds. */
export const LAB_SAMPLE_MS = 1_000
export const LAB_REPORT_MS = 3_000
/** How long a drive scenario waits for routes and for the simulated position before giving up, in milliseconds. */
export const LAB_ROUTES_WAIT_MS = 90_000
/** A drive is started only when the phone reports a position this close to the simulated start, in meters. */
export const LAB_START_RADIUS_M = 250
/** How often the position is asked for while waiting for the simulated one, in milliseconds. */
export const LAB_POSITION_RETRY_MS = 3_000
/** How many history lines are kept. */
export const LAB_HISTORY_LIMIT = 300
/** Scenario names are short words; anything else is refused. */
const SCENARIO = /^[a-z][a-z0-9-]{0,31}$/
/** `drive-at-<lng>-<lat>`: whole numbers of 1/100000 degree, `m` for minus. Example: drive-at-m8084316-3522716. */
const DRIVE_AT = /^drive-at-(m?)(\d{1,8})-(m?)(\d{1,7})$/

/**
 * Where a `drive-at-…` scenario expects the phone to be: the PC's simulated
 * start. Null for any other scenario. The lab never starts a drive anywhere
 * else, so a lab drive cannot run on the phone's real position.
 */
export function driveStart(scenario: string): { lng: number; lat: number } | null {
  const m = DRIVE_AT.exec(scenario)
  if (m === null) return null
  const lng = (m[1] === 'm' ? -1 : 1) * (Number(m[2]) / 1e5)
  const lat = (m[3] === 'm' ? -1 : 1) * (Number(m[4]) / 1e5)
  return Math.abs(lng) <= 180 && Math.abs(lat) <= 90 ? { lng, lat } : null
}

/** What is on the screen, as a person would read it. Not written to the report. */
export interface LabScreen {
  readonly screen: 'token' | 'plan' | 'drive' | 'summary'
  /** Routes listed on the plan screen. */
  readonly routes: number
  readonly canStartDrive: boolean
  /** The turn card's text, or null when no turn is shown. */
  readonly turn: string | null
  readonly eta: string | null
  readonly status: string | null
  readonly banner: string | null
  readonly warnings: readonly string[]
}

export interface RouteIQLab {
  readonly scenario: string
  /** Presses the first enabled button with exactly this text. False: there is none. */
  press(name: string): boolean
  /** Types a place name into the origin or destination field and takes the first suggestion. */
  setPlace(role: 'origin' | 'destination', name: string): Promise<boolean>
  resetToTestPoints(): boolean
  startDrive(): boolean
  endDrive(): boolean
  /**
   * Switches on the in-app test drive ("Test drive (simulated GPS)" on the plan
   * screen), in builds that have it: Start drive then follows a made-up car
   * and the phone's GPS is not used. False: the control is not there.
   */
  startTestDrive(): boolean
  /** True when the in-app test drive is switched on. */
  testDriveOn(): boolean
  read(): LabScreen
  diagnostics(): string
  report(): string
}

/**
 * The scenario the app was started with, or null: the lab is off. Null in a
 * browser, in a shell build without the lab, when the app was opened by
 * hand, and when anything about the answer is odd.
 */
export async function labScenario(plugin: LabPlugin | null): Promise<string | null> {
  if (plugin === null || typeof plugin.lab !== 'function' || typeof plugin.labReport !== 'function') return null
  try {
    const answer = await plugin.lab()
    if (answer?.enabled !== true || typeof answer.scenario !== 'string') return null
    return SCENARIO.test(answer.scenario) ? answer.scenario : null
  } catch {
    return null
  }
}

interface LabElement {
  readonly textContent: string | null
  readonly disabled?: boolean
  readonly checked?: boolean
  click(): void
}

/** The part of `document` the lab uses. */
export interface LabDocument {
  querySelector(selector: string): unknown
  querySelectorAll(selector: string): ArrayLike<unknown>
}

const text = (el: unknown): string | null => {
  const raw = (el as LabElement | null)?.textContent
  if (raw === null || raw === undefined) return null
  const clean = raw.replace(/\s+/g, ' ').trim()
  return clean === '' ? null : clean
}

const two = (n: number) => String(n).padStart(2, '0')
const clock = (ms: number) => {
  const d = new Date(ms)
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

/**
 * The status line as one word from a fixed list, so that the report cannot
 * carry a road name. The order matters: the first match wins.
 */
export function statusWord(screen: LabScreen): string {
  if (screen.screen !== 'drive') return screen.screen
  const status = screen.status ?? ''
  if (status.startsWith('Finding your position')) return 'locating'
  if (status.startsWith('Finding a route')) return 'planning'
  if (status.startsWith('Off the route')) return 'off-route'
  if (status.startsWith('Arrived')) return 'arrived'
  if (status.startsWith('Waiting for a position fix')) return 'no-fix'
  if (status.startsWith('Standing still')) return 'stationary'
  if (status.startsWith('Request budget used up')) return 'budget-spent'
  return screen.turn !== null || screen.eta !== null ? 'driving' : 'other'
}

export interface LabDeps {
  readonly scenario: string
  readonly doc: LabDocument
  readonly diagnostics: Pick<DriveDiagnostics, 'text'>
  readonly now?: () => number
}

export function createLab({ scenario, doc, diagnostics, now = Date.now }: LabDeps): RouteIQLab & { sample(): void; note(what: string): void } {
  const history: string[] = []
  let dropped = 0
  let lastWord: string | null = null
  let lastBanner: string | null = null
  let reports = 0

  const note = (what: string) => {
    history.push(`${clock(now())} ${what}`)
    if (history.length > LAB_HISTORY_LIMIT) {
      history.shift()
      dropped++
    }
  }

  const buttons = () => Array.from(doc.querySelectorAll('button')) as LabElement[]

  const press = (name: string): boolean => {
    const button = buttons().find((b) => text(b) === name && b.disabled !== true)
    if (button === undefined) return false
    button.click()
    note(`pressed "${name}"`)
    return true
  }

  const testDriveBox = () => doc.querySelector('.testdrive input[type="checkbox"]') as LabElement | null

  const read = (): LabScreen => {
    const turnEl = doc.querySelector('.live-top')
    const live = turnEl !== null || doc.querySelector('.live-bottom') !== null
    const summary = !live && doc.querySelector('.live-summary') !== null
    const routes = doc.querySelectorAll('.routes > li').length
    const start = buttons().find((b) => text(b) === 'Start drive')
    const plan = doc.querySelector('.plan') !== null
    const hasTurn = doc.querySelector('.live-turn-distance') !== null
    return {
      screen: live ? 'drive' : summary ? 'summary' : plan ? 'plan' : 'token',
      routes,
      canStartDrive: start !== undefined && start.disabled !== true,
      turn: hasTurn ? text(turnEl) : null,
      eta: doc.querySelector('.live-eta strong') !== null ? text(doc.querySelector('.live-eta')) : null,
      status: text(doc.querySelector('.live-status')),
      banner: text(doc.querySelector('.live-banner')),
      warnings: (Array.from(doc.querySelectorAll('.live-warning')) as LabElement[]).map((w) => text(w) ?? ''),
    }
  }

  /** Looks at the screen and writes a history line when the status word or the banner changed. */
  const sample = () => {
    const screen = read()
    const word = statusWord(screen)
    if (word !== lastWord) {
      note(`status ${word}`)
      lastWord = word
    }
    // The banner's words name roads and times; only which of the two kinds it is gets written down.
    const banner = screen.banner === null ? null : screen.banner.startsWith('New route from here') ? 'new-route-after-off-route' : 'switched-route'
    if (banner !== lastBanner) {
      note(banner === null ? 'banner gone' : `banner ${banner}`)
      lastBanner = banner
    }
  }

  const setPlace = async (role: 'origin' | 'destination', name: string): Promise<boolean> => {
    const field = (Array.from(doc.querySelectorAll('input[role="combobox"]')) as HTMLInputElement[])[role === 'origin' ? 0 : 1]
    if (field === undefined) return false
    field.focus()
    // React keeps its own copy of the value: go through the element's own setter, then say it changed.
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set
    if (setter === undefined) return false
    setter.call(field, name)
    field.dispatchEvent(new Event('input', { bubbles: true }))
    for (let waited = 0; waited < 8_000; waited += 250) {
      await new Promise((r) => setTimeout(r, 250))
      const option = doc.querySelector('.options [role="option"]') as LabElement | null
      if (option !== null) {
        option.click()
        note(`${role} set by name`)
        return true
      }
    }
    return false
  }

  return {
    scenario,
    press,
    setPlace,
    resetToTestPoints: () => press('Reset to test points'),
    startDrive: () => press('Start drive'),
    endDrive: () => press('End') || press('End drive'),
    startTestDrive: () => {
      const box = testDriveBox()
      if (box === null) return false
      if (box.checked !== true) {
        box.click()
        note('switched on the in-app test drive')
      }
      return true
    },
    testDriveOn: () => testDriveBox()?.checked === true,
    read,
    diagnostics: () => diagnostics.text(),
    sample,
    note,
    report() {
      const screen = read()
      return [
        'RouteIQ lab report',
        `scenario ${scenario}, written ${clock(now())}, number ${++reports}`,
        `screen ${screen.screen}, status ${statusWord(screen)}, routes ${screen.routes}, turn card ${screen.turn !== null ? 'shown' : 'none'}, arrival time ${screen.eta !== null ? 'shown' : 'none'}, warnings ${screen.warnings.length}`,
        `history (oldest first${dropped > 0 ? `, ${dropped} earlier ones dropped` : ''}):`,
        ...history,
        '--- diagnostics ---',
        diagnostics.text(),
      ].join('\n')
    },
  }
}

export interface StartLabOptions {
  readonly plugin: LabPlugin | null
  readonly diagnostics: Pick<DriveDiagnostics, 'text'>
  /** Where the hook is put: `window`. */
  readonly target: { __routeiqLab?: RouteIQLab; document?: LabDocument }
  readonly now?: () => number
  readonly every?: (ms: number, fn: () => void) => unknown
}

/**
 * Call once at startup. Does nothing, and resolves with null, unless the app
 * was started with the lab's launch argument. Otherwise it puts the hook on
 * `window.__routeiqLab`, keeps a history of what the screen showed, writes
 * the report out every few seconds, and runs the scenario:
 *
 * - `plan`: nothing more (the PC looks at the plan screen).
 * - `drive-at-<lng>-<lat>`: presses Start drive once the routes are there
 *   AND the phone reports a position within LAB_START_RADIUS_M of that
 *   point, which is where the PC put the simulated position. On the phone's
 *   real position it never starts.
 * - `testdrive`: switches on the in-app test drive (its default: a wrong turn
 *   after a minute) and presses Start drive only once that switch is on, so
 *   the drive follows the app's made-up car and never the phone's GPS. This
 *   is the one that works with the phone asleep: it needs no connection to
 *   the PC.
 */
export async function startLab({ plugin, diagnostics, target, now = Date.now, every = (ms, fn) => setInterval(fn, ms) }: StartLabOptions): Promise<RouteIQLab | null> {
  const scenario = await labScenario(plugin)
  const doc = target.document
  if (scenario === null || plugin === null || doc === undefined) return null
  const lab = createLab({ scenario, doc, diagnostics, now })
  target.__routeiqLab = lab
  lab.note(`lab started, scenario ${scenario}`)

  const startedAt = now()
  let lastSample = -Infinity
  let lastReport = -Infinity
  const start = driveStart(scenario)
  const testDrive = scenario === 'testdrive'
  let autopilot: 'waiting' | 'asking' | 'done' = start !== null || testDrive ? 'waiting' : 'done'
  let lastAsked = -Infinity
  /** Asks the phone where it is and starts the drive only at the simulated start. Says yes or no, never where. */
  const startAtSimulatedPosition = (at: number) => {
    if (start === null || typeof plugin.getCurrentPosition !== 'function') return
    autopilot = 'asking'
    lastAsked = at
    plugin.getCurrentPosition().then(
      (fix) => {
        const near = typeof fix?.lng === 'number' && typeof fix?.lat === 'number' && distanceM([fix.lng, fix.lat], [start.lng, start.lat]) <= LAB_START_RADIUS_M
        if (!near) {
          lab.note('the phone is not at the simulated start: not starting the drive')
          autopilot = 'waiting'
        } else if (lab.startDrive()) autopilot = 'done'
        else autopilot = 'waiting'
      },
      () => {
        lab.note('no position from the phone: not starting the drive')
        autopilot = 'waiting'
      },
    )
  }
  const beat = () => {
    const at = now()
    if (at - lastSample < LAB_SAMPLE_MS - 50) return
    lastSample = at
    try {
      lab.sample()
      if (autopilot === 'waiting') {
        const screen = lab.read()
        if (at - startedAt > LAB_ROUTES_WAIT_MS) {
          lab.note('gave up: no routes, or the phone never reached the simulated start')
          autopilot = 'done'
        } else if (screen.screen === 'plan' && screen.routes > 0 && screen.canStartDrive) {
          if (testDrive) {
            // Two beats: switch it on, and start only after the page shows it on.
            if (!lab.testDriveOn()) lab.startTestDrive()
            else if (lab.startDrive()) autopilot = 'done'
          } else if (at - lastAsked >= LAB_POSITION_RETRY_MS) startAtSimulatedPosition(at)
        }
      }
      if (at - lastReport >= LAB_REPORT_MS) {
        lastReport = at
        void plugin.labReport?.({ text: lab.report() }).catch(() => {})
      }
    } catch {
      // The lab must never break the app it is watching.
    }
  }
  // A page's timers may be held back while the phone is locked; the plugin's native tick is not.
  every(LAB_SAMPLE_MS, beat)
  try {
    void plugin.addListener?.('tick', beat).catch(() => {})
  } catch {
    // Timers only, then.
  }
  return lab
}
