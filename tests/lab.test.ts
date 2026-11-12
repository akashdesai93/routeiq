import { describe, expect, it } from 'vitest'
import { createDriveDiagnostics } from '../src/device/native/diagnostics.ts'
import { createLab, driveStart, LAB_POSITION_RETRY_MS, LAB_REPORT_MS, LAB_ROUTES_WAIT_MS, LAB_START_RADIUS_M, labScenario, startLab, statusWord, type LabDocument, type LabPlugin, type RouteIQLab } from '../src/lab/lab.ts'

// The phone lab's test hook (src/lab/lab.ts, docs/phone-lab.md): it must not exist unless the
// app was started with the lab's launch argument, and what it writes out for the PC must not
// be able to carry a road name, a place or a position.

interface FakeElement {
  textContent: string
  disabled?: boolean
  clicks: number
  click(): void
}
const el = (textContent: string, disabled = false): FakeElement => ({
  textContent,
  disabled,
  clicks: 0,
  click() {
    this.clicks++
  },
})

/** A stand-in for the page: each selector the lab uses, and what it finds. */
function page(found: Record<string, FakeElement[]>): LabDocument {
  return {
    querySelector: (selector) => found[selector]?.[0] ?? null,
    querySelectorAll: (selector) => found[selector] ?? [],
  }
}

const planPage = (start: FakeElement, routes = 2) =>
  page({ '.plan': [el('plan')], '.routes > li': Array.from({ length: routes }, () => el('Route')), button: [el('Swap'), start] })

function drivePage(status: FakeElement | string, road = '300 ft Left: Providence Road') {
  return page({
    '.live-top': [el(road)],
    '.live-bottom': [el('')],
    '.live-turn-distance': [el('300 ft')],
    '.live-eta': [el('9:41 12 min 5.1 mi')],
    '.live-eta strong': [el('9:41')],
    '.live-status': [typeof status === 'string' ? el(status) : status],
    button: [el('Mute'), el('End')],
  })
}

function labPlugin(answer: unknown, reports: string[] = []): LabPlugin {
  return {
    lab: () => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer as { enabled?: boolean; scenario?: string })),
    labReport: ({ text }) => {
      reports.push(text)
      return Promise.resolve()
    },
  }
}

describe('the lab is off unless the app was started with its launch argument', () => {
  it.each<[string, (reports: string[]) => LabPlugin | null]>([
    ['in a browser (no plugin)', () => null],
    ['in a shell build from before the lab', () => ({})],
    ['when the plugin says it is off', (r) => labPlugin({ enabled: false }, r)],
    ['when the plugin says on but names no scenario', (r) => labPlugin({ enabled: true }, r)],
    ['when the scenario is not a short lowercase word', (r) => labPlugin({ enabled: true, scenario: 'drive; rm' }, r)],
    ['when "enabled" is not exactly true', (r) => labPlugin({ enabled: 'yes', scenario: 'drive' }, r)],
    ['when the plugin fails', (r) => labPlugin(new Error('bridge'), r)],
  ])('%s: no hook on window, no timer, no report', async (_name, make) => {
    const target: { __routeiqLab?: RouteIQLab; document: LabDocument } = { document: planPage(el('Start drive')) }
    const timers: number[] = []
    const reports: string[] = []
    const plugin = make(reports)
    const lab = await startLab({ plugin, diagnostics: createDriveDiagnostics(), target, every: (ms) => timers.push(ms) })
    expect(lab).toBeNull()
    expect('__routeiqLab' in target).toBe(false)
    expect(timers).toEqual([])
    expect(reports).toEqual([])
    expect(await labScenario(plugin)).toBeNull()
  })

  it('with the launch argument the hook is there, under the scenario the plugin named', async () => {
    const target: { __routeiqLab?: RouteIQLab; document: LabDocument } = { document: planPage(el('Start drive')) }
    const lab = await startLab({ plugin: labPlugin({ enabled: true, scenario: 'plan' }), diagnostics: createDriveDiagnostics(), target, every: () => 0 })
    expect(lab).not.toBeNull()
    expect(target.__routeiqLab).toBe(lab)
    expect(lab?.scenario).toBe('plan')
  })
})

