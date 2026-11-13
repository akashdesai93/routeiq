// The controls guard (#203): every control the app shows must be tapped by some scenario.
//
//   node e2e/controls-guard.mjs [--untested <file>] [results dir...]
//   (default: e2e-report/results, and e2e/controls-untested.json)
//
// Each scenario writes controls.json into its output folder (e2e/harness.ts): the controls
// that were on screen during it (`seen`) and the ones a trusted click, tap or typing reached
// (`activated`, e2e/controls.ts). This joins every scenario's file (one run, or the files of
// every CI shard put together) and fails when a control was seen in some scenario but
// activated in none, unless e2e/controls-untested.json lists it with the reason. It also
// fails when that list names a control that is now tapped (or no longer exists), so the
// list only ever shrinks.
//
// It writes e2e-report/controls.md: each control, where it was seen, and which scenario
// tapped it.
//
// Run it on a whole run only: one scenario on its own leaves most controls untapped.

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
let allowedFile = resolve(import.meta.dirname, 'controls-untested.json')
const at = args.indexOf('--untested')
if (at >= 0) allowedFile = resolve(args.splice(at, 2)[1])
const dirs = args
if (dirs.length === 0) dirs.push('e2e-report/results')

/** Every controls.json under `dir`. */
function files(dir) {
  const out = []
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...files(path))
    else if (entry === 'controls.json') out.push(path)
  }
  return out
}

const found = dirs.flatMap(files)
if (found.length === 0) {
  console.error(`controls guard: no controls.json under ${dirs.join(', ')}. Run the e2e scenarios first.`)
  process.exit(2)
}

/** control -> { seenIn: Set<scenario>, tappedBy: Set<scenario> } */
const controls = new Map()
const entry = (key) => {
  if (!controls.has(key)) controls.set(key, { seenIn: new Set(), tappedBy: new Set() })
  return controls.get(key)
}
for (const path of found) {
  const run = JSON.parse(readFileSync(path, 'utf8'))
  const scenario = run.project ? `[${run.project}] ${run.title}` : run.title
  for (const key of run.seen) entry(key).seenIn.add(scenario)
  for (const key of run.activated) entry(key).tappedBy.add(scenario)
}

/** { "<control key>": "why no scenario taps it yet" } */
const allowed = JSON.parse(readFileSync(allowedFile, 'utf8')).untested ?? {}

const keys = [...controls.keys()].sort()
const tapped = keys.filter((k) => controls.get(k).tappedBy.size > 0)
const untapped = keys.filter((k) => controls.get(k).tappedBy.size === 0)
const missing = untapped.filter((k) => !(k in allowed))
const stale = Object.keys(allowed).filter((k) => !untapped.includes(k))

const cell = (text) => text.replaceAll('|', '\\|')
const lines = [
  '# Controls and the scenarios that tap them',
  '',
  `${keys.length} controls on screen across ${found.length} scenario runs; ${tapped.length} tapped by a scenario, ${untapped.length} not (${untapped.length - missing.length} of those listed in e2e/controls-untested.json).`,
  '',
  '| control | tapped by | seen in |',
  '| --- | --- | --- |',
  ...keys.map((k) => {
    const c = controls.get(k)
    const by = [...c.tappedBy]
    return `| ${cell(k)} | ${by.length === 0 ? (k in allowed ? `**no** (listed: ${cell(allowed[k])})` : '**no**') : cell(by[0]) + (by.length > 1 ? ` (+${by.length - 1})` : '')} | ${c.seenIn.size} |`
  }),
]
mkdirSync('e2e-report', { recursive: true })
writeFileSync('e2e-report/controls.md', lines.join('\n') + '\n')

console.log(`controls guard: ${keys.length} controls on screen, ${tapped.length} tapped by a scenario, ${untapped.length} not (report: e2e-report/controls.md)`)
for (const k of missing) console.error(`  not tapped by any scenario: ${k}\n    seen in: ${[...controls.get(k).seenIn][0]}`)
for (const k of stale) console.error(`  listed as untested in e2e/controls-untested.json, but ${controls.has(k) ? 'a scenario taps it now' : 'no scenario shows it any more'}: ${k}`)
if (missing.length > 0) console.error(`${missing.length} control(s) on screen that no scenario taps. Add a scenario that taps each one and checks what the driver then sees or hears.`)
if (stale.length > 0) console.error(`${stale.length} line(s) of e2e/controls-untested.json to remove.`)
process.exit(missing.length > 0 || stale.length > 0 ? 1 : 0)
