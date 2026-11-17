import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { checkDrawnWithin, DEFAULT_LAB_CHECKS, firstDrawn, nativeMetrics, parseLabReport } from '../scripts/phone/lab/assertions.mjs'
import { readPlan } from '../scripts/phone/lab/queue.mjs'
import { driveScreenScenario, EARLY_NAMES, flatStretches, labLaunchArgs, NATIVE_SWITCHES, parseArgs } from '../scripts/phone/lab/run.mjs'
import { createDriveDiagnostics } from '../src/device/native/diagnostics.ts'
import { LAB_NATIVE_KICKS, labFix, startLab, startWaitSec, type LabDocument, type LabPlugin } from '../src/lab/lab.ts'
import { EARLY_FIXES } from '../src/lab/probe.ts'

// #136, round 2: the driving screen is black on the iPhone after Start drive. These pin the
// phone lab's diagnostic tools: how "drawn within 2 s of Start drive" is decided, that the
// native switches are reachable only in lab mode, and that the PC and the app agree on the
// names of the switches, the kicks and the early changes.

const swiftDir = new URL('../native/shell/shell-native/ios/Sources/RouteIQNativePlugin/', import.meta.url)
const swift = (name: string) => readFileSync(new URL(name, swiftDir), 'utf8')

const flat = (sec: number) => ({ sec, look: { flat: 0.99, shade: 0 } })
const drawn = (sec: number) => ({ sec, look: { flat: 0.4, shade: 230 } })

describe('drive-screen: seconds from Start drive until the screen is drawn', () => {
  it('drawn at once and kept: passes, and says when', () => {
    const samples = [drawn(0.6), drawn(1.7), drawn(2.9), drawn(9.5)]
    expect(firstDrawn(samples)).toMatchObject({ drawnSec: 0.6, blackAgain: false, measured: 4 })
    const v = checkDrawnWithin(samples)
    expect(v.pass).toBe(true)
    expect(v.detail).toContain('0.6 s')
  })

  it('black until 18 s, as in the first run on PR #141: fails, and says it was drawn at 18 s', () => {
    const samples = [flat(0.5), flat(3), flat(9), flat(15), drawn(18.2), drawn(25)]
    const v = checkDrawnWithin(samples)
    expect(v.pass).toBe(false)
    expect(v.detail).toContain('18.2 s')
  })

  it('never drawn in the watch: fails', () => {
    const v = checkDrawnWithin([flat(1), flat(20), flat(39.5)])
    expect(v.pass).toBe(false)
    expect(v.detail).toContain('never drawn')
  })

  it('drawn at 1 s and black again at 5 s: fails, a screen that flickers off is not a fix', () => {
    const v = checkDrawnWithin([drawn(1), drawn(3), flat(5), drawn(9)])
    expect(v.pass).toBe(false)
    expect(v.detail).toContain('flat again')
  })

  it('the limit is 2 s: drawn at 2.4 s fails, at 1.9 s passes', () => {
    expect(DEFAULT_LAB_CHECKS.maxDrawnSec).toBe(2)
    expect(checkDrawnWithin([flat(0.5), drawn(2.4), drawn(10)]).pass).toBe(false)
    expect(checkDrawnWithin([flat(0.5), drawn(1.9), drawn(10)]).pass).toBe(true)
  })

  it('no screenshot measured: not run, never a pass', () => {
    const v = checkDrawnWithin([{ sec: 1, look: null }])
    expect(v.pass).toBe(false)
    expect(v.notRun).toBe(true)
  })
})