describe("the lab presses the app's own buttons", () => {
  it('presses the enabled button with exactly that text, and says so when there is none', () => {
    const start = el('  Start drive ')
    const lab = createLab({ scenario: 'plan', doc: planPage(start), diagnostics: createDriveDiagnostics() })
    expect(lab.startDrive()).toBe(true)
    expect(start.clicks).toBe(1)
    expect(lab.press('Start')).toBe(false)
    expect(lab.startTestDrive()).toBe(false)
  })

  it('does not press a disabled button', () => {
    const start = el('Start drive', true)
    const lab = createLab({ scenario: 'plan', doc: planPage(start), diagnostics: createDriveDiagnostics() })
    expect(lab.startDrive()).toBe(false)
    expect(start.clicks).toBe(0)
    expect(lab.read().canStartDrive).toBe(false)
  })

  // Trade and Tryon, the start of the lab's preset drives, and a point 1 km away.
  const AT_START = 'drive-at-m8084316-3522716'
  const START = { lng: -80.84316, lat: 35.22716 }
  const ELSEWHERE = { lng: -80.84316, lat: 35.23616 }

  /** Runs startLab with a clock and a timer the test moves by hand. `position`: what the phone says when asked where it is. */
  async function autopilot(scenario: string, doc: LabDocument, position: { lng: number; lat: number } | Error = START) {
    let nowMs = 1_000_000
    let beat = () => {}
    const reports: string[] = []
    const asked = { times: 0 }
    const where = { now: position }
    await startLab({
      plugin: {
        ...labPlugin({ enabled: true, scenario }, reports),
        getCurrentPosition: () => {
          asked.times++
          return where.now instanceof Error ? Promise.reject(where.now) : Promise.resolve(where.now)
        },
      },
      diagnostics: createDriveDiagnostics(() => nowMs),
      target: { document: doc },
      now: () => nowMs,
      every: (_ms, fn) => {
        beat = fn
      },
    })
    return {
      reports,
      asked,
      where,
      async pass(ms: number) {
        nowMs += ms
        beat()
        // Lets the answer to "where are you?" arrive.
        await new Promise((resolve) => setTimeout(resolve, 0))
      },
    }
  }

  it('at the simulated start, the drive scenario presses Start drive once, as soon as routes are listed and the button is enabled', async () => {
    const start = el('Start drive', true)
    const run = await autopilot(AT_START, planPage(start))
    await run.pass(1000)
    expect(start.clicks).toBe(0)
    expect(run.asked.times).toBe(0)
    start.disabled = false
    await run.pass(1000)
    await run.pass(LAB_POSITION_RETRY_MS)
    await run.pass(LAB_POSITION_RETRY_MS)
    expect(start.clicks).toBe(1)
    expect(run.asked.times).toBe(1)
  })

  it('on any other position (the real GPS) it never presses Start drive, and says so without saying where', async () => {
    const start = el('Start drive')
    const run = await autopilot(AT_START, planPage(start), ELSEWHERE)
    for (let i = 0; i < 5; i++) await run.pass(LAB_POSITION_RETRY_MS)
    expect(start.clicks).toBe(0)
    expect(run.asked.times).toBeGreaterThan(1)
    expect(run.reports.at(-1)).toContain('the phone is not at the simulated start: not starting the drive')
    expect(run.reports.at(-1)).not.toMatch(/\d\.\d{3,}/)
  })

  it('it starts once the simulated position reaches the phone', async () => {
    const start = el('Start drive')
    const run = await autopilot(AT_START, planPage(start), ELSEWHERE)
    await run.pass(LAB_POSITION_RETRY_MS)
    expect(start.clicks).toBe(0)
    run.where.now = { lng: START.lng + 0.001, lat: START.lat }
    await run.pass(LAB_POSITION_RETRY_MS)
    expect(start.clicks).toBe(1)
  })

  it('just outside the radius is not the start', async () => {
    const start = el('Start drive')
    // 0.003 degrees of latitude is about 330 m; the radius is 250 m.
    const run = await autopilot(AT_START, planPage(start), { lng: START.lng, lat: START.lat + 0.003 })
    await run.pass(LAB_POSITION_RETRY_MS)
    expect(LAB_START_RADIUS_M).toBe(250)
    expect(start.clicks).toBe(0)
  })

  it('no position from the phone: no drive', async () => {
    const start = el('Start drive')
    const run = await autopilot(AT_START, planPage(start), new Error('denied'))
    await run.pass(LAB_POSITION_RETRY_MS)
    expect(start.clicks).toBe(0)
  })

  it('a scenario that names no start never starts a drive, whatever it is called', async () => {
    for (const scenario of ['drive', 'drive-at', 'drive-at-999999999-0', 'drive-at-m8084316-9100000']) {
      const start = el('Start drive')
      const run = await autopilot(scenario, planPage(start))
      for (let i = 0; i < 3; i++) await run.pass(LAB_POSITION_RETRY_MS)
      expect(start.clicks, scenario).toBe(0)
      expect(run.asked.times, scenario).toBe(0)
    }
    expect(driveStart(AT_START)).toEqual(START)
    expect(driveStart('drive-at-12345-m3300000')).toEqual({ lng: 0.12345, lat: -33 })
  })

  it('without routes it does not ask for the position, and gives up after the wait', async () => {
    const start = el('Start drive')
    const run = await autopilot(AT_START, planPage(start, 0))
    await run.pass(1000)
    await run.pass(LAB_ROUTES_WAIT_MS)
    expect(start.clicks).toBe(0)
    expect(run.asked.times).toBe(0)
    await run.pass(LAB_REPORT_MS)
    expect(run.reports.at(-1)).toContain('gave up: no routes, or the phone never reached the simulated start')
  })

  it('scenario "plan" never presses Start drive, and still writes its report', async () => {
    const start = el('Start drive')
    const run = await autopilot('plan', planPage(start))
    await run.pass(1000)
    await run.pass(LAB_REPORT_MS)
    expect(start.clicks).toBe(0)
    expect(run.reports.length).toBeGreaterThan(0)
    expect(run.reports.at(-1)).toMatch(/^RouteIQ lab report\nscenario plan, /)
    expect(run.reports.at(-1)).toContain('screen plan, status plan, routes 2,')
  })
})

