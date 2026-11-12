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

import type { DriveDiagnostics } from '../device/native/diagnostics.ts'

/** The two plugin methods the lab uses. Both are missing in a build without the lab. */
export interface LabPlugin {
  lab?: () => Promise<{ enabled?: boolean; scenario?: string }>
  labReport?: (options: { text: string }) => Promise<unknown>
  addListener?: (event: 'tick', listener: () => void) => Promise<unknown>
}

/** How often the screen is looked at, and how often the report is written out, in milliseconds. */
export const LAB_SAMPLE_MS = 1_000
export const LAB_REPORT_MS = 3_000
/** How long the `drive` scenario waits for routes before giving up, in milliseconds. */
export const LAB_ROUTES_WAIT_MS = 90_000
/** How many history lines are kept. */
export const LAB_HISTORY_LIMIT = 300
/** Scenario names are short words; anything else is refused. */
const SCENARIO = /^[a-z][a-z0-9-]{0,31}$/

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
  /** The in-app test drive (simulated GPS), in builds that have it. */
  startTestDrive(): boolean
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
  let lastBanner = false
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
    const banner = screen.banner !== null
    if (banner !== lastBanner) {
      note(banner ? 'route-change banner shown' : 'route-change banner gone')
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
    startTestDrive: () => press('Test drive (simulated GPS)'),
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
 * - `drive`: presses Start drive once the routes are there.
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
  let autopilot: 'waiting' | 'done' = scenario === 'drive' ? 'waiting' : 'done'
  const beat = () => {
    const at = now()
    if (at - lastSample < LAB_SAMPLE_MS - 50) return
    lastSample = at
    try {
      lab.sample()
      if (autopilot === 'waiting') {
        const screen = lab.read()
        if (screen.screen === 'plan' && screen.routes > 0 && screen.canStartDrive && lab.startDrive()) autopilot = 'done'
        else if (at - startedAt > LAB_ROUTES_WAIT_MS) {
          lab.note('gave up waiting for routes')
          autopilot = 'done'
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
