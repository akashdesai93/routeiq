#!/usr/bin/env node
// Runs a queue of builds through the phone lab and writes ONE report: for each build, install
// it over the app (Sideloadly, install-ipa.ps1), run its scenarios, and keep the numbers. At
// the end the best verified build is put back: the last one whose runs all passed, or the
// rollback build. docs/phone-lab.md, "The rule for every build that goes on the phone".
//
//   node scripts/phone/lab/queue.mjs plan.json [--wait-unlocked <hours>]
//
// plan.json:
//   {
//     "rollback": "C:/Users/me/dev/routeiq-builds/known-good-123/RouteIQ-unsigned.ipa",
//     "builds": [
//       { "name": "main + lab", "ipa": "C:/.../RouteIQ-unsigned.ipa",
//         "runs": [["--scenario", "starts-and-plans"], ["--scenario", "drive-screen"]] }
//     ]
//   }
// A build without "ipa" is run on whatever is installed. A build with "keep": false is never
// left on the phone, whatever it scored (a throwaway build made only to be measured).
//
// --wait-unlocked: first wait, up to that many hours, for the phone to be unlocked. It only
// reads one value every 10 minutes; it presses nothing and starts nothing on a locked phone.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findPmd3, sleep } from './phone.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..', '..')

/** The default runs of a build: does it start, is the driving screen drawn, does a drive go on in the background. */
export const DEFAULT_RUNS = Object.freeze([
  ['--scenario', 'starts-and-plans'],
  ['--scenario', 'drive-screen'],
  ['--scenario', 'locked-wrong-turn', '--in-app'],
])
export const UNLOCK_POLL_MS = 10 * 60_000
/** After the phone is seen unlocked, wait this long and look again: someone who has just picked it up is using it. */
export const UNLOCK_SETTLE_MS = 2 * 60_000

/** Reads a plan and says what is wrong with it. `exists`: is there a file at this path. */
export function readPlan(text, exists = existsSync) {
  let plan
  try {
    plan = JSON.parse(text)
  } catch {
    return { error: 'the plan is not JSON' }
  }
  if (typeof plan?.rollback !== 'string' || !exists(plan.rollback)) return { error: 'the plan needs "rollback": the path of an .ipa that exists (the build to fall back to)' }
  if (!Array.isArray(plan.builds) || plan.builds.length === 0) return { error: 'the plan needs "builds": a list with at least one build' }
  const builds = []
  for (const b of plan.builds) {
    if (typeof b?.name !== 'string' || b.name === '') return { error: 'every build needs a "name"' }
    if (b.ipa !== undefined && (typeof b.ipa !== 'string' || !exists(b.ipa))) return { error: `build "${b.name}": no file at its "ipa"` }
    const runs = b.runs ?? DEFAULT_RUNS
    if (!Array.isArray(runs) || runs.length === 0 || !runs.every((r) => Array.isArray(r) && r.every((a) => typeof a === 'string'))) return { error: `build "${b.name}": "runs" must be a list of argument lists` }
    if (runs.some((r) => r.includes('--lock'))) return { error: `build "${b.name}": --lock ends a session and cannot be part of a queue` }
    builds.push({ name: b.name, ipa: b.ipa ?? null, runs, keep: b.keep !== false })
  }
  return { rollback: plan.rollback, builds }
}

/**
 * Which build stays on the phone: the last one that may be kept, was installed from an ipa and
 * passed every run. Null: the rollback build.
 */
export function bestVerified(results) {
  const good = results.filter((r) => r.keep && r.ipa !== null && r.installed && r.runs.length > 0 && r.runs.every((run) => run.code === 0))
  return good.length === 0 ? null : good[good.length - 1]
}

