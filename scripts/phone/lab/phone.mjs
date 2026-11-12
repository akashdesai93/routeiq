// The iPhone on the USB cable, as the phone lab uses it: pymobiledevice3 underneath
// (docs/phone-sim-location.md has the one-time setup). Nothing here prints the phone's
// identifiers, and nothing reads the app's stored data: the only file ever pulled from the
// app is the lab's own report.
//
// Two kinds of command:
// - Through device.py, one long-lived process with one connection: the simulated position,
//   starting apps, screenshots, CPU samples, reading the screen. They must share a connection:
//   the simulated position lasts only as long as the connection that set it.
// - As separate commands, which need no tunnel and so do not disturb that connection: the list
//   of apps, files in the app's folder, the battery, the system log, putting the phone to sleep.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { redact } from './assertions.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

/** Where the lab's files live inside the app (its temporary folder). Must match RouteIQLab.swift. */
export const REPORT_IN_APP = '/tmp/routeiq-lab-report.txt'
export const WEB_IN_APP = '/tmp/routeiq-lab-www'
/** A plain app with nothing personal on it, opened to put RouteIQ in the background. */
export const BACKGROUND_APP = 'com.apple.calculator'
/** The shell app's own process, and the process that runs its web code. */
export const APP_PROCESS = 'App'
export const WEB_PROCESS = 'com.apple.WebKit.WebContent'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function findPmd3() {
  const candidates = [process.env.ROUTEIQ_PMD3, path.join(homedir(), 'dev', 'tools', 'pmd3', 'Scripts', 'pymobiledevice3.exe'), path.join(homedir(), 'dev', 'tools', 'pmd3', 'bin', 'pymobiledevice3')]
  const found = candidates.find((c) => c && existsSync(c))
  if (!found) throw new Error('pymobiledevice3 was not found. Do the one-time setup in docs/phone-sim-location.md, or set ROUTEIQ_PMD3.')
  const dir = path.dirname(found)
  const python = [path.join(dir, 'python.exe'), path.join(dir, 'python')].find((c) => existsSync(c))
  if (!python) throw new Error(`No Python next to ${found}.`)
  return { pmd3: found, python }
}

/** Starts device.py and resolves once it is connected to the phone. */
async function startAgent(python, env) {
  const child = spawn(python, [path.join(here, 'device.py')], { env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  const waiting = new Map()
  let nextId = 1
  let ready
  let failed
  const isReady = new Promise((resolve, reject) => {
    ready = resolve
    failed = reject
  })
  createInterface({ input: child.stdout }).on('line', (line) => {
    let answer
    try {
      answer = JSON.parse(line)
    } catch {
      return
    }
    if (answer.ready === true) ready()
    else waiting.get(answer.id)?.(answer)
  })
  child.on('exit', () => {
    failed(new Error('could not connect to the phone for developer commands (is it unlocked, with Developer Mode on?)'))
    for (const resolve of waiting.values()) resolve({ ok: false, error: 'the connection to the phone ended' })
    waiting.clear()
  })
  const timer = setTimeout(() => failed(new Error('timed out connecting to the phone')), 60_000)
  try {
    await isReady
  } catch (error) {
    child.kill()
    throw error
  } finally {
    clearTimeout(timer)
  }
  return {
    /** Sends one command. Resolves with the answer; `ok` is false when it failed. Never rejects. */
    send(command, timeoutMs = 70_000) {
      if (child.exitCode !== null) return Promise.resolve({ ok: false, error: 'the connection to the phone ended' })
      const id = nextId++
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiting.delete(id)
          resolve({ ok: false, error: 'timed out' })
        }, timeoutMs)
        waiting.set(id, (answer) => {
          clearTimeout(timer)
          waiting.delete(id)
          resolve(answer)
        })
        child.stdin.write(`${JSON.stringify({ ...command, id })}\n`)
      })
    },
    async stop() {
      if (child.exitCode !== null) return
      child.stdin.write('{"cmd":"quit"}\n')
      await Promise.race([new Promise((resolve) => child.on('exit', resolve)), sleep(5000)])
      child.kill()
    },
  }
}

