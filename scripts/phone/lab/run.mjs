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
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildTrack, pathFrom, toGpx } from '../make-gpx.mjs'
import { PRESETS } from '../presets.mjs'
import { checkLockedWrongTurn, checkPlanShowsRoutes, checkSoak, notRun, parseLabReport, planFromCaptions, redact } from './assertions.mjs'
import { BACKGROUND_APP, createPhone, sleep } from './phone.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

export const SCENARIOS = Object.freeze({
  'starts-and-plans': 'Starts the app and checks that the plan screen lists routes.',
  'locked-wrong-turn': 'Starts a drive, puts the app in the background (and the phone to sleep with --lock), replays a drive with a wrong turn, and checks what the app did meanwhile.',
  'background-soak': 'The same with a drive that stays on the route, for --minutes (default 10), with CPU and battery samples.',
})

export const USAGE = [
  'Usage: node scripts/phone/lab/run.mjs --scenario <name> [options]',
  ...Object.entries(SCENARIOS).map(([name, about]) => `  ${name.padEnd(18)} ${about}`),
  'Options:',
  '  --lock           also put the phone to sleep while the app is in the background',
  '  --no-gps         do not replay the drive (the phone stands still): the off-route check must then fail',
  '  --away-sec <n>   locked-wrong-turn: seconds in the background (default 170)',
  '  --minutes <n>    background-soak: minutes in the background (default 10)',
  '  --from-m <n>     skip this much of the preset drive (default 4400 for locked-wrong-turn, 0 for the soak)',
  '  --speed <m/s>    driving speed of the replay (default 13)',
  '  --push-web       build the web app (native/shell) and copy it into the app first; the app then runs that build',
  '  --web            run the web build that was pushed earlier instead of the one in the app',
  '  --out <dir>      where reports go (default phone-lab/)',
].join('\n')

export function parseArgs(argv) {
  const options = { scenario: null, lock: false, gps: true, awaySec: 170, minutes: 10, fromM: null, speed: 13, pushWeb: false, web: false, out: path.join(repo, 'phone-lab') }
  const numbers = { '--away-sec': 'awaySec', '--minutes': 'minutes', '--from-m': 'fromM', '--speed': 'speed' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--lock') options.lock = true
    else if (arg === '--no-gps') options.gps = false
    else if (arg === '--push-web') options.pushWeb = options.web = true
    else if (arg === '--web') options.web = true
    else if (arg === '--scenario' || arg === '--out' || arg in numbers) {
      const value = argv[++i]
      if (value === undefined) return { error: `${arg} needs a value` }
      if (arg === '--scenario') options.scenario = value
      else if (arg === '--out') options.out = path.resolve(value)
      else {
        const n = Number(value)
        if (!Number.isFinite(n) || n < 0) return { error: `${arg} must be a number, 0 or more` }
        options[numbers[arg]] = n
      }
    } else return { error: `Unknown option ${arg}` }
  }
  if (options.scenario === null || !(options.scenario in SCENARIOS)) return { error: `Give --scenario: ${Object.keys(SCENARIOS).join(' | ')}` }
  if (options.speed < 1 || options.speed > 40) return { error: '--speed must be between 1 and 40 m/s' }
  return options
}

