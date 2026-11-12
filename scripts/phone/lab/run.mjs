#!/usr/bin/env node
// The phone lab: runs a scenario on the real iPhone on the USB cable, with nobody touching it,
// and writes phone-lab/report-<time>/ (git-ignored): screenshots, the app's diagnostics, a
// system-log excerpt and summary.md. How it works and what each check proves: docs/phone-lab.md.
//
//   node scripts/phone/lab/run.mjs --scenario locked-wrong-turn
//
// While a drive scenario runs, the WHOLE PHONE reports the simulated position (Find My
// included). It is cleared at the end, on failure and on Ctrl+C.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildTrack, pathFrom } from '../make-gpx.mjs'
import { PRESETS } from '../presets.mjs'
import { checkDrawnWithin, checkLockedWrongTurn, checkPlanShowsRoutes, checkScreenDrawn, checkSoak, DEFAULT_LAB_CHECKS, firstDrawn, nativeMetrics, notRun, parseLabReport, planFromCaptions, redact, runMetrics } from './assertions.mjs'
import { BACKGROUND_APP, connectPhone, sleep, SNAPSHOT_IN_APP } from './phone.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

export const SCENARIOS = Object.freeze({
  'starts-and-plans': 'Starts the app and checks that the plan screen lists routes.',
  'locked-wrong-turn': 'Starts a drive, puts the app in the background (and the phone to sleep with --lock), replays a drive with a wrong turn, and checks what the app did meanwhile.',
  'background-soak': 'The same with a drive that stays on the route, for --minutes (default 10), with CPU and battery samples.',
  'watch-screen': 'Starts nothing: takes screenshots one after another for --seconds (default 120) while a PERSON opens RouteIQ from its icon and taps Start drive. When the drive screen first shows up and whether it is drawn (#136: lab starts against finger starts).',
  'drive-screen': 'Starts the in-app test drive, leaves the app in front and takes screenshots one after another for 40 s: how many seconds after Start drive is the driving screen drawn (it must be within 2 s and stay drawn)? With --fix <name>, tries that 12 s in.',
})

/**
 * The app's native lab switches for #136 (RouteIQLab.Switch in RouteIQLab.swift; a test holds the
 * two lists equal). Passed as `-routeiqLabSwitch a,b` and read only in lab mode.
 */
export const NATIVE_SWITCHES = Object.freeze([
  'no-idle', 'no-audio', 'no-speech', 'no-bglocation', 'no-location', 'no-always', 'no-testdrive',
  'audio-offmain', 'insets-never',
  'kick-layout', 'kick-display', 'kick-frame', 'kick-scroll', 'kick-opaque', 'kick-readd',
  'marks', 'snapshot',
])
/** What --early can change on the page before Start drive (EARLY_FIXES in src/lab/probe.ts). */
export const EARLY_NAMES = Object.freeze(['nomap', 'red', 'rednomap'])

export const USAGE = [
  'Usage: node scripts/phone/lab/run.mjs --scenario <name> [options]',
  ...Object.entries(SCENARIOS).map(([name, about]) => `  ${name.padEnd(18)} ${about}`),
  'Options:',
  '  --lock           put the phone to sleep (screen off) while away; the car is then the in-app test drive.',
  '                   The screen stays off afterwards: needs --owner-unlocks-after, and is the last run of a session',
  '  --in-app         move the car with the in-app test drive instead of the phone\'s position over USB',
  '  --no-gps         do not replay the drive (the phone stands still): the off-route check must then fail',
  '  --away-sec <n>   locked-wrong-turn: seconds in the background (default 170)',
  '  --minutes <n>    background-soak: minutes in the background (default 10)',
  '  --from-m <n>     skip this much of the preset drive (default 4400 for locked-wrong-turn, 0 for the soak)',
  '  --speed <m/s>    driving speed of the replay (default 13)',
  '  --fix <name>     drive-screen: tried 12 s in. resize | reflow | layer | nomap | red | scroll (src/lab/probe.ts),',
  '                   kick-layout | kick-display | kick-scroll | kick-frame | kick-opaque | kick-readd (native), snapshot',
  '  --early <name>   drive-screen: changed on the page before Start drive: nomap | red | rednomap',
  '  --wait <sec>     drive-screen: wait this long with the plan screen ready before Start drive (1-120)',
  '  --cold           drive-screen: first leave the app in the background 15 s (Calculator in front), then launch it',
  '  --seconds <n>    watch-screen: how long to watch (default 120)',
  `  --native <list>  native lab switches, comma-separated (#136): ${NATIVE_SWITCHES.join(' ')}`,
  '  --push-web       build the web app (native/shell) and copy it into the app first; the app then runs that build',
  '  --web            run the web build that was pushed earlier instead of the one in the app',
  '  --out <dir>      where reports go (default phone-lab/)',
].join('\n')