export function queueReport({ startedAt, endedAt, results, left, note }) {
  const word = (code) => (code === 0 ? 'passed' : code === 1 ? 'FAILED' : 'INCOMPLETE')
  return [
    '# Phone lab queue',
    '',
    `From ${startedAt} to ${endedAt}.${note ? ` ${note}` : ''}`,
    '',
    `**Left on the phone:** ${left}`,
    '',
    '| Build | Installed | Runs |',
    '| --- | --- | --- |',
    ...results.map((r) => `| ${r.name} | ${r.ipa === null ? 'as found' : r.installed ? 'yes' : `NO: ${r.installNote}`} | ${r.runs.map((run) => `${run.label}: ${word(run.code)}`).join('; ') || 'none'} |`),
    '',
    ...results.flatMap((r) => [`## ${r.name}`, '', ...r.runs.flatMap((run) => [`### ${run.label}: ${word(run.code)}`, '', run.summary.replace(/^# .*\n/, '').trim(), ''])]),
  ].join('\n')
}

const two = (n) => String(n).padStart(2, '0')
const clock = (d = new Date()) => `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`

/** True when the phone says it is locked with a passcode right now; null when it cannot be asked. Reads one value. */
function isLocked(pmd3) {
  const r = spawnSync(pmd3, ['lockdown', 'info'], { encoding: 'utf8', timeout: 60_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  const m = (r.stdout ?? '').match(/"PasswordProtected":\s*(true|false)/)
  return m === null ? null : m[1] === 'true'
}

function install(ipa) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'install-ipa.ps1'), '-Ipa', ipa, '-TimeoutSec', '900'], { encoding: 'utf8', timeout: 960_000, windowsHide: true })
  const last = (r.stdout ?? '').trim().split(/\r?\n/).at(-1) ?? ''
  return { ok: r.status === 0, note: r.status === 0 ? '' : last.slice(0, 160) || `install-ipa.ps1 ended with ${r.status}` }
}

function runScenario(args, out) {
  const r = spawnSync(process.execPath, [path.join(here, 'run.mjs'), ...args, '--out', out], { encoding: 'utf8', timeout: 30 * 60_000, windowsHide: true })
  const file = (r.stdout ?? '').match(/^Report: (.+)$/m)?.[1]?.trim()
  const summary = file !== undefined && existsSync(file) ? readFileSync(file, 'utf8') : `No summary was written.\n\n${(r.stdout ?? '').trim().split(/\r?\n/).slice(-6).join('\n')}`
  return { code: r.status ?? 2, summary }
}

async function main(argv) {
  const planFile = argv.find((a) => !a.startsWith('--'))
  const waitAt = argv.indexOf('--wait-unlocked')
  const waitHours = waitAt === -1 ? 0 : Number(argv[waitAt + 1])
  if (planFile === undefined || !existsSync(planFile) || !(waitHours >= 0)) {
    console.error('Usage: node scripts/phone/lab/queue.mjs plan.json [--wait-unlocked <hours>]')
    return 64
  }
  const plan = readPlan(readFileSync(planFile, 'utf8'))
  if ('error' in plan) {
    console.error(plan.error)
    return 64
  }
  const { pmd3 } = findPmd3()
  const startedAt = clock()
  const out = path.join(repo, 'phone-lab', `queue-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}`)
  mkdirSync(out, { recursive: true })
  const finish = (results, left, note) => {
    writeFileSync(path.join(out, 'report.md'), queueReport({ startedAt, endedAt: clock(), results, left, note }))
    console.log(`\nReport: ${path.join(out, 'report.md')}`)
  }

  if (isLocked(pmd3) !== false) {
    const deadline = Date.now() + waitHours * 3_600_000
    console.log(`${clock()} the phone is locked (or cannot be asked). ${waitHours > 0 ? `Looking again every 10 minutes for ${waitHours} h.` : 'Nothing was run.'}`)
    let open = false
    while (Date.now() < deadline && !open) {
      await sleep(Math.min(UNLOCK_POLL_MS, Math.max(1000, deadline - Date.now())))
      if (isLocked(pmd3) === false) {
        // Someone has just unlocked it and may be using it: give them two minutes, then look again.
        console.log(`${clock()} unlocked; looking once more in 2 minutes before starting`)
        await sleep(UNLOCK_SETTLE_MS)
        open = isLocked(pmd3) === false
      }
    }
    if (!open) {
      finish([], 'unchanged: the phone stayed locked and nothing was installed or run', 'The phone was locked the whole time.')
      return 2
    }
  }

  const results = []
  for (const build of plan.builds) {
    const result = { name: build.name, ipa: build.ipa, keep: build.keep, installed: build.ipa === null, installNote: '', runs: [] }
    results.push(result)
    console.log(`${clock()} == ${build.name}`)
    if (build.ipa !== null) {
      const done = install(build.ipa)
      result.installed = done.ok
      result.installNote = done.note
      console.log(`${clock()} install: ${done.ok ? 'done' : done.note}`)
      if (!done.ok) continue
    }
    for (const args of build.runs) {
      const label = args.filter((a) => a !== '--scenario').join(' ')
      const run = runScenario(args, out)
      result.runs.push({ label, ...run })
      console.log(`${clock()} ${label}: ${run.code === 0 ? 'passed' : run.code === 1 ? 'FAILED' : 'incomplete'}`)
      // A build that does not start is not worth a drive.
      if (args.includes('starts-and-plans') && run.code !== 0) break
    }
  }

  // Always end on a build that works: the best verified one, or the rollback.
  const best = bestVerified(results)
  const last = results.filter((r) => r.ipa !== null && r.installed).at(-1) ?? null
  let left
  if (best !== null && best === last) left = `${best.name} (it passed every run and was the last installed)`
  else {
    const target = best ?? { name: 'the rollback build', ipa: plan.rollback }
    const done = install(target.ipa)
    const check = done.ok ? runScenario(['--scenario', 'starts-and-plans'], out) : { code: 2, summary: '' }
    left = done.ok && check.code === 0 ? `${target.name}, installed again at the end; it starts and lists routes` : `UNCERTAIN: putting ${target.name} back ${done.ok ? 'worked but it did not show its routes' : `failed (${done.note})`}. Install ${plan.rollback} by hand.`
    console.log(`${clock()} ${left}`)
  }
  finish(results, left, '')
  return results.every((r) => r.installed && r.runs.every((run) => run.code === 0)) ? 0 : 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