export async function connectPhone({ log = () => {} } = {}) {
  const { pmd3, python } = findPmd3()
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }

  /** Runs one pymobiledevice3 command to its end. Never throws; `ok` is false on a failure or a timeout. */
  const run = (args, { timeoutMs = 60_000 } = {}) => {
    const r = spawnSync(pmd3, args, { encoding: 'utf8', timeout: timeoutMs, env, windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
    return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '', timedOut: r.error?.code === 'ETIMEDOUT' }
  }
  /** The reason a command failed, safe to print. */
  const why = (r) => {
    const lines = r.stderr.split(/\r?\n/)
    const line = lines.filter((l) => / ERROR /.test(l)).at(-1) ?? lines.filter((l) => l.trim() !== '').at(-1) ?? ''
    return redact(line.replace(/^.*? ERROR /, '')).slice(0, 300) || (r.timedOut ? 'timed out' : 'failed')
  }

  const listed = run(['usbmux', 'list'])
  let devices = []
  try {
    devices = JSON.parse(listed.stdout)
  } catch {
    devices = []
  }
  const usb = devices.filter((d) => d.ConnectionType === 'USB')
  if (usb.length === 0) throw new Error('No iPhone found over USB. Plug it in, unlock it, and check docs/phone-sim-location.md (Troubleshooting).')
  const device = { model: usb[0].ProductType, ios: usb[0].ProductVersion }

  const apps = run(['apps', 'list', '-t', 'User'], { timeoutMs: 90_000 })
  const bundle = apps.stdout.match(/"CFBundleIdentifier":\s*"(dev\.routeiq\.shell[^"]*)"/)?.[1]
  if (bundle === undefined) throw new Error(`The RouteIQ app (dev.routeiq.shell…) is not installed on the phone${apps.ok ? '' : `: ${why(apps)}`}.`)

  const agent = await startAgent(python, env)
  let player = null

  const phone = {
    device,
    /** The installed RouteIQ shell's bundle id (Sideloadly adds a suffix to it). Not for printing. */
    bundle,

    /** Starts an app, or brings it to the front when `keep` is true and it is running. Returns the pid, or null. */
    async launch(bundleId, { args = [], keep = false } = {}) {
      const answer = await agent.send({ cmd: 'launch', bundle: bundleId, args, keep })
      if (!answer.ok) log(`launch failed: ${answer.error}`)
      return answer.ok ? answer.pid : null
    },

    /** A PNG of the screen. False when it could not be taken. */
    async screenshot(file) {
      const answer = await agent.send({ cmd: 'screenshot', file })
      return answer.ok && existsSync(file)
    },

    /** What a screen reader finds on the screen: one caption per element. Null when it could not be read; [] when the phone is locked. */
    async captions() {
      const answer = await agent.send({ cmd: 'captions' }, 120_000)
      return answer.ok ? answer.captions : null
    },

    /** One sample of the shell's process and of the process that runs its web code. CPU is a share of one core. */
    async processSample() {
      const answer = await agent.send({ cmd: 'processes', names: [APP_PROCESS, WEB_PROCESS] }, 30_000)
      const found = answer.ok ? answer.processes : {}
      return { app: found[APP_PROCESS] ?? null, webContent: found[WEB_PROCESS] ?? null }
    },

    /** Makes the whole phone report this position, until clearLocation(). False when it could not be set. */
    async setLocation([lng, lat]) {
      return (await agent.send({ cmd: 'location', lat, lng })).ok
    },

    /**
     * Replays a track, one position every `intervalSec`. `done` resolves with how many positions
     * the phone took and how many it refused, when the track ends or `stop()` is called. The
     * phone stays at the last position.
     */
    playTrack(track, intervalSec = 1) {
      let at = 0
      let stopped = false
      const counts = { sent: 0, refused: 0 }
      const done = (async () => {
        const began = Date.now()
        while (!stopped && at < track.length) {
          if (await phone.setLocation(track[at])) counts.sent++
          else counts.refused++
          at++
          // Keeps to the clock, whatever each command took.
          const wait = began + at * intervalSec * 1000 - Date.now()
          if (wait > 0) await sleep(wait)
        }
        return counts
      })()
      player = { done, stop: () => (stopped = true) }
      return player
    },

    /**
     * Back to the real GPS. Asked on the lab's own connection and then once more with a
     * separate command, so that it holds even when that connection is gone. False means the
     * phone may still be simulated.
     */
    async clearLocation() {
      player?.stop()
      const first = (await agent.send({ cmd: 'clear' })).ok
      return first || run(['developer', 'dvt', 'simulate-location', 'clear']).ok
    },

    /** Ends the connection. The simulated position ends with it; a last clear makes sure. */
    async disconnect({ clear = false } = {}) {
      player?.stop()
      await agent.stop()
      return clear ? run(['developer', 'dvt', 'simulate-location', 'clear']).ok : true
    },

    /** The installed app's version and build number, for the report. */
    appVersion() {
      const r = run(['apps', 'query', bundle])
      const version = r.stdout.match(/"CFBundleShortVersionString":\s*"([^"]+)"/)?.[1] ?? '?'
      const build = r.stdout.match(/"CFBundleVersion":\s*"([^"]+)"/)?.[1] ?? '?'
      return `${version} (${build})`
    },

    /** Puts the phone to sleep (the screen goes dark, as with the side button). */
    sleepPhone() {
      return run(['diagnostics', 'sleep']).ok
    },

    /** The lab's report file from the app, into `localFile`. False when there is none (a build without the lab, or not started in lab mode). */
    pullReport(localFile) {
      const r = run(['apps', 'pull', bundle, REPORT_IN_APP, localFile])
      return r.ok && existsSync(localFile)
    },

    /** Removes the last run's report, so that a new run cannot read an old one. */
    removeReport() {
      run(['apps', 'rm', bundle, REPORT_IN_APP])
    },

    /** Copies a built web app (native/shell/www) into the app, for `-routeiqLabWeb`. */
    pushWeb(wwwDir) {
      run(['apps', 'rm', bundle, WEB_IN_APP], { timeoutMs: 300_000 })
      const r = run(['apps', 'push', bundle, wwwDir, WEB_IN_APP], { timeoutMs: 900_000 })
      if (!r.ok) log(`push failed: ${why(r)}`)
      return r.ok
    },

    removeWeb() {
      return run(['apps', 'rm', bundle, WEB_IN_APP], { timeoutMs: 300_000 }).ok
    },

    /** Battery level, whether it is charging, and its temperature. */
    battery() {
      const r = run(['diagnostics', 'battery', 'single'], { timeoutMs: 30_000 })
      const value = (field) => {
        const m = r.stdout.match(new RegExp(`^\\s{4}"${field}":\\s*(-?\\d+|true|false)`, 'm'))
        return m === null ? null : m[1] === 'true' ? true : m[1] === 'false' ? false : Number(m[1])
      }
      const temperature = value('Temperature')
      return { percent: value('CurrentCapacity'), charging: value('IsCharging'), milliamps: value('InstantAmperage'), celsius: temperature === null ? null : temperature / 100 }
    },

    /** Collects the app's lines of the system log until the returned function is called; it returns them, redacted. */
    startSyslog() {
      const child = spawn(pmd3, ['syslog', 'live', '-pn', APP_PROCESS], { env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      const lines = []
      let rest = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        const parts = (rest + chunk).split(/\r?\n/)
        rest = parts.pop() ?? ''
        for (const line of parts) if (lines.length < 3000) lines.push(redact(line))
      })
      return () => {
        child.kill()
        return lines
      }
    },
  }
  return phone
}
