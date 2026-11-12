// The driver of the simulator drive: it launches the app in a booted iOS
// Simulator, feeds it a GPS drive along the route the stub server answers
// with, takes a wrong turn, follows the new route, and collects the evidence.
//
//   node sim/drive.mjs --udid <device> --out build/sim-drive [--gps start|set] [--port 8521]
//
// The simulated car: on Main Corridor from the start of the trip, a right
// turn off it after WRONG_TURN_AT_M, straight on until the app has a new
// route, then along that route. The app decides everything it says and shows;
// this script only moves the GPS, presses Start drive and End (through the
// page script, sim/page.js) and takes pictures.
//
// Evidence in the output folder: video.mp4, numbered screenshots, the app's
// Drive diagnostics text, the spoken lines, every report of the page
// (reports.jsonl), the route requests the stub answered (directions.json),
// summary.md and result.json. Exit status 0 when the three checks hold
// (see `judge`), 1 when one does not, 2 when the run could not be made.
import { execFile, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { along, sideStep } from '../../../e2e/world/roads.ts'
import { readDiagnostics } from './page.js'
import { startStub, TRIP } from './stub.mjs'

export const BUNDLE_ID = 'dev.routeiq.shell'
export const OFF_ROUTE_LINE = 'You are off the route. Finding a new one.'
const NEW_ROUTE_LINE = /^New route\./

/** How the drive goes. Speeds in meters per second, distances in meters, waits in seconds. */
export const DEFAULT_DRIVE = {
  speedMps: 30,
  wrongTurnAtM: 1500,
  wrongTurnSpeedMps: 10,
  wrongTurnLengthM: 900,
  /** On the new route before the lock test. */
  afterNewRouteSec: 30,
  lockedSec: 20,
  /** The pass/fail check wants more fixes than this. */
  minFixes: 40,
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const M_PER_DEG = 111_195
const distM = (a, b) => Math.hypot((a[0] - b[0]) * M_PER_DEG * Math.cos((a[1] * Math.PI) / 180), (a[1] - b[1]) * M_PER_DEG)
const lengthM = (points) => points.slice(1).reduce((sum, p, i) => sum + distM(points[i], p), 0)

/** Where the simulated car is: a line it follows at a speed, from a moment on. */
export class Car {
  constructor(at, now = Date.now) {
    this.now = now
    this.points = [at, at]
    this.speedMps = 0
    this.sinceMs = now()
  }
  follow(points, speedMps) {
    this.points = points
    this.speedMps = speedMps
    this.sinceMs = this.now()
  }
  drivenM() {
    return Math.min(lengthM(this.points), (this.speedMps * (this.now() - this.sinceMs)) / 1000)
  }
  position() {
    const driven = this.drivenM()
    return driven <= 0 ? this.points[0] : along(this.points, driven).point
  }
  done() {
    return this.drivenM() >= lengthM(this.points) - 0.5
  }
}

/** The first `meters` of a line, ending exactly there. */
export function firstM(points, meters) {
  const out = [points[0]]
  let left = meters
  for (let i = 1; i < points.length; i++) {
    const d = distM(points[i - 1], points[i])
    if (d >= left) {
      out.push(along([points[i - 1], points[i]], left).point)
      return out
    }
    out.push(points[i])
    left -= d
  }
  return out
}

/**
 * The three checks of a run, from the app's own Drive diagnostics text, the
 * spoken lines and the stub's request log.
 */
export function judge({ diagnostics, spoken, directions, minFixes = DEFAULT_DRIVE.minFixes }) {
  const numbers = readDiagnostics(diagnostics)
  const offAt = spoken.indexOf(OFF_ROUTE_LINE)
  const newAt = spoken.findIndex((line, i) => i > offAt && NEW_ROUTE_LINE.test(line))
  const offRouteRequests = directions.filter((d) => d.kind === 'off-route').length
  const checks = [
    {
      name: `more than ${minFixes} GPS fixes reached the app`,
      pass: numbers !== null && numbers.fixes > minFixes,
      detail: numbers === null ? 'no Drive diagnostics text was read' : `${numbers.fixes} fixes, longest gap ${numbers.fixGapSec} s`,
    },
    {
      name: 'at least one route request was answered',
      pass: numbers !== null && numbers.answered >= 1,
      detail: numbers === null ? 'no Drive diagnostics text was read' : `${numbers.sent} sent, ${numbers.answered} answered, ${numbers.failed} failed`,
    },
    {
      name: 'off the route, then a new route',
      pass: offAt !== -1 && newAt !== -1 && offRouteRequests >= 1,
      detail:
        `spoken "${OFF_ROUTE_LINE}": ${offAt === -1 ? 'no' : 'yes'}; then "New route…": ${newAt === -1 ? 'no' : `yes ("${spoken[newAt]}")`}; ` +
        `route requests from off every road: ${offRouteRequests}`,
    },
  ]
  return { pass: checks.every((c) => c.pass), checks, numbers }
}

/**
 * Runs the drive. `device` does what only a simulator can (see simctlDevice);
 * tests pass a stand-in.
 */
export async function runDrive({ device, stub, outDir, gps = 'start', drive = DEFAULT_DRIVE, log = console.log }) {
  mkdirSync(outDir, { recursive: true })
  const started = Date.now()
  const notes = []
  const shots = []
  const say = (text) => {
    log(`[${String(Math.round((Date.now() - started) / 1000)).padStart(4)} s] ${text}`)
  }
  const note = (text) => {
    notes.push(text)
    say(text)
  }
  const latest = () => stub.latest()
  const ui = () => latest()?.ui ?? {}
  const spoken = () => latest()?.spoken ?? []
  let shotNumber = 0
  const shot = async (name, what) => {
    const file = `${String(++shotNumber).padStart(2, '0')}-${name}.png`
    const ok = await device.screenshot(path.join(outDir, file))
    const seen = ui()
    shots.push({ file: ok ? file : null, what, screen: seen.screen ?? 'unknown', turn: seen.turn ?? '', banner: seen.banner ?? '', status: seen.status ?? '' })
    say(`screenshot ${file}${ok ? '' : ' FAILED'}: ${what}`)
  }
  /** Waits until `test()` is truthy. Returns its value, or null after `sec` seconds. */
  const until = async (sec, test) => {
    const end = Date.now() + sec * 1000
    for (;;) {
      const value = test()
      if (value) return value
      if (Date.now() >= end) return null
      await sleep(250)
    }
  }

  // The GPS. 'start': the simulator moves along the line by itself at the speed
  // (simctl location start). 'set': this script sets the position once a second.
  const car = new Car(TRIP.origin)
  let mode = gps
  const follow = async (points, speedMps, what) => {
    car.follow(points, speedMps)
    say(`GPS: ${what} (${Math.round(lengthM(points))} m at ${speedMps} m/s, ${mode})`)
    if (mode === 'start' && !(await device.startRoute(points, speedMps))) {
      mode = 'set'
      note('`simctl location start` was refused; the position is set once a second instead (fixes then carry no speed or heading).')
    }
  }
  let setting = false
  const ticker = setInterval(() => {
    if (mode !== 'set' || setting) return
    setting = true
    device.setLocation(car.position()).finally(() => {
      setting = false
    })
  }, 1000)

  const result = { completed: false, stoppedAt: null, gps: null, lock: null, diagnostics: null }
  const stopVideo = await device.startVideo(path.join(outDir, 'video.mp4'))
  try {
    await device.grantLocation()
    await device.setLocation(TRIP.origin)
    await device.launch()
    say('app launched')

    // 1. The app talks to the stub, and opens on the trip (not on the token screen).
    if (!(await until(120, latest))) {
      await shot('no-contact', 'the page script never reached the stub server')
      throw new Error('The app never reported to the stub server.')
    }
    say(`the app reports through ${latest().transport}${latest().nativeProblem ? ` (native HTTP said: ${latest().nativeProblem})` : ''}`)
    if (!latest().plugin) note('The page has no native plugin: this is not the shell.')
    const planned = await until(90, () => ui().screen === 'plan' && ui().recommended && !ui().counting && ui().startEnabled)
    await sleep(3000)
    await shot('plan', 'the trip before Start drive: the route list on the made-up roads')
    if (!planned) throw new Error(`The trip was never planned (screen: ${ui().screen}; alert: ${ui().alert || 'none'}).`)
    if (!ui().mapCanvas) note(`The map did not start (${ui().alert || 'no message'}).`)

    // 2. Start drive, pressed by the page script.
    const pressed = await stub.send('click', { selector: '.start-drive-button' })
    // On a busy runner the page's report loop can stall for several seconds, so the
    // click's answer may come late: what the screen shows decides, not the answer.
    if (!pressed.ok && pressed.value !== 'no answer') throw new Error(`Start drive could not be pressed: ${pressed.value}`)
    if (!pressed.ok) note('Start drive: the page did not confirm the click in time; waiting for the drive view instead.')
    if (!(await until(45, () => ui().screen === 'drive'))) throw new Error(`The drive view did not open (screen: ${ui().screen}; click: ${pressed.value ?? 'ok'}).`)
    const routeA = stub.world.cornersOf('A')
    const toTurn = firstM(routeA, drive.wrongTurnAtM)
    await follow(toTurn, drive.speedMps, 'along Main Corridor')
    await until(25, () => (latest()?.counts.fixes ?? 0) >= 3 && ui().turn !== '' && !/Finding/.test(ui().turn))
    await sleep(Math.min(15, (drive.wrongTurnAtM / drive.speedMps) * 0.4) * 1000)
    await shot('driving', 'driving on the first route: the turn card, the arrival time and the status line')
    await until(drive.wrongTurnAtM / drive.speedMps + 10, () => car.done())

    // 3. The wrong turn: right, square to the road, and straight on.
    const turnAt = toTurn.at(-1)
    const heading = along(routeA, drive.wrongTurnAtM).headingDeg
    const astray = [turnAt, sideStep(turnAt, heading + 180, drive.wrongTurnLengthM)]
    const requestsBefore = stub.directions.length
    await follow(astray, drive.wrongTurnSpeedMps, 'a right turn off the route')
    const wrongTurnSec = drive.wrongTurnLengthM / drive.wrongTurnSpeedMps
    const noticed = await until(wrongTurnSec, () => spoken().includes(OFF_ROUTE_LINE) || /Off the route/.test(ui().turn) || /New route/.test(ui().banner))
    await shot('after-wrong-turn', noticed ? 'just after the app noticed the wrong turn' : 'after the wrong turn (the app has not said anything about it)')
    const rerouted = await until(Math.max(10, wrongTurnSec - car.drivenM() / drive.wrongTurnSpeedMps), () =>
      /New route/.test(ui().banner) || spoken().some((line) => NEW_ROUTE_LINE.test(line)),
    )
    await sleep(1500)
    await shot('new-route', rerouted ? 'the new route after the wrong turn' : 'no new route was announced')

    // 4. The driver follows the new route: what the stub answered the off-route request with.
    const answer = stub.directions.slice(requestsBefore).findLast((d) => d.kind === 'off-route')
    if (answer?.corners) {
      await follow([car.position(), ...answer.corners.slice(1)], drive.speedMps, 'along the new route')
    } else {
      note('The stub never got a route request from off the route, so the car has no new route to follow.')
    }
    await sleep(drive.afterNewRouteSec * 1000)
    await shot('on-new-route', 'driving on the new route')

    // 5. The app's own Drive diagnostics, on the screen and as text.
    const mid = await stub.send('diagnostics', { keepOpen: true })
    await sleep(700)
    await shot('diagnostics-mid-drive', 'Drive diagnostics, opened over the drive')
    await stub.send('click', { selector: '.diagnostics-head button', text: 'Close' })
    if (mid.ok) result.diagnostics = mid.value

    // 6. Best effort: lock the simulator and see whether the drive goes on.
    result.lock = await lockTest({ device, stub, drive, until, shot, say, readText: (ms) => stub.send('diagnostics', {}, ms) })
    if (result.lock.diagnostics) result.diagnostics = result.lock.diagnostics

    // 7. End, and the diagnostics once more with the trip screen behind it.
    const last = await stub.send('diagnostics', {}, 20_000)
    if (last.ok) result.diagnostics = last.value
    const ended = await stub.send('click', { selector: '.live-end' }, 20_000)
    if (ended.ok) await until(10, () => ui().screen === 'plan')
    const shown = await stub.send('diagnostics', { keepOpen: true }, 20_000)
    if (shown.ok) result.diagnostics = shown.value
    await sleep(700)
    await shot('after-end', 'after End: the trip screen with Drive diagnostics open')
    result.completed = true
  } catch (e) {
    result.stoppedAt = e instanceof Error ? e.message : String(e)
    note(`The run stopped early: ${result.stoppedAt}`)
    await shot('stopped', 'where the run stopped').catch(() => {})
  } finally {
    clearInterval(ticker)
    await device.stopLocation().catch(() => {})
    await stopVideo().catch(() => {})
  }
  result.gps = mode

  // The evidence.
  // The page script counts its reports from 1 each time the page loads; a second
  // load means the web view reloaded the app (and lost whatever it was doing).
  const loads = stub.reports.filter((r) => r.seq === 1).length
  if (loads > 1) note(`The page loaded ${loads} times: the web view reloaded the app during the run.`)
  const final = latest()
  const lines = final?.spoken ?? []
  const directions = stub.directions.map(({ corners: _corners, ...rest }) => rest)
  const verdict = judge({ diagnostics: result.diagnostics, spoken: lines, directions, minFixes: drive.minFixes })
  writeFileSync(path.join(outDir, 'reports.jsonl'), stub.reports.map((r) => JSON.stringify(r)).join('\n') + '\n')
  writeFileSync(path.join(outDir, 'directions.json'), JSON.stringify(directions, null, 2))
  writeFileSync(path.join(outDir, 'spoken.txt'), lines.join('\n') + '\n')
  writeFileSync(path.join(outDir, 'diagnostics.txt'), (result.diagnostics ?? '(the Drive diagnostics text was never read)') + '\n')
  const summary = summarize({ verdict, result, shots, notes, final, lines, directions, unexpected: stub.unexpected, seconds: Math.round((Date.now() - started) / 1000) })
  writeFileSync(path.join(outDir, 'summary.md'), summary)
  writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ pass: verdict.pass && result.completed, verdict, result: { ...result, diagnostics: undefined }, shots, notes, counts: final?.counts ?? null }, null, 2))
  return { pass: verdict.pass && result.completed, verdict, result, summary }
}