const two = (n) => String(n).padStart(2, '0')
const clock = (d = new Date()) => `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
const stamp = (d = new Date()) => `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`

export function summaryMarkdown({ scenario, options, device, app, steps, checks, samples, simulated, files, result }) {
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
  const say = (line) => {
    const text = `${clock()} ${line}`
    steps.push(text)
    console.log(text)
  }
  const phone = createPhone({ log: say })
  const shot = (name) => {
    const ok = phone.screenshot(path.join(dir, name))
    if (ok) files.push(name)
    say(ok ? `screenshot ${name}` : `screenshot ${name} could not be taken`)
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
  const sample = () => {
    const s = { at: clock(), ...phone.processSample(), battery: phone.battery() }
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
  const labArgs = (name) => ['-routeiqLab', name, ...(options.web ? ['-routeiqLabWeb'] : [])]

  let failure = null
  try {
    device = phone.describe()
    bundle = phone.bundleId()
    app = `RouteIQ ${phone.appVersion()}`
    say(`found ${device.model}, iOS ${device.ios}, ${app}`)

    if (options.pushWeb) {
      say('building the web app for the shell (native/shell)')
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
      const built = spawnSync(npm, ['run', 'build'], { cwd: path.join(repo, 'native', 'shell'), stdio: 'ignore', shell: process.platform === 'win32', env: { ...process.env, VITE_MAPBOX_TOKEN: '' } })
      if (built.status !== 0) throw new Error('the web build failed (npm run build in native/shell)')
      if (!phone.pushWeb(path.join(repo, 'native', 'shell', 'www'))) throw new Error('the web build could not be copied into the app')
      say('web build copied into the app')
    }

    phone.removeReport()

    if (scenario === 'starts-and-plans') {
      phone.launch(bundle, { args: labArgs('plan') })
      say('app started')
      let seen = null
      let lab = null
      for (let waited = 0; waited < 45_000 && (seen === null || seen.routes === 0); waited += 5000) {
        await pause(5000)
        lab = report()
        if (lab !== null) seen = { routes: lab.routes, startDrive: lab.screen === 'plan', via: 'the lab report' }
        else if (waited >= 10_000) {
          const captions = phone.captions()
          if (captions !== null) seen = { ...planFromCaptions(captions), via: 'the screen reader (this build has no lab hook)' }
        }
      }
      shot('plan.png')
      if (lab !== null) report('lab-report.txt')
      if (seen === null) checks = [notRun('the app starts and the plan screen lists routes', 'the screen could not be read (is the phone locked?)')]
      else {
        say(`read through ${seen.via}`)
        checks = [checkPlanShowsRoutes(seen)]
      }
    } else {
      const soak = scenario === 'background-soak'
      const preset = soak ? 'uptown-to-southpark' : 'wrong-turn'
      const fromM = options.fromM ?? (soak ? 0 : 4400)
      const awaySec = soak ? Math.round(options.minutes * 60) : options.awaySec
      const waypoints = PRESETS[preset].waypoints
      const start = pathFrom(waypoints, fromM)[0]

      simulated = { from: clock(), to: '?', cleared: false }
      phone.clearLocation()
      let stopHold = phone.holdLocation(start)
      cleanups.push(() => stopHold())
      say(`simulated position: standing on the ${preset} drive, ${fromM} m in`)
      await pause(4000)

      phone.launch(bundle, { args: labArgs('drive') })
      say('app started in lab mode: it presses Start drive once the routes are there')
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
        shot('plan.png')
        phone.launch(BACKGROUND_APP)
        say('app sent to the background')
        await pause(5000)
        phone.launch(bundle, { keep: true })
        await pause(3000)
        shot('back-in-front.png')
        checks = [notRun('drive diagnostics', 'this build has no lab hook: install a build with it (docs/phone-lab.md)')]
      } else if (lab.screen !== 'drive') {
        shot('no-drive.png')
        report('lab-report.txt')
        checks = [notRun('drive diagnostics', `the drive did not start: screen ${lab.screen}, status ${lab.status}, ${lab.routes} routes`)]
      } else {
        say(`driving: status ${lab.status}`)
        shot('drive-started.png')
        const stopSyslog = phone.startSyslog()
        cleanups.push(() => stopSyslog())
        say(`sample ${JSON.stringify(sample())}`)

        phone.launch(BACKGROUND_APP)
        say('app sent to the background (Calculator in front)')
        if (options.lock) {
          await pause(2000)
          say(phone.sleepPhone() ? 'phone put to sleep' : 'the phone could not be put to sleep')
        }
        await pause(3000)

        let player = null
        if (options.gps) {
          const gpx = path.join(tmpdir(), `routeiq-lab-${process.pid}.gpx`)
          writeFileSync(gpx, toGpx(buildTrack(waypoints, { speedMps: options.speed, fromM, maxSec: awaySec, holdSec: 0 }), { name: `RouteIQ lab ${preset}` }))
          cleanups.push(() => rmSync(gpx, { force: true }))
          stopHold()
          player = phone.playLocation(gpx)
          cleanups.push(() => player.stop())
          say(`replaying the ${preset} drive at ${options.speed} m/s for ${awaySec} s`)
        } else say(`NOT replaying the drive (--no-gps): the phone stands still for ${awaySec} s`)

        const every = soak ? 60 : 30
        for (let waited = 0; waited < awaySec; waited += every) {
          await pause(Math.min(every, awaySec - waited) * 1000)
          const now = report()
          const s = sample()
          say(`away ${Math.min(waited + every, awaySec)} s: status ${now?.status ?? '?'}, fixes ${now?.diagnostics?.fixes.count ?? '?'}, ticks ${now?.diagnostics?.ticks.count ?? '?'}, requests ${now?.diagnostics?.requests.sent ?? '?'}, web code CPU ${s.webContent?.cpuPercent ?? '?'} %`)
        }
        // Time for a spoken line and a route answer that are still under way.
        await pause(15_000)
        const awayEnd = report('lab-report-away.txt')
        say(`end of the time away: app ${awayEnd?.diagnostics?.appState ?? '?'}`)

        phone.launch(bundle, { keep: true })
        say('app brought back to the front')
        await pause(5000)
        shot('back-in-front.png')
        const captions = phone.captions()
        if (captions !== null) {
          writeFileSync(path.join(dir, 'screen-text.txt'), captions.map(redact).join('\n'))
          files.push('screen-text.txt')
          say(captions.length === 0 ? 'the screen reader found nothing: the phone is locked' : `the screen reader found ${captions.length} elements`)
        }
        const last = report('lab-report.txt')
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
        checks = soak ? checkSoak(final, awaySec / 60) : checkLockedWrongTurn(final)
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
    if (simulated !== null) {
      simulated.cleared = phone.clearLocation()
      simulated.to = clock()
      say(simulated.cleared ? 'simulated position cleared: the phone is back on its real GPS' : 'CLEAR FAILED: run scripts\\phone\\sim-drive.ps1 -ClearOnly, or restart the phone')
    }
    if (bundle !== null) {
      // Out of lab mode: a plain start ends the lab drive and leaves the app in front as the owner knows it.
      phone.launch(bundle)
      say('app restarted without the lab')
    }
    process.off('SIGINT', onSignal)
  }

  if (failure !== null && checks.length === 0) checks = [notRun('scenario', redact(failure))]
  const failed = checks.filter((c) => !c.pass && !c.notRun)
  const skipped = checks.filter((c) => c.notRun)
  const result = failed.length > 0 ? `FAILED (${failed.length} of ${checks.length} checks)` : skipped.length > 0 || failure !== null ? 'INCOMPLETE (a check could not be made)' : `passed (${checks.length} checks)`
  const optionText = [options.lock ? 'phone put to sleep' : 'app in the background, screen on', options.gps ? 'drive replayed' : 'drive NOT replayed (--no-gps)', options.web ? 'web build pushed from the PC' : 'web build inside the app'].join('; ')
  writeFileSync(path.join(dir, 'summary.md'), summaryMarkdown({ scenario, options: optionText, device, app, steps, checks, samples, simulated, files, result }))
  console.log('')
  for (const c of checks) console.log(`${c.notRun ? 'NOT RUN' : c.pass ? 'pass   ' : 'FAIL   '} ${c.name}: ${c.detail}`)
  console.log(`\n${result}\nReport: ${path.join(dir, 'summary.md')}`)
  return failed.length > 0 ? 1 : skipped.length > 0 || failure !== null ? 2 : 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