export function parseArgs(argv) {
  const options = { scenario: null, fix: null, early: null, native: [], waitSec: 0, cold: false, seconds: 120, lock: false, ownerUnlocksAfter: false, inApp: false, gps: true, awaySec: 170, minutes: 10, fromM: null, speed: 13, pushWeb: false, web: false, out: path.join(repo, 'phone-lab') }
  const numbers = { '--away-sec': 'awaySec', '--minutes': 'minutes', '--from-m': 'fromM', '--speed': 'speed', '--wait': 'waitSec', '--seconds': 'seconds' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--lock') options.lock = options.inApp = true
    else if (arg === '--owner-unlocks-after') options.ownerUnlocksAfter = true
    else if (arg === '--in-app') options.inApp = true
    else if (arg === '--cold') options.cold = true
    else if (arg === '--no-gps') options.gps = false
    else if (arg === '--push-web') options.pushWeb = options.web = true
    else if (arg === '--web') options.web = true
    else if (arg === '--scenario' || arg === '--out' || arg === '--fix' || arg === '--early' || arg === '--native' || arg in numbers) {
      const value = argv[++i]
      if (value === undefined) return { error: `${arg} needs a value` }
      if (arg === '--scenario') options.scenario = value
      else if (arg === '--fix') options.fix = value
      else if (arg === '--early') options.early = value
      else if (arg === '--native') {
        const list = value.split(',').map((v) => v.trim()).filter((v) => v !== '')
        const unknown = list.filter((v) => !NATIVE_SWITCHES.includes(v))
        if (list.length === 0 || unknown.length > 0) return { error: `--native: unknown switch ${unknown.join(', ') || '(none given)'}; known: ${NATIVE_SWITCHES.join(', ')}` }
        options.native = [...new Set(list)]
      }
      else if (arg === '--out') options.out = path.resolve(value)
      else {
        const n = Number(value)
        if (!Number.isFinite(n) || n < 0) return { error: `${arg} must be a number, 0 or more` }
        options[numbers[arg]] = n
      }
    } else return { error: `Unknown option ${arg}` }
  }
  if (options.scenario === null || !(options.scenario in SCENARIOS)) return { error: `Give --scenario: ${Object.keys(SCENARIOS).join(' | ')}` }
  if (options.fix !== null && (options.scenario !== 'drive-screen' || !/^[a-z][a-z-]{1,15}$/.test(options.fix))) return { error: '--fix <name> goes with --scenario drive-screen' }
  if (options.early !== null && (options.scenario !== 'drive-screen' || !EARLY_NAMES.includes(options.early))) return { error: `--early <name> goes with --scenario drive-screen: ${EARLY_NAMES.join(' | ')}` }
  if (options.early !== null && options.fix !== null) return { error: '--early and --fix cannot be combined: one change per run' }
  if ((options.waitSec > 0 || options.cold) && options.scenario !== 'drive-screen') return { error: '--wait and --cold go with --scenario drive-screen' }
  if (options.waitSec > 0 && (!Number.isInteger(options.waitSec) || options.waitSec > 120)) return { error: '--wait must be a whole number of seconds, 1 to 120' }
  if (options.waitSec > 0 && (options.early !== null || options.fix !== null)) return { error: '--wait cannot be combined with --early or --fix: one change per run' }
  if (options.scenario === 'watch-screen' && (options.seconds < 10 || options.seconds > 600)) return { error: '--seconds must be between 10 and 600' }
  if (options.speed < 1 || options.speed > 40) return { error: '--speed must be between 1 and 40 m/s' }
  if (options.lock && !options.ownerUnlocksAfter) return { error: '--lock leaves the phone with its screen off, and nothing can be looked at after it until someone wakes the phone. Add --owner-unlocks-after to say that is understood, and make it the last run.' }
  if (options.inApp && !options.gps) return { error: '--no-gps goes with the USB position, not with --lock or --in-app' }
  if (options.inApp && options.scenario === 'background-soak') return { error: 'the soak replays its drive over USB: it cannot be combined with --lock or --in-app' }
  return options
}