describe('the native lab switches: the PC and the app agree, and only lab mode reads them', () => {
  const lab = swift('RouteIQLab.swift')

  it('run.mjs knows exactly the switches RouteIQLab.Switch has', () => {
    const inSwift = [...lab.matchAll(/case \w+ = "([a-z-]+)"/g)].map((m) => m[1]).sort()
    expect(inSwift.length).toBeGreaterThan(10)
    expect([...NATIVE_SWITCHES].sort()).toEqual(inSwift)
  })

  it('without the lab launch argument there are no switches, whatever else was passed', () => {
    const body = lab.slice(lab.indexOf('static func switches('), lab.indexOf('static let active'))
    const guard = body.indexOf('guard scenario(arguments: arguments) != nil else { return [] }')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(body.indexOf('switchArgument'))
    // The one set the app uses is read through that function.
    expect(lab).toMatch(/static let active: Set<Switch> = switches\(\)/)
  })

  it('the engine takes its switches from RouteIQLab.active only, and the plugin never passes others', () => {
    const engine = swift('RouteIQEngine.swift')
    expect(engine).toMatch(/init\(lab: Set<RouteIQLab\.Switch> = RouteIQLab\.active\)/)
    const plugin = swift('RouteIQNativePlugin.swift')
    expect(plugin).toMatch(/let engine = RouteIQEngine\(\)/)
    expect(plugin.includes('RouteIQEngine(lab:')).toBe(false)
  })

  it('the native monitor exists only after the lab check, and its three methods refuse without it', () => {
    const plugin = swift('RouteIQNativePlugin.swift')
    const setUp = plugin.slice(plugin.indexOf('private func setUpLab()'), plugin.indexOf('@objc func lab('))
    const check = setUp.indexOf('guard RouteIQLab.scenario() != nil else { return }')
    expect(check).toBeGreaterThan(-1)
    expect(check).toBeLessThan(setUp.indexOf('RouteIQLabMonitor('))
    expect(plugin.split('RouteIQLabMonitor(').length).toBe(2)
    for (const name of ['labNative', 'labKick', 'labSnapshot']) {
      const start = plugin.indexOf(`@objc func ${name}(`)
      const body = plugin.slice(start, plugin.indexOf('\n    }\n', start))
      expect(body, name).toMatch(/guard let monitor = self\.labMonitor else \{\s*call\.reject\("The lab is off", "not-allowed"\)/)
    }
  })

  it('the snapshot file is written only in lab mode, in the temporary folder', () => {
    const start = lab.indexOf('static func writeSnapshot(')
    const body = lab.slice(start, lab.indexOf('\n    }\n', start))
    expect(body.indexOf('guard scenario(arguments: arguments) != nil')).toBeGreaterThan(-1)
    expect(body.indexOf('guard scenario(arguments: arguments) != nil')).toBeLessThan(body.indexOf('FileManager'))
    expect(body).toContain('temporaryDirectory')
  })

  it('the kicks the page may ask for are the kicks the monitor has', () => {
    const monitor = swift('RouteIQLabView.swift')
    const listed = monitor.match(/static let kicks = \[([^\]]+)\]/)?.[1] ?? ''
    expect([...listed.matchAll(/"([a-z]+)"/g)].map((m) => m[1])).toEqual([...LAB_NATIVE_KICKS])
    // Every kick- switch names one of them.
    for (const s of NATIVE_SWITCHES.filter((n) => n.startsWith('kick-'))) expect(LAB_NATIVE_KICKS).toContain(s.slice(5))
  })
})

describe('run.mjs: --native, --early and --fix for #136', () => {
  it('passes the native switches as one launch argument after the scenario', () => {
    const options = parseArgs(['--scenario', 'drive-screen', '--native', 'no-idle,marks', '--push-web'])
    if ('error' in options) throw new Error(options.error)
    expect(labLaunchArgs('testdrive', options)).toEqual(['-routeiqLab', 'testdrive', '-routeiqLabWeb', '-routeiqLabSwitch', 'no-idle,marks'])
  })

  it('no --native: no switch argument at all', () => {
    const options = parseArgs(['--scenario', 'drive-screen'])
    if ('error' in options) throw new Error(options.error)
    expect(labLaunchArgs('testdrive', options)).toEqual(['-routeiqLab', 'testdrive'])
  })

  it('refuses an unknown native switch instead of running a variant that is not what it says', () => {
    expect(parseArgs(['--scenario', 'drive-screen', '--native', 'no-idle,no-idel'])).toHaveProperty('error')
  })

  it('--early and --fix become the scenario names the app knows, one change per run', () => {
    const early = parseArgs(['--scenario', 'drive-screen', '--early', 'nomap'])
    const fix = parseArgs(['--scenario', 'drive-screen', '--fix', 'kick-opaque'])
    if ('error' in early || 'error' in fix) throw new Error('refused')
    expect(driveScreenScenario(early)).toBe('testdrive-early-nomap')
    expect(driveScreenScenario(fix)).toBe('testdrive-fix-kick-opaque')
    expect(parseArgs(['--scenario', 'drive-screen', '--early', 'nomap', '--fix', 'resize'])).toHaveProperty('error')
    expect(parseArgs(['--scenario', 'drive-screen', '--early', 'everything'])).toHaveProperty('error')
    expect([...EARLY_NAMES].sort()).toEqual(Object.keys(EARLY_FIXES).sort())
  })
})

