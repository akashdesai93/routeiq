// Runs one CI shard of the e2e scenarios: `node e2e/shard.mjs <index> <total> [playwright args...]`,
// index from 1. Every scenario runs in exactly one shard.
//
// Why not Playwright's own `--shard`: it splits the list into contiguous blocks, and the long
// scenarios (the drives, about 30-50 s each on a CI runner) sit next to each other in
// drive.spec.ts and at the end of sidestreets.spec.ts, so one shard would get most of them.
// Here the scenarios are dealt out in turn, like cards (the 1st to shard 1, the 2nd to shard 2,
// ...), which spreads the neighbours out.
//
// The shard checks itself before it runs: the scenarios Playwright selects for its locations
// must be exactly the ones it was dealt. A location that matched another scenario too, or
// nothing, fails the shard instead of running a scenario twice or never.
//
// Run with `npm run e2e:build` first. Locally `npm run e2e` still runs everything at once.

import { spawnSync } from 'node:child_process'
import { relative, resolve } from 'node:path'

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
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      const file = relative(process.cwd(), resolve(report.config.rootDir, spec.file)).replaceAll('\\', '/')
      for (const t of spec.tests) out.push({ location: `${file}:${spec.line}`, id: `${file}:${spec.line} › ${t.projectName} › ${spec.title}` })
    }
    for (const child of suite.suites ?? []) walk(child)
  }
  for (const suite of report.suites ?? []) walk(suite)
  return out
}

const all = list([])
if (all.length === 0) {
  console.error('no scenarios found')
  process.exit(1)
}
// One location can hold several scenarios (a test in a loop): they stay together.
const locations = [...new Set(all.map((t) => t.location))]
const mine = locations.filter((_, i) => i % total === index - 1)
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
