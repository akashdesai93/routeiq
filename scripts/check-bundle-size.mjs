#!/usr/bin/env node
// Bundle size (#170). The rules and what is measured: scripts/bundle-size.mjs.
//
//   npm run build && npm run size                       fails when a measure is above the owner's
//                                                       ceiling in scripts/bundle-budget.json (CI does this)
//   npm run size -- --against <base>/dist               also reports what this build adds to another one
//                                                       (CI: the main the pull request was tested on)
//
// The ceiling is the owner's number: there is no --update any more. The growth limit is not
// enforced here but by the Gate's `required` job (scripts/orch/gates.mjs), so the `size-ok`
// label can pass it without running the build again. In GitHub Actions this script writes
//   - the step output `growth` (JSON, with --against) for that job, and
//   - a `bundle-size` notice with the sizes and the ceiling, which the fleet board reads from
//     main's Gate run for its headroom alert (scripts/orch/github.mjs).
import { appendFileSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MEASURES, budgetProblems, ceilingRows, growthReport, headroomReport, mapboxNamesIn, measureAssets, measuredSizes, total } from './bundle-size.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const budgetFile = join(root, 'scripts', 'bundle-budget.json')
const kB = (bytes) => `${(bytes / 1000).toFixed(1)} kB`
const signedKB = (bytes) => `${bytes >= 0 ? '+' : '−'}${(Math.abs(bytes) / 1000).toFixed(1)} kB`
const fail = (message) => {
  console.error(process.env.GITHUB_ACTIONS ? `::error title=Bundle size::${message}` : message)
  process.exit(1)
}

if (process.argv.includes('--update')) {
  fail('There is no --update: the ceiling in scripts/bundle-budget.json is the owner\'s number (#170). Make the build smaller, or ask for a higher ceiling on an issue with `needs-human`.')
}
const againstAt = process.argv.indexOf('--against')
const againstDir = againstAt >= 0 ? process.argv[againstAt + 1] : null
if (againstAt >= 0 && !againstDir) fail('--against needs the dist folder of the build to compare with.')

const budget = JSON.parse(readFileSync(budgetFile, 'utf8'))
const problems = budgetProblems(budget)
if (problems.length) fail(problems.join(' '))

let files, baseFiles
try {
  const mapboxNames = mapboxNamesIn(join(root, 'node_modules', 'mapbox-gl', 'dist', 'esm'))
  files = measureAssets(join(root, 'dist', 'assets'), mapboxNames)
  baseFiles = againstDir === null ? null : measureAssets(join(resolve(againstDir), 'assets'), mapboxNames)
} catch (e) {
  fail(e.message)
}

const sizes = measuredSizes(files)
const rows = ceilingRows(sizes, budget)
const growth = baseFiles === null ? null : growthReport(measuredSizes(baseFiles), sizes, budget)

const lines = [
  '### Bundle size',
  '',
  `| | size | gzip | ceiling | used${growth ? ' | this PR adds | limit |' : ' |'}`,
  `| --- | ---: | ---: | ---: | ---:${growth ? ' | ---: | ---: |' : ' |'}`,
  ...rows.map((r) => {
    const g = growth?.[r.key]
    const added = g ? ` | ${g.pr - g.base > g.limit ? '⚠️ ' : ''}${signedKB(g.pr - g.base)} | ${kB(g.limit)} |` : ' |'
    return `| ${r.over ? '❌' : '✅'} ${r.label} | ${kB(r.size)} | ${kB(total(files, r.key, 'gzip'))} | ${kB(r.ceiling)} | ${(r.used * 100).toFixed(1)} %${added}`
  }),
  `| Mapbox GL JS (not budgeted) | ${kB(total(files, 'mapbox'))} | ${kB(total(files, 'mapbox', 'gzip'))} | | |${growth ? ' | |' : ''}`,
  '',
  ...(growth
    ? ['A growth over the limit fails the Gate\'s `required` job unless the PR has the label `size-ok` (the reviewer adds it, with a reason in the verdict).', '']
    : []),
  '<details><summary>Files</summary>',
  '',
  '| file | counted as | up front | size | gzip |',
  '| --- | --- | :---: | ---: | ---: |',
  ...files.toSorted((a, b) => b.size - a.size).map((f) => `| \`${f.name}\` | ${f.kind} | ${f.upFront ? 'yes' : ''} | ${kB(f.size)} | ${kB(f.gzip)} |`),
  '',
  '</details>',
  '',
]
console.log(lines.join('\n'))

if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`)
if (process.env.GITHUB_ACTIONS) console.log(`::notice title=bundle-size::${JSON.stringify(headroomReport(sizes, budget))}`)
if (growth && process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `growth=${JSON.stringify(growth)}\n`)
if (growth) console.log(`growth=${JSON.stringify(growth)}`)

const over = rows.filter((r) => r.over)
for (const r of over) {
  const message = `${r.label} is ${kB(r.size)} (${r.size} bytes), over the ceiling of ${kB(r.ceiling)} (${r.ceiling} bytes).`
  console.error(process.env.GITHUB_ACTIONS ? `::error title=Bundle size::${message}` : message)
}
if (over.length > 0) {
  console.error(`Make it smaller. The ceiling is the owner's (${Object.keys(MEASURES).join(', ')} in scripts/bundle-budget.json): a pull request does not raise it.`)
  process.exit(1)
}