describe('the queue: every build gets the screen-drawn check after Start drive', () => {
  const plan = (builds: unknown[]) => JSON.stringify({ rollback: 'good.ipa', builds })
  const there = () => true

  it('a build whose runs leave drive-screen out is refused', () => {
    const read = readPlan(plan([{ name: 'pr', ipa: 'pr.ipa', runs: [['--scenario', 'starts-and-plans']] }]), there)
    expect(read).toHaveProperty('error')
    expect((read as { error: string }).error).toContain('drive-screen')
  })

  it('unless a reason is written down', () => {
    const read = readPlan(plan([{ name: 'pr', ipa: 'pr.ipa', runs: [['--scenario', 'starts-and-plans']], noDriveScreen: 'the build cannot start a drive' }]), there)
    expect(read).not.toHaveProperty('error')
  })

  it('the default runs have it', () => {
    expect(readPlan(plan([{ name: 'main', ipa: 'main.ipa' }]), there)).not.toHaveProperty('error')
  })
})

describe('the app side of the lab for #136', () => {
  const el = (textContent: string) => ({ textContent, disabled: false, checked: true, clicks: 0, click() {
    this.clicks++
  } })

  it('a testdrive-early scenario makes its change before Start drive is pressed, and the report goes out at the press', async () => {
    const start = el('Start drive')
    const order: string[] = []
    const reports: string[] = []
    let beat = () => {}
    const doc: LabDocument = {
      querySelector: (s) => ({ '.plan': el('plan'), '.testdrive input[type="checkbox"]': el('') } as Record<string, unknown>)[s] ?? null,
      querySelectorAll: (s) => (s === 'button' ? [start] : s === '.routes > li' ? [el('Route')] : []),
    }
    let nowMs = 1_000_000
    const plugin: LabPlugin = {
      lab: () => Promise.resolve({ enabled: true, scenario: 'testdrive-early-nomap' }),
      labReport: ({ text }) => {
        reports.push(text)
        order.push(start.clicks > 0 ? 'report after press' : 'report')
        return Promise.resolve()
      },
    }
    await startLab({
      plugin,
      diagnostics: createDriveDiagnostics(() => nowMs),
      target: { document: doc },
      probe: { layout: () => '{}', fixes: {}, early: { nomap: () => (order.push(`early, ${start.clicks} presses`), 'no map') } },
      now: () => nowMs,
      every: (_ms, fn) => {
        beat = fn
      },
    })
    for (let i = 0; i < 3; i++) {
      nowMs += 1000
      beat()
    }
    expect(order[order.indexOf('early, 0 presses')]).toBeDefined()
    expect(start.clicks).toBe(1)
    // The report written right at the press says the drive was started.
    expect(order).toContain('report after press')
    expect(reports.at(-1)).toContain('pressed "Start drive"')
    expect(reports.at(-1)).toContain('early: no map')
  })

  it('a native kick is asked of the plugin by name, and only a known one', async () => {
    const asked: string[] = []
    const notes: string[] = []
    const plugin: LabPlugin = { labKick: ({ name }) => (asked.push(name), Promise.resolve({ did: 'toggled' })) }
    expect(labFix('kick-opaque', plugin, {}, (n) => notes.push(n))?.()).toBe('asked for the native kick opaque')
    await new Promise((r) => setTimeout(r, 0))
    expect(asked).toEqual(['opaque'])
    expect(notes).toEqual(['native kick opaque: toggled'])
    expect(labFix('kick-reboot', plugin, {}, () => {})).toBeUndefined()
    // A build without the native kicks: no such fix, rather than a fix that silently does nothing.
    expect(labFix('kick-opaque', {}, {}, () => {})).toBeUndefined()
    expect(labFix('resize', plugin, { resize: () => 'sent' }, () => {})?.()).toBe('sent')
  })

  it('the native probe goes into the report as one line the PC can read back', () => {
    const probe = { stall: { longestMs: 2300, longestAt: '41.2', longestSinceDriveMs: 2300 }, terminations: 0, webView: { inWindow: true, hidden: false, opaque: true, layerInTree: true, frame: [0, 0, 440, 956], safeArea: [62, 0, 34, 0] } }
    const text = ['RouteIQ lab report', 'scenario testdrive, written 21:00:00, number 3', 'screen drive, status driving, routes 0, turn card shown, arrival time shown, warnings 0', `native ${JSON.stringify(probe)}`, 'history (oldest first):', '21:00:00 pressed "Start drive"', '--- diagnostics ---', ''].join('\n')
    const parsed = parseLabReport(text)
    expect(parsed?.native).toEqual(probe)
    expect(parsed?.startPressedAt).toBe('21:00:00')
    expect(nativeMetrics(parsed?.native ?? null)).toContainEqual(['longest main-thread stall since Start drive, ms', 2300])
  })
})