/** The app's launch arguments for a lab scenario: the scenario, the pushed web app, the native switches. */
export function labLaunchArgs(name, options) {
  return ['-routeiqLab', name, ...(options.web ? ['-routeiqLabWeb'] : []), ...(options.native.length > 0 ? ['-routeiqLabSwitch', options.native.join(',')] : [])]
}

/** Stretches of 2 s or more where the screenshots were flat (not drawn), as { from, to } seconds. */
export function flatStretches(samples, max = DEFAULT_LAB_CHECKS.maxFlatShare, minSec = 2) {
  const list = samples.filter((s) => s.look != null).sort((a, b) => a.sec - b.sec)
  const out = []
  let from = null
  let last = null
  for (const s of list) {
    if (s.look.flat >= max) {
      if (from === null) from = s.sec
      last = s.sec
    } else if (from !== null) {
      if (last - from >= minSec) out.push({ from, to: last })
      from = null
    }
  }
  if (from !== null && last - from >= minSec) out.push({ from, to: last })
  return out
}

/** The lab scenario drive-screen starts the app with: the test drive, with its --fix or --early. */
export function driveScreenScenario(options) {
  if (options.waitSec > 0) return `testdrive-wait-${options.waitSec}`
  return options.early !== null ? `testdrive-early-${options.early}` : options.fix !== null ? `testdrive-fix-${options.fix}` : 'testdrive'
}

const two = (n) => String(n).padStart(2, '0')
const clock = (d = new Date()) => `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
const stamp = (d = new Date()) => `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`

export function summaryMarkdown({ scenario, options, device, app, steps, checks, metrics = [], samples, simulated, files, result }) {
  const mark = (c) => (c.notRun ? 'NOT RUN' : c.pass ? 'pass' : 'FAIL')
  return [
    `# Phone lab: ${scenario}`,
    '',
    `Result: **${result}**`,
    '',
    `- Phone: ${device.model}, iOS ${device.ios}. App: ${app}.`,
    `- Options: ${options}`,
    simulated === null ? '- The simulated position was not used.' : `- The whole phone reported a simulated position from ${simulated.from} to ${simulated.to}. Cleared at the end: ${simulated.cleared ? 'yes' : 'NO, run scripts\\phone\\sim-drive.ps1 -ClearOnly'}.`,
    '',
    '## Checks',
    '',
    '| Check | Result | What was seen |',
    '| --- | --- | --- |',
    ...checks.map((c) => `| ${c.name} | ${mark(c)} | ${c.detail} |`),
    '',
    ...(metrics.length === 0 ? [] : ['## Numbers', '', '| What | Value |', '| --- | --- |', ...metrics.map(([what, value]) => `| ${what} | ${value} |`), '']),
    '## What happened',
    '',
    ...steps.map((s) => `- ${s}`),
    ...(samples.length === 0
      ? []
      : [
          '',
          '## CPU, memory and battery',
          '',
          'CPU is a share of one core at that moment. The phone is on the cable, so it is charging: the battery level says little, the temperature more.',
          '',
          '| Time | App CPU % | Web code CPU % | App MB | Web code MB | Battery % | °C |',
          '| --- | --- | --- | --- | --- | --- | --- |',
          ...samples.map((s) => `| ${s.at} | ${s.app?.cpuPercent ?? '?'} | ${s.webContent?.cpuPercent ?? '?'} | ${s.app?.memoryMb ?? '?'} | ${s.webContent?.memoryMb ?? '?'} | ${s.battery?.percent ?? '?'} | ${s.battery?.celsius ?? '?'} |`),
        ]),
    '',
    '## Files',
    '',
    ...files.map((f) => `- \`${f}\``),
    '',
  ].join('\n')
}