/**
 * Locks the simulator for a while, with the GPS still moving, and says what
 * went on meanwhile. Never fails the run: what a simulator does when locked
 * says little about a phone.
 */
async function lockTest({ device, stub, drive, until, shot, say, readText }) {
  const out = { tried: false, how: null, sawNotActive: false, before: null, after: null, reportsWhileLocked: 0, diagnostics: null, unlocked: false, verdict: '' }
  const counts = () => ({ ...(stub.latest()?.counts ?? {}) })
  const before = (await readText(20_000)).value
  out.before = { counts: counts(), diagnostics: readDiagnostics(before) }
  const how = await device.lock()
  out.tried = true
  out.how = how
  if (how === null) {
    out.verdict = 'not tried: this runner offers no way to lock the simulator'
    say(`lock: ${out.verdict}`)
    return out
  }
  const lockedAt = Date.now()
  const reportsAt = stub.reports.length
  out.sawNotActive = (await until(8, () => stub.latest()?.appState !== 'active')) !== null
  await sleep(Math.max(0, drive.lockedSec * 1000 - (Date.now() - lockedAt)))
  await shot('locked', `${drive.lockedSec} s after the lock command (${how})`)
  out.reportsWhileLocked = stub.reports.length - reportsAt
  const text = await readText(20_000)
  if (text.ok) out.diagnostics = text.value
  out.after = { counts: counts(), diagnostics: readDiagnostics(text.ok ? text.value : null) }
  await device.unlock(() => stub.latest()?.appState === 'active' && stub.latest()?.ui.visibility === 'visible')
  out.unlocked = (await until(8, () => stub.latest()?.appState === 'active')) !== null
  await sleep(1500)
  await shot('after-unlock', out.unlocked ? 'unlocked again: the drive view' : 'after the unlock command (the app did not say it is active)')
  const ticks = (out.after.counts.ticks ?? 0) - (out.before.counts.ticks ?? 0)
  const fixes = (out.after.counts.fixes ?? 0) - (out.before.counts.fixes ?? 0)
  out.verdict = !out.sawNotActive
    ? `the lock command ran (${how}) but the app never left "active": nothing learned (${ticks} ticks, ${fixes} fixes in ${drive.lockedSec} s)`
    : `locked for ${drive.lockedSec} s: ${ticks} native ticks and ${fixes} fixes reached the page, and it sent ${out.reportsWhileLocked} reports meanwhile`
  say(`lock: ${out.verdict}`)
  return out
}