describe('how the drive is started (#136: a finger start after some seconds drew, the lab\'s quick start did not)', () => {
  const el = (textContent: string) => ({ textContent, disabled: false, checked: true, clicks: 0, click() {
    this.clicks++
  } })

  it('testdrive-wait-<sec> presses Start drive only that long after the plan screen is ready, not before', async () => {
    expect(startWaitSec('testdrive-wait-10')).toBe(10)
    expect(startWaitSec('testdrive-wait-0')).toBe(0)
    expect(startWaitSec('testdrive-wait-500')).toBe(0)
    expect(startWaitSec('testdrive')).toBe(0)
    const start = el('Start drive')
    const doc: LabDocument = {
      querySelector: (s) => ({ '.plan': el('plan'), '.testdrive input[type="checkbox"]': el('') } as Record<string, unknown>)[s] ?? null,
      querySelectorAll: (s) => (s === 'button' ? [start] : s === '.routes > li' ? [el('Route')] : []),
    }
    let nowMs = 1_000_000
    let beat = () => {}
    await startLab({
      plugin: { lab: () => Promise.resolve({ enabled: true, scenario: 'testdrive-wait-10' }), labReport: () => Promise.resolve() },
      diagnostics: createDriveDiagnostics(() => nowMs),
      target: { document: doc },
      now: () => nowMs,
      every: (_ms, fn) => {
        beat = fn
      },
    })
    const pass = (ms: number) => {
      nowMs += ms
      beat()
    }
    pass(1000) // ready: the wait starts
    for (let i = 0; i < 9; i++) pass(1000)
    expect(start.clicks).toBe(0)
    pass(1000)
    expect(start.clicks).toBe(1)
  })

  it('run.mjs: --wait and --cold for drive-screen only, one change per run', () => {
    const wait = parseArgs(['--scenario', 'drive-screen', '--wait', '10', '--cold'])
    if ('error' in wait) throw new Error(wait.error)
    expect(driveScreenScenario(wait)).toBe('testdrive-wait-10')
    expect(wait.cold).toBe(true)
    expect(parseArgs(['--scenario', 'starts-and-plans', '--cold'])).toHaveProperty('error')
    expect(parseArgs(['--scenario', 'drive-screen', '--wait', '10', '--early', 'nomap'])).toHaveProperty('error')
    expect(parseArgs(['--scenario', 'drive-screen', '--wait', '2.5'])).toHaveProperty('error')
    expect(parseArgs(['--scenario', 'watch-screen', '--seconds', '90'])).not.toHaveProperty('error')
  })

  it('watch-screen: a flat stretch of 2 s or more is reported with its times; a single flat frame is not', () => {
    const look = (flat: number) => ({ flat, shade: 0 })
    const samples = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((sec) => ({ sec, look: look(sec >= 3 && sec <= 6 ? 0.99 : 0.4) }))
    expect(flatStretches(samples)).toEqual([{ from: 3, to: 6 }])
    expect(flatStretches([{ sec: 0, look: look(0.4) }, { sec: 1, look: look(0.99) }, { sec: 2, look: look(0.4) }])).toEqual([])
    // Still flat at the end of the watch counts too.
    expect(flatStretches([{ sec: 0, look: look(0.4) }, { sec: 5, look: look(0.99) }, { sec: 9, look: look(0.99) }])).toEqual([{ from: 5, to: 9 }])
  })
})
