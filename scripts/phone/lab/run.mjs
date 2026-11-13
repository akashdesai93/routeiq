#!/usr/bin/env node
// The phone lab: runs a scenario on the real iPhone on the USB cable, with nobody touching it,
// and writes phone-lab/report-<time>/ (git-ignored): screenshots, the app's diagnostics, a
// system-log excerpt and summary.md. How it works and what each check proves: docs/phone-lab.md.
//
//   node scripts/phone/lab/run.mjs --scenario locked-wrong-turn
//
// While a drive scenario runs, the WHOLE PHONE reports the simulated position (Find My
// included). It is cleared at the end, on failure and on Ctrl+C.
import { quietHoursProblem } from './preflight.mjs'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildTrack, pathFrom } from '../make-gpx.mjs'
import { PRESETS } from '../presets.mjs'
import { checkDrawnWithin, checkLockedWrongTurn, checkPlanShowsRoutes, checkScreenDrawn, DEFAULT_LAB_CHECKS, firstDrawn, checkSoak, notRun, parseLabReport, planFromCaptions, redact, runMetrics } from './assertions.mjs'
import { BACKGROUND_APP, connectPhone, sleep } from './phone.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

export const SCENARIOS = Object.freeze({
  'starts-and-plans': 'Starts the app and checks that the plan screen lists routes.',
  'locked-wrong-turn': 'Starts a drive, puts the app in the background (and the phone to sleep with --lock), replays a drive with a wrong turn, and checks what the app did meanwhile.',
  'background-soak': 'The same with a drive that stays on the route, for --minutes (default 10), with CPU and battery samples.',
  'drive-screen': 'Starts the in-app test drive, leaves the app in front and takes screenshots one after another for 40 s: is the driving screen drawn within 2 s of Start drive and does it stay drawn? With --fix <name>, tries that on the page 12 s in.',
})

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
  '  --fix <name>     drive-screen: resize | reflow | layer | nomap | red | scroll (src/lab/probe.ts)',
  '  --push-web       build the web app (native/shell) and copy it into the app first; the app then runs that build',
  '  --web            run the web build that was pushed earlier instead of the one in the app',
  '  --out <dir>      where reports go (default phone-lab/)',
  '  --voice-ok       allow a scenario that speaks during quiet hours (22:00 to 07:00): the owner said so',
].join('\n')

export function parseArgs(argv) {
  const options = { scenario: null, fix: null, voiceOk: false, lock: false, ownerUnlocksAfter: false, inApp: false, gps: true, awaySec: 170, minutes: 10, fromM: null, speed: 13, pushWeb: false, web: false, out: path.join(repo, 'phone-lab') }
  const numbers = { '--away-sec': 'awaySec', '--minutes': 'minutes', '--from-m': 'fromM', '--speed': 'speed' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--lock') options.lock = options.inApp = true
    else if (arg === '--owner-unlocks-after') options.ownerUnlocksAfter = true
    else if (arg === '--voice-ok') options.voiceOk = true
    else if (arg === '--in-app') options.inApp = true
    else if (arg === '--no-gps') options.gps = false
    else if (arg === '--push-web') options.pushWeb = options.web = true
    else if (arg === '--web') options.web = true
    else if (arg === '--scenario' || arg === '--out' || arg === '--fix' || arg in numbers) {
      const value = argv[++i]
      if (value === undefined) return { error: `${arg} needs a value` }
      if (arg === '--scenario') options.scenario = value
      else if (arg === '--fix') options.fix = value
      else if (arg === '--out') options.out = path.resolve(value)
      else {
        const n = Number(value)
        if (!Number.isFinite(n) || n < 0) return { error: `${arg} must be a number, 0 or more` }
        options[numbers[arg]] = n
      }
    } else return { error: `Unknown option ${arg}` }
  }
  if (options.scenario === null || !(options.scenario in SCENARIOS)) return { error: `Give --scenario: ${Object.keys(SCENARIOS).join(' | ')}` }
  if (options.fix !== null && (options.scenario !== 'drive-screen' || !/^[a-z]{2,12}$/.test(options.fix))) return { error: '--fix <name> goes with --scenario drive-screen' }
  if (options.speed < 1 || options.speed > 40) return { error: '--speed must be between 1 and 40 m/s' }
  if (options.lock && !options.ownerUnlocksAfter) return { error: '--lock leaves the phone with its screen off, and nothing can be looked at after it until someone wakes the phone. Add --owner-unlocks-after to say that is understood, and make it the last run.' }
  if (options.inApp && !options.gps) return { error: '--no-gps goes with the USB position, not with --lock or --in-app' }
  if (options.inApp && options.scenario === 'background-soak') return { error: 'the soak replays its drive over USB: it cannot be combined with --lock or --in-app' }
  return options
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
  // Quiet hours (docs/phone-lab.md, "Preflight and hard rules"): a drive speaks out loud.
  const quiet = quietHoursProblem(new Date().getHours(), options.scenario, options.voiceOk)
  if (quiet !== null) {
    console.error(quiet)
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
  const labArgs = (name) => ['-routeiqLab', name, ...(options.web ? ['-routeiqLabWeb'] : [])]

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
    } else if (scenario === 'drive-screen') {
      const name = options.fix === null ? 'testdrive' : `testdrive-fix-${options.fix}`
      if ((await phone.launch(bundle, { args: labArgs(name) })) === null) throw new Error('the app did not start')
      say(`app started in lab mode (${name}): it switches the in-app test drive on and presses Start drive; the phone's position is not used`)
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
        // Screenshots one after another, each with its seconds since Start drive (#136: one run
        // drew by itself at 18 s, so fixed moments are not enough). With a --fix the watch goes
        // on past it (12 s) so that its effect is seen.
        const samples = []
        let n = 0
        while (Date.now() - began < DEFAULT_LAB_CHECKS.drawWatchSec * 1000) {
          const sec = (Date.now() - began) / 1000
          samples.push({ sec, look: await shot(`drive-${String(++n).padStart(2, '0')}-${sec.toFixed(1)}s.png`) })
          const seen = firstDrawn(samples)
          // Drawn from the limit on, for 8 s, and past the fix when there is one: enough seen.
          if (seen.drawnSec !== null && (seen.lastFlatSec === null || seen.lastFlatSec < DEFAULT_LAB_CHECKS.maxDrawnSec) && sec >= DEFAULT_LAB_CHECKS.maxDrawnSec + 8 && (options.fix === null || sec > 20)) break
        }
        const seen = firstDrawn(samples)
        say(seen.drawnSec === null ? `never drawn in ${Math.round(seen.watchedSec ?? 0)} s` : `first drawn ${seen.drawnSec.toFixed(1)} s after Start drive${seen.lastFlatSec !== null && seen.lastFlatSec > seen.drawnSec ? `, flat again until ${seen.lastFlatSec.toFixed(1)} s` : ''}`)
        writeFileSync(path.join(dir, 'drawn.json'), JSON.stringify({ samples: samples.map((s) => ({ sec: Math.round(s.sec * 10) / 10, flat: s.look?.flat ?? null, shade: s.look?.shade ?? null })), ...seen }, null, 1))
        files.push('drawn.json')
        finalReport = report('lab-report.txt')
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
      if (bundle !== null) say((await phone.launch(bundle)) !== null ? 'app restarted without the lab' : 'the app could not be restarted')
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
  const metrics = runMetrics(finalReport)
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