describe('what the lab reads and what it writes out', () => {
  it('read() gives the turn card, the arrival line and the status as shown', () => {
    const shown = 'Watching for a faster route. · checked 4 s ago · 3 of 60 requests'
    const lab = createLab({ scenario: 'drive', doc: drivePage(shown), diagnostics: createDriveDiagnostics() })
    expect(lab.read()).toMatchObject({ screen: 'drive', turn: '300 ft Left: Providence Road', eta: '9:41 12 min 5.1 mi', status: shown })
  })

  it.each([
    ['Finding your position…', 'locating'],
    ['Finding a route…', 'planning'],
    ['Off the route. Finding a new one… · checking now · 4 of 60 requests', 'off-route'],
    ['Standing still: checks are paused until you move.', 'stationary'],
    ['Route via Providence Road saves 4 min', 'driving'],
  ])('status "%s" is written as the word %s', (status, word) => {
    const lab = createLab({ scenario: 'drive', doc: drivePage(status), diagnostics: createDriveDiagnostics() })
    expect(statusWord(lab.read())).toBe(word)
  })

  it('the history records off the route and back, with the time, in order, once each', () => {
    let nowMs = new Date(2026, 10, 11, 21, 40, 0).getTime()
    const status = el('Watching for a faster route.')
    const lab = createLab({ scenario: 'drive', doc: drivePage(status), diagnostics: createDriveDiagnostics(() => nowMs), now: () => nowMs })
    lab.sample()
    nowMs += 70_000
    status.textContent = 'Off the route. Finding a new one…'
    lab.sample()
    lab.sample()
    nowMs += 6_000
    status.textContent = 'Watching for a faster route.'
    lab.sample()
    const history = lab
      .report()
      .split('\n')
      .filter((line) => /^\d\d:\d\d:\d\d status /.test(line))
    expect(history).toEqual(['21:40:00 status driving', '21:41:10 status off-route', '21:41:16 status driving'])
  })

  it('the report holds no road name, place, position or token, whatever the screen shows', () => {
    const diagnostics = createDriveDiagnostics()
    const lab = createLab({
      scenario: 'drive',
      doc: drivePage('Route via Providence Road saves 4 min at -80.84316, 35.22716 pk.eyJ1Ijoibm90LWEtcmVhbC10b2tlbiJ9.c2lnbmF0dXJl'),
      diagnostics,
    })
    lab.sample()
    const report = lab.report()
    expect(report).not.toMatch(/Providence|SouthPark|pk\.|\d\.\d{3,}/)
    expect(report).toContain('turn card shown, arrival time shown')
    expect(report.endsWith(`--- diagnostics ---\n${diagnostics.text()}`)).toBe(true)
  })
})