function summarize({ verdict, result, shots, notes, final, lines, directions, unexpected, seconds }) {
  const mark = (pass) => (pass ? 'pass' : 'FAIL')
  const out = []
  out.push(`## Simulator drive: ${verdict.pass && result.completed ? 'passed' : 'FAILED'}`, '')
  out.push(`The shell app in the iOS Simulator, driven along the made-up road network with a wrong turn. ${seconds} s, GPS mode \`${result.gps}\`, the page reached the stub through \`${final?.transport ?? 'nothing'}\`, map ${final?.mapOff === true ? 'off (WebGL switched off by the page script, so the app drives without a map)' : final?.mapStub === false ? 'from Mapbox (secret token)' : 'drawn from the made-up roads (no token)'}.`, '')
  if (!result.completed) out.push(`**The run stopped early:** ${result.stoppedAt}`, '')
  out.push('| Check | Result | What was seen |', '| --- | --- | --- |')
  for (const c of verdict.checks) out.push(`| ${c.name} | ${mark(c.pass)} | ${c.detail} |`)
  out.push(`| locked simulator (best effort, never fails the run) | ${result.lock === null ? 'not reached' : 'noted'} | ${result.lock?.verdict ?? ''} |`, '')
  out.push('### Screenshots', '', '| File | Moment | Turn card | Banner | Status line |', '| --- | --- | --- | --- | --- |')
  for (const s of shots) out.push(`| ${s.file ?? '(failed)'} | ${s.what} | ${s.turn} | ${s.banner} | ${s.status} |`)
  out.push('', '### Spoken lines (what the app handed to the voice)', '', ...(lines.length ? lines.map((l) => `- ${l}`) : ['- (none)']), '')
  out.push('### Route requests the stub answered', '', ...(directions.length ? directions.map((d) => `- ${d.n ?? '-'}: ${d.kind}, offered ${d.offered.join(', ') || 'nothing'}${d.where ? ` (from ${Math.round(d.where.share * 100)} % of the way, ${d.where.sideM} m to the side)` : ''}`) : ['- (none)']), '')
  if (final) out.push(`Page script counts: ${JSON.stringify(final.counts)}. App state at the end: ${final.appState}.`, '')
  if (final?.errors?.length) out.push('### Errors in the page', '', ...final.errors.map((e) => `- ${e}`), '')
  if (unexpected.length) out.push('### Requests the stub had no answer for', '', ...[...new Set(unexpected)].map((u) => `- ${u}`), '')
  if (notes.length) out.push('### Notes', '', ...notes.map((n) => `- ${n}`), '')
  out.push('### Drive diagnostics (the app\'s own text)', '', '```', result.diagnostics ?? '(never read)', '```', '')
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// The simulator, through `xcrun simctl`.

function run(command, args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: error === null, out: String(stdout), err: String(stderr).trim() || (error?.message ?? '') })
    })
  })
}

