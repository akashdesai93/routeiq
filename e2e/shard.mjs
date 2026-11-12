// Runs one CI shard of the e2e scenarios: `node e2e/shard.mjs <index> <total> [playwright args...]`,
// index from 1. Every scenario runs in exactly one shard.
//
// Why not Playwright's own `--shard`: it splits the list into contiguous blocks, and the long
// scenarios sit next to each other (in drive.spec.ts, shell.spec.ts and at the end of
// sidestreets.spec.ts), so one shard would get most of them. The scenarios are CPU-bound,
// and the ones that drive a trip take 20-45 s on a CI runner against 1-6 s for the rest. So
// each scenario is weighted by its seconds on CI (e2e/durations.json), and the heaviest are
// dealt first, each to the shard with the least weight so far (ties: the lower shard). The
// deal depends only on the scenario list and that file, so every shard computes the same one.
//
// A scenario not in durations.json yet gets a guess: GUESS_DRIVE_SEC when its body drives a
// trip (`app.drive(` or a tap on Start drive), else GUESS_SHORT_SEC, and the shard says so.
// The guess only moves the balance, never which scenarios run. To refresh the file, take the
// seconds from a Gate run's e2e-report (each card shows them) or the shards' logs.
//
// The shard checks itself before it runs: the scenarios Playwright selects for its locations
// must be exactly the ones it was dealt. A location that matched another scenario too, or
// nothing, fails the shard instead of running a scenario twice or never.
//
// Run with `npm run e2e:build` first. Locally `npm run e2e` still runs everything at once.

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

/** Seconds on CI for a scenario not in durations.json yet. */
const GUESS_DRIVE_SEC = 30
const GUESS_SHORT_SEC = 3

const [indexArg, totalArg, ...rest] = process.argv.slice(2)
const index = Number(indexArg)
const total = Number(totalArg)
if (!Number.isInteger(total) || total < 1 || !Number.isInteger(index) || index < 1 || index > total) {
  console.error('usage: node e2e/shard.mjs <index from 1> <total> [playwright args...]')
  process.exit(2)
}

/** The scenarios Playwright would run for these arguments: `e2e/file.spec.ts:line › title`, in order. */
function list(args) {
  const result = spawnSync(`npx playwright test --list --reporter=json ${args.join(' ')}`, {
    shell: true,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  if (result.status !== 0) {
    console.error(result.stdout)
    console.error(`playwright --list failed with status ${result.status}`)
    process.exit(1)
  }
  const report = JSON.parse(result.stdout)
  if ((report.errors ?? []).length > 0) {
    console.error(JSON.stringify(report.errors, null, 2))
    process.exit(1)
  }
  const out = []
  const walk = (suite, titles) => {
    for (const spec of suite.specs ?? []) {
      const file = relative(process.cwd(), resolve(report.config.rootDir, spec.file)).replaceAll('\\', '/')
      const name = `${file} › ${[...titles, spec.title].join(' › ')}`
      for (const t of spec.tests) out.push({ location: `${file}:${spec.line}`, name, id: `${file}:${spec.line} › ${t.projectName ? `${t.projectName} › ` : ''}${spec.title}` })
    }
    for (const child of suite.suites ?? []) walk(child, [...titles, child.title])
  }
  // The top-level suites are the files; the ones inside are `test.describe` blocks.
  for (const suite of report.suites ?? []) walk(suite, [])
  return out
}

const all = list([])
if (all.length === 0) {
  console.error('no scenarios found')
  process.exit(1)
}
// One location can hold several scenarios (a test in a loop): they stay together.
const locations = [...new Set(all.map((t) => t.location))]

const durations = JSON.parse(readFileSync('e2e/durations.json', 'utf8'))
const guessed = []

/** Seconds on CI for each location (the sum when one location holds several scenarios). */
function weights() {
  const sources = new Map()
  const out = new Map()
  for (const t of all) {
    let sec = durations[t.name]
    if (typeof sec !== 'number') {
      const [file, line] = t.location.split(':')
      if (!sources.has(file)) sources.set(file, readFileSync(file, 'utf8').split('\n'))
      const lines = sources.get(file)
      // The body: from the test's line up to the next line that starts another test.
      let end = Number(line)
      while (end < lines.length && !/^\s*test(\.\w+)?\(/.test(lines[end])) end++
      const body = lines.slice(Number(line) - 1, end).join('\n')
      sec = /\.drive\(|name: 'Start drive'/.test(body) ? GUESS_DRIVE_SEC : GUESS_SHORT_SEC
      guessed.push(`${t.name} (guessed ${sec} s)`)
    }
    out.set(t.location, (out.get(t.location) ?? 0) + sec)
  }
  return out
}

const weight = weights()
const load = Array.from({ length: total }, () => 0)
const dealt = Array.from({ length: total }, () => [])
const heaviestFirst = locations.map((loc, i) => ({ loc, i, w: weight.get(loc) })).sort((a, b) => b.w - a.w || a.i - b.i)
for (const { loc, w } of heaviestFirst) {
  const to = load.indexOf(Math.min(...load))
  load[to] += w
  dealt[to].push(loc)
}
const mine = dealt[index - 1]
console.log(`CI seconds per shard (run two at a time): ${load.map((l) => l.toFixed(0)).join(', ')}`)
if (guessed.length > 0) console.log(`not in e2e/durations.json yet, so guessed:\n  ${guessed.join('\n  ')}`)
if (mine.length === 0) {
  console.error(`shard ${index} of ${total} got no scenarios: there are only ${locations.length} locations. Use fewer shards.`)
  process.exit(1)
}

const expected = all.filter((t) => mine.includes(t.location)).map((t) => t.id)
const selected = list(mine).map((t) => t.id)
const sorted = (a) => [...a].sort().join('\n')
if (sorted(expected) !== sorted(selected)) {
  console.error(`shard ${index}: the locations select other scenarios than the ones dealt to it`)
  console.error(`dealt:\n${sorted(expected)}\n\nselected:\n${sorted(selected)}`)
  process.exit(1)
}

console.log(`shard ${index} of ${total}: ${expected.length} of ${all.length} scenarios`)
for (const id of expected) console.log(`  ${id}`)
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs')
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### e2e shard ${index} of ${total}: ${expected.length} of ${all.length} scenarios\n\n${expected.map((id) => `- ${id}`).join('\n')}\n`,
  )
}

const run = spawnSync(`npx playwright test ${[...rest, ...mine].join(' ')}`, { shell: true, stdio: 'inherit' })
process.exit(run.status ?? 1)