async function main(argv) {
  const options = parseArgs(argv)
  if ('error' in options) {
    console.error(`${options.error}\n\n${USAGE}`)
    return 64
  }
  const { scenario } = options
  const dir = path.join(options.out, `report-${stamp()}`)
  mkdirSync(dir, { recursive: true })
  const steps = []
  const files = []
  const samples = []
  let checks = []
  let finalReport = null
  const say = (line) => {
    const text = `${clock()} ${line}`
    steps.push(text)
    console.log(text)
  }
  let phone = null
  /** Takes a screenshot. Returns how it looks ({ flat, shade }), or null. */
  const shot = async (name) => {
    const taken = await phone.screenshot(path.join(dir, name))
    if (taken !== null) files.push(name)
    say(taken === null ? `screenshot ${name} could not be taken` : `screenshot ${name}${taken.look === null ? '' : `: ${Math.round(taken.look.flat * 100)} % one flat colour (shade ${taken.look.shade} of 255)`}`)
    return taken?.look ?? null
  }
  /** The app's lab report, parsed; null when the app wrote none. Keeps the text as `name` when given. */
  const report = (name) => {
    const file = path.join(dir, name ?? '.report.tmp')
    rmSync(file, { force: true })
    if (!phone.pullReport(file)) return null
    const text = readFileSync(file, 'utf8')
    if (name === undefined) rmSync(file, { force: true })
    else if (!files.includes(name)) files.push(name)
    return parseLabReport(text)
  }
  const sample = async () => {
    const s = { at: clock(), ...(await phone.processSample()), battery: phone.battery() }
    samples.push(s)
    return s
  }

  let device = { model: '?', ios: '?' }
  let app = '?'
  let bundle = null
  let simulated = null
  const cleanups = []
  let interrupted = false
  const onSignal = () => {
    interrupted = true
  }
  process.on('SIGINT', onSignal)
  const pause = async (ms) => {
    for (let left = ms; left > 0 && !interrupted; left -= 500) await sleep(Math.min(500, left))
    if (interrupted) throw new Error('interrupted')
  }
  const labArgs = (name) => labLaunchArgs(name, options)

  let failure = null
  try {
    phone = await connectPhone({ log: say })
    device = phone.device
    bundle = phone.bundle
    app = `RouteIQ ${phone.appVersion()}`
    say(`found ${device.model}, iOS ${device.ios}, ${app}`)

    if (options.pushWeb) {
      say('building the web app for the shell (native/shell)')
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
      const built = spawnSync(`${npm} run build`, { cwd: path.join(repo, 'native', 'shell'), stdio: 'ignore', shell: true, env: { ...process.env, VITE_MAPBOX_TOKEN: '' } })
      if (built.status !== 0) throw new Error('the web build failed (npm run build in native/shell)')
      if (!phone.pushWeb(path.join(repo, 'native', 'shell', 'www'))) throw new Error('the web build could not be copied into the app')
      say('web build copied into the app')
    }

    phone.removeReport()

    if (scenario === 'starts-and-plans') {
      if ((await phone.launch(bundle, { args: labArgs('plan') })) === null) throw new Error('the app did not start')
      say('app started')
      let seen = null
      let lab = null
      for (let waited = 0; waited < 45_000 && (seen === null || seen.routes === 0); waited += 5000) {
        await pause(5000)
        lab = report()
        if (lab !== null) seen = { routes: lab.routes, startDrive: lab.screen === 'plan', via: 'the lab report' }
        else if (waited >= 10_000) {
          const captions = await phone.captions()
          if (captions !== null) seen = { ...planFromCaptions(captions), via: 'the screen reader (this build has no lab hook)' }
        }
      }
      await shot('plan.png')
      if (lab !== null) report('lab-report.txt')
      if (seen === null) checks = [notRun('the app starts and the plan screen lists routes', 'the screen could not be read (is the phone locked?)')]
      else {
        say(`read through ${seen.via}`)
        checks = [checkPlanShowsRoutes(seen)]
      }
    } else if (scenario === 'watch-screen') {
      say(`watching the screen for ${options.seconds} s: open RouteIQ from its icon now, wait as you would, and tap Start drive with a finger`)
      const began = Date.now()
      const samples = []
      let n = 0
      while (Date.now() - began < options.seconds * 1000) {
        const sec = (Date.now() - began) / 1000
        samples.push({ sec, look: await shot(`watch-${String(++n).padStart(3, '0')}-${sec.toFixed(1)}s.png`) })
      }
      writeFileSync(path.join(dir, 'watched.json'), JSON.stringify(samples.map((s) => ({ sec: Math.round(s.sec * 10) / 10, flat: s.look?.flat ?? null, shade: s.look?.shade ?? null, rgb: s.look?.rgb ?? null })), null, 1))
      files.push('watched.json')
      const flatRuns = flatStretches(samples)
      const where = flatRuns.map((r) => `${r.from.toFixed(1)} to ${r.to.toFixed(1)} s`).join(', ')
      say(flatRuns.length === 0 ? 'no flat (undrawn) stretch of 2 s or more' : `flat stretches: ${where}`)
      checks = [{ name: 'no flat (undrawn) screen for 2 s or more while watched', pass: flatRuns.length === 0, detail: flatRuns.length === 0 ? `${samples.length} screenshots over ${options.seconds} s` : `flat from ${where} (look at the screenshots: a flat screen can also be the wallpaper or the launch screen)` }]
    } else if (scenario === 'drive-screen') {
      const name = driveScreenScenario(options)
      const stopSyslog = phone.startSyslog()
      cleanups.push(() => stopSyslog())
      if (options.cold) {
        // #136: the lab's launch kills the app while it is in front and starts it again at once.
        // Cold: the app goes to the background first and is left there before the launch.
        await phone.launch(BACKGROUND_APP)
        say('cold start: app sent to the background, waiting 15 s before launching it')
        await pause(15_000)
      }
      if ((await phone.launch(bundle, { args: labArgs(name) })) === null) throw new Error('the app did not start')
      say(`app started in lab mode (${name}${options.native.length > 0 ? `, native switches ${options.native.join(',')}` : ''}): it switches the in-app test drive on and presses Start drive; the phone's position is not used`)
      // The app writes its report the moment it presses Start drive, so a pull once a second
      // finds the start within about a second. The drive's clock starts halfway between the
      // last pull that did not see it and the first that did.
      let lab = null
      let lastMiss = Date.now()
      for (let waited = 0; waited < 90_000 && !(lab !== null && lab.screen === 'drive'); waited += 1000) {
        await pause(1000)
        const before = Date.now()
        lab = report()
        if (lab === null || lab.screen !== 'drive') lastMiss = before
      }
      if (lab === null || lab.screen !== 'drive') {
        await shot('no-drive.png')
        checks = [notRun('the driving screen', lab === null ? 'this build has no lab hook' : `the drive did not start: screen ${lab.screen}, ${lab.routes} routes`)]
      } else {
        const began = (lastMiss + Date.now()) / 2
        say(`driving (Start drive pressed at ${lab.startPressedAt ?? '?'} on the phone's clock; seen by the PC within ${Math.round((Date.now() - lastMiss) / 100) / 10} s)`)
        // Screenshots one after another, each with its seconds since Start drive. With a --fix
        // the watch goes on past it (12 s) so that its effect is seen.
        const samples = []
        let n = 0
        while (Date.now() - began < DEFAULT_LAB_CHECKS.drawWatchSec * 1000) {
          const sec = (Date.now() - began) / 1000
          const look = await shot(`drive-${String(++n).padStart(2, '0')}-${sec.toFixed(1)}s.png`)
          samples.push({ sec, look })
          const seen = firstDrawn(samples)
          // Drawn and still drawn 8 s later, and past the fix when there is one: enough seen.
          if (seen.drawnSec !== null && !seen.blackAgain && sec - seen.drawnSec >= 8 && (options.fix === null || sec > 20)) break
        }
        const seen = firstDrawn(samples)
        say(seen.drawnSec === null ? `never drawn in ${Math.round(seen.watchedSec ?? 0)} s` : `first drawn ${seen.drawnSec.toFixed(1)} s after Start drive${seen.blackAgain ? ', then flat again' : ''}`)
        finalReport = report('lab-report.txt')
        const syslog = stopSyslog()
        writeFileSync(path.join(dir, 'syslog.txt'), syslog.join('\n'))
        files.push('syslog.txt')
        writeFileSync(path.join(dir, 'drawn.json'), JSON.stringify({ scenario: name, native: options.native, samples: samples.map((s) => ({ sec: Math.round(s.sec * 10) / 10, flat: s.look?.flat ?? null, shade: s.look?.shade ?? null, rgb: s.look?.rgb ?? null })), ...seen }, null, 1))
        files.push('drawn.json')
        if (options.native.includes('snapshot') && phone.pullFile(SNAPSHOT_IN_APP, path.join(dir, 'native-snapshot.png'))) files.push('native-snapshot.png')
        checks = [checkDrawnWithin(samples)]
      }
    } else {
      const soak = scenario === 'background-soak'
      const preset = soak ? 'uptown-to-southpark' : 'wrong-turn'
      const fromM = options.fromM ?? (soak ? 0 : 4400)
      const awaySec = soak ? Math.round(options.minutes * 60) : options.awaySec
      const waypoints = PRESETS[preset].waypoints
      const start = pathFrom(waypoints, fromM)[0]

      // Two ways to move the car. Over USB the phone's own location services report the replayed
      // position, which is the real thing but lasts only while the PC's connection does, and
      // putting the phone to sleep ends that connection. So with --lock (or --in-app) the app's
      // own test drive moves a made-up car instead, and the phone's GPS is not used at all.
      const inApp = options.inApp
      let labScenarioName
      if (inApp) {
        labScenarioName = 'testdrive'
        say('using the in-app test drive (wrong turn after 1 min): the car is made up by the app, the phone\'s position is not used or changed')
      } else {
        simulated = { from: clock(), to: '?', cleared: false }
        if (!(await phone.setLocation(start))) throw new Error('the simulated position could not be set')
        say(`simulated position: standing on the ${preset} drive, ${fromM} m in`)
        await pause(3000)
        // The scenario names the simulated start: the app starts the drive only when the phone
        // reports a position there, so a lab drive never runs on the phone's real position.
        const whole = (degrees) => `${degrees < 0 ? 'm' : ''}${Math.round(Math.abs(degrees) * 1e5)}`
        labScenarioName = `drive-at-${whole(start[0])}-${whole(start[1])}`
      }
      if ((await phone.launch(bundle, { args: labArgs(labScenarioName) })) === null) throw new Error('the app did not start')
      say(inApp ? 'app started in lab mode: it switches the test drive on and presses Start drive' : 'app started in lab mode: it presses Start drive once the routes are there and the phone is at the simulated start')
      let lab = null
      for (let waited = 0; waited < 150_000; waited += 5000) {
        await pause(5000)
        lab = report()
        if (lab === null && waited >= 25_000) break
        if (lab !== null && lab.screen === 'drive' && !['locating', 'planning'].includes(lab.status)) break
      }
      if (lab === null) {
        // A build from before the lab: nothing can press Start drive. Show what can be shown.
        say('the app wrote no lab report: this build has no lab hook, so no drive can be started without a tap')
        await phone.clearLocation()
        await shot('plan.png')
        await phone.launch(BACKGROUND_APP)
        say('app sent to the background')
        await pause(5000)
        await phone.launch(bundle, { keep: true })
        await pause(3000)
        await shot('back-in-front.png')
        checks = [notRun('drive diagnostics', 'this build has no lab hook: install a build with it (docs/phone-lab.md)')]
      } else if (lab.screen !== 'drive') {
        await phone.clearLocation()
        await shot('no-drive.png')
        report('lab-report.txt')
        checks = [notRun('drive diagnostics', `the drive did not start: screen ${lab.screen}, status ${lab.status}, ${lab.routes} routes`)]
      } else {
        say(`driving: status ${lab.status}`)
        await shot('drive-started.png')
        await pause(8000)
        const lookAtStart = await shot('drive-after-8s.png')
        const stopSyslog = phone.startSyslog()
        cleanups.push(() => stopSyslog())
        await sample()

        await phone.launch(BACKGROUND_APP)
        say('app sent to the background (Calculator in front)')
        if (options.lock) {
          await pause(2000)
          // Sleep ends the developer connection; a new one is made when it is time to wake the phone.
          await phone.disconnect()
          say(phone.sleepPhone() ? 'phone put to sleep (screen off); the PC is disconnected from it until the end of the time away' : 'the phone could not be put to sleep')
        }
        await pause(3000)

        let player = null
        if (inApp) say(`the app's made-up car drives for ${awaySec} s`)
        else if (options.gps) {
          // The car keeps driving until the app is back in front and the screenshot is taken:
          // a car that stops reads as "waiting for a position fix".
          player = phone.playTrack(buildTrack(waypoints, { speedMps: options.speed, intervalSec: 1, fromM, maxSec: awaySec + 120, holdSec: 0 }))
          cleanups.push(() => player.stop())
          say(`replaying the ${preset} drive at ${options.speed} m/s`)
        } else say(`NOT replaying the drive (--no-gps): the phone stands still for ${awaySec} s`)

        const every = soak ? 60 : 30
        for (let waited = 0; waited < awaySec; waited += every) {
          await pause(Math.min(every, awaySec - waited) * 1000)
          const now = report()
          const s = await sample()
          say(`away ${Math.min(waited + every, awaySec)} s: status ${now?.status ?? '?'}, fixes ${now?.diagnostics?.fixes.count ?? '?'}, ticks ${now?.diagnostics?.ticks.count ?? '?'}, requests ${now?.diagnostics?.requests.sent ?? '?'}, web code CPU ${s.webContent?.cpuPercent ?? '?'} %`)
        }
        // Time for a spoken line and a route answer that are still under way.
        await pause(15_000)
        const awayEnd = report('lab-report-away.txt')
        say(`end of the time away: app ${awayEnd?.diagnostics?.appState ?? '?'}`)

        if (options.lock) {
          phone = await connectPhone({ log: say })
          say('connected to the phone again')
        }
        await phone.launch(bundle, { keep: true })
        say(options.lock ? 'phone woken and app brought back to the front' : 'app brought back to the front')
        await pause(5000)
        const lookAfter = await shot('back-in-front.png')
        const captions = await phone.captions()
        if (captions !== null) {
          writeFileSync(path.join(dir, 'screen-text.txt'), captions.map(redact).join('\n'))
          files.push('screen-text.txt')
          say(captions.length === 0 ? 'the screen reader found nothing: the phone is locked' : `the screen reader found ${captions.length} elements`)
        }
        const last = report('lab-report.txt')
        if (player !== null) {
          player.stop()
          const played = await player.done
          say(`replay ended: the phone took ${played.sent} positions and refused ${played.refused}`)
          if (played.refused > played.sent / 10) throw new Error('the phone refused too many simulated positions for the run to mean anything')
        }
        const syslog = stopSyslog()
        writeFileSync(path.join(dir, 'syslog.txt'), syslog.join('\n'))
        files.push('syslog.txt')
        say(`system log: ${syslog.length} lines from the app`)
        // What happened while away is in both; the later one also has the return to the front.
        const final = last ?? awayEnd
        if (final?.diagnostics) {
          const text = readFileSync(path.join(dir, last !== null ? 'lab-report.txt' : 'lab-report-away.txt'), 'utf8')
          writeFileSync(path.join(dir, 'diagnostics.txt'), text.slice(text.indexOf('RouteIQ drive diagnostics')))
          files.push('diagnostics.txt')
        }
        finalReport = final
        checks = [
          checkScreenDrawn(lookAtStart, '8 s after the drive started'),
          ...(soak ? checkSoak(final, awaySec / 60) : checkLockedWrongTurn(final, awaySec)),
          checkScreenDrawn(lookAfter, 'after the app came back to the front'),
        ]
      }
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
    say(`stopped: ${redact(failure)}`)
  } finally {
    for (const cleanup of cleanups.reverse()) {
      try {
        cleanup()
      } catch {
        // Keep cleaning up.
      }
    }
    if (phone !== null) {
      // Out of lab mode first: a plain start ends the lab drive (and its use of the position) and
      // leaves the app in front as the owner knows it. Only then back to the real GPS.
      if (bundle !== null && scenario !== 'watch-screen') {
        const restarted = (await phone.launch(bundle)) !== null
        say(restarted ? 'app restarted without the lab' : 'the app could not be restarted')
        // #136: two plan screens were black right after this relaunch. Look at it, every time.
        if (restarted && scenario === 'drive-screen') {
          try {
            await sleep(8000)
            await shot('after-relaunch-8s.png')
          } catch {
            // Only a look.
          }
        }
      }
      const cleared = await phone.clearLocation()
      const again = await phone.disconnect({ clear: simulated !== null })
      if (simulated !== null) {
        simulated.cleared = cleared || again
        simulated.to = clock()
        say(simulated.cleared ? 'simulated position cleared: the phone is back on its real GPS' : 'CLEAR FAILED: run scripts\\phone\\sim-drive.ps1 -ClearOnly, or restart the phone')
      }
    }
    process.off('SIGINT', onSignal)
  }

  if (failure !== null && checks.length === 0) checks = [notRun('scenario', redact(failure))]
  const failed = checks.filter((c) => !c.pass && !c.notRun)
  const skipped = checks.filter((c) => c.notRun)
  const result = failed.length > 0 ? `FAILED (${failed.length} of ${checks.length} checks)` : skipped.length > 0 || failure !== null ? 'INCOMPLETE (a check could not be made)' : `passed (${checks.length} checks)`
  const optionText = [options.lock ? 'phone put to sleep' : 'app in the background, screen on', options.inApp ? 'in-app test drive (positions made up by the app)' : options.gps ? 'drive replayed as the phone\'s position over USB' : 'drive NOT replayed (--no-gps)', options.web ? 'web build pushed from the PC' : 'web build inside the app'].join('; ')
  const metrics = [...runMetrics(finalReport), ...nativeMetrics(finalReport?.native ?? null)]
  writeFileSync(path.join(dir, 'summary.md'), summaryMarkdown({ scenario, options: optionText, device, app, steps, checks, metrics, samples, simulated, files, result }))
  console.log('')
  for (const c of checks) console.log(`${c.notRun ? 'NOT RUN' : c.pass ? 'pass   ' : 'FAIL   '} ${c.name}: ${c.detail}`)
  if (metrics.length > 0) console.log(`\n${metrics.map(([what, value]) => `${what}: ${value}`).join('\n')}`)
  console.log(`\n${result}\nReport: ${path.join(dir, 'summary.md')}`)
  return failed.length > 0 ? 1 : skipped.length > 0 || failure !== null ? 2 : 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