export function simctlDevice(udid, log = console.log) {
  const simctl = (...args) => run('xcrun', ['simctl', ...args])
  const pair = (p) => `${p[1].toFixed(6)},${p[0].toFixed(6)}`
  const osascript = (...lines) => run('osascript', lines.flatMap((line) => ['-e', line]), { timeoutMs: 20_000 })
  const menu = (item) =>
    osascript(
      'tell application "Simulator" to activate',
      'delay 1',
      `tell application "System Events" to tell process "Simulator" to click menu item "${item}" of menu "Device" of menu bar 1`,
    )
  return {
    async grantLocation() {
      for (const service of ['location', 'location-always']) {
        const r = await simctl('privacy', udid, 'grant', service, BUNDLE_ID)
        if (!r.ok) log(`simctl privacy grant ${service}: ${r.err}`)
      }
    },
    async launch() {
      const r = await simctl('launch', udid, BUNDLE_ID)
      if (!r.ok) throw new Error(`simctl launch failed: ${r.err}`)
    },
    async setLocation(p) {
      const r = await simctl('location', udid, 'set', pair(p))
      if (!r.ok) log(`simctl location set: ${r.err}`)
    },
    /** True when the simulator took the route. */
    async startRoute(points, speedMps) {
      // A new scenario replaces the one that is running.
      const r = await simctl('location', udid, 'start', `--speed=${speedMps}`, '--interval=1', ...points.map(pair))
      if (!r.ok) log(`simctl location start: ${r.err}`)
      return r.ok
    },
    async stopLocation() {
      await simctl('location', udid, 'clear')
    },
    async screenshot(file) {
      const r = await simctl('io', udid, 'screenshot', '--type=png', file)
      if (!r.ok) log(`simctl io screenshot: ${r.err}`)
      return r.ok
    },
    /** Starts recording the screen. The returned function stops it and waits for the file to be finished. */
    async startVideo(file) {
      const child = spawn('xcrun', ['simctl', 'io', udid, 'recordVideo', '--codec=h264', '--force', file], { stdio: ['ignore', 'inherit', 'inherit'] })
      const exited = new Promise((resolve) => child.once('exit', resolve))
      await sleep(2000)
      return async () => {
        child.kill('SIGINT')
        await Promise.race([exited, sleep(30_000)])
      }
    },
    /** How the simulator was locked, or null when it could not be. Needs Simulator.app open (the workflow opens it). */
    async lock() {
      const byMenu = await menu('Lock')
      if (byMenu.ok) return 'Simulator menu Device > Lock'
      log(`lock by menu: ${byMenu.err}`)
      const byKey = await osascript('tell application "Simulator" to activate', 'delay 1', 'tell application "System Events" to keystroke "l" using {command down}')
      if (byKey.ok) return 'Command-L in Simulator'
      log(`lock by key: ${byKey.err}`)
      return null
    },
    /** Home wakes a locked simulator and, pressed again, opens it. Stops as soon as `active()` says the app is in front. */
    async unlock(active) {
      for (let i = 0; i < 2 && !active(); i++) {
        await menu('Home')
        await sleep(2500)
      }
      if (!active()) await simctl('launch', udid, BUNDLE_ID)
    },
  }
}

// ---------------------------------------------------------------------------

async function main(argv) {
  const arg = (name, fallback) => {
    const at = argv.indexOf(`--${name}`)
    return at === -1 ? fallback : argv[at + 1]
  }
  const udid = arg('udid')
  const outDir = path.resolve(arg('out', 'build/sim-drive'))
  if (!udid) {
    console.error('usage: node sim/drive.mjs --udid <booted simulator> [--out <folder>] [--gps start|set] [--port 8521]')
    return 2
  }
  mkdirSync(outDir, { recursive: true })
  const stub = await startStub({ port: Number(arg('port', '8521')), log: (text) => console.log(`[stub] ${text}`) })
  try {
    const { pass, result, summary } = await runDrive({ device: simctlDevice(udid), stub, outDir, gps: arg('gps', 'start') === 'set' ? 'set' : 'start' })
    console.log(`\n${summary}`)
    return !result.completed ? 2 : pass ? 0 : 1
  } finally {
    await stub.close()
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}
