#!/usr/bin/env node
// Bundle-size budget. Reads the production build in dist/assets and fails when the app's
// own JavaScript, the CSS, or what the page loads before its first paint has grown past
// the budget in scripts/bundle-budget.json.
//
//   npm run build && npm run size          check (CI does this)
//   npm run size -- --update               after a deliberate growth: record the new
//                                          sizes and set each budget to size + 10 %
//
// "The app's own JavaScript" is every .js file in dist/assets except Mapbox GL JS: the
// mapbox-gl-*.js chunk (split out in vite.config.ts) and the files Mapbox loads on demand
// (its worker, the HD and Standard style code, ...), which are recognised by the names of
// the files in node_modules/mapbox-gl/dist/esm. React is counted as the app's own.
// Sizes are bytes on disk, minified and not compressed, so the same build always measures
// the same; the gzip size is shown for information.
import { existsSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const assetsDir = join(root, 'dist', 'assets')
const budgetFile = join(root, 'scripts', 'bundle-budget.json')
const mapboxEsmDir = join(root, 'node_modules', 'mapbox-gl', 'dist', 'esm')
/** Room to grow before the check fails. */
const HEADROOM = 0.1

if (!existsSync(assetsDir)) {
  console.error('dist/assets is missing. Run `npm run build` first.')
  process.exit(1)
}

// Mapbox's own file names, without ".js". The three it loads up front (mapbox-gl, core,
// shared) are in the mapbox-gl chunk, so only that chunk's name is matched for them: an
// app chunk that happens to be called "core" or "shared" still counts as the app's.
const mapboxNames = new Set(
  readdirSync(mapboxEsmDir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => name.slice(0, -'.js'.length))
    .filter((name) => name !== 'core' && name !== 'shared'),
)
/** "hd.main-DaqRWeDh.js" -> "hd.main" (Vite adds "-<hash>" to every file). */
const baseName = (file) => file.replace(/-[A-Za-z0-9_-]{8}\.(js|css)$/, '')

const files = readdirSync(assetsDir).map((name) => {
  const bytes = readFileSync(join(assetsDir, name))
  const kind = name.endsWith('.css')
    ? 'css'
    : !name.endsWith('.js')
      ? 'other'
      : mapboxNames.has(baseName(name))
        ? 'mapbox'
        : 'appJs'
  return { name, kind, size: bytes.length, gzip: gzipSync(bytes).length }
})
const total = (kind, field = 'size') => files.filter((f) => f.kind === kind).reduce((sum, f) => sum + f[field], 0)

// Without the split there is no way to tell the app's code from Mapbox's.
if (!files.some((f) => f.kind === 'mapbox' && baseName(f.name) === 'mapbox-gl')) {
  console.error('No mapbox-gl-*.js chunk in dist/assets: the split in vite.config.ts is gone, so the app’s own size cannot be measured.')
  process.exit(1)
}

// What the page loads before its first paint: the files dist/index.html names (its module
// script, modulepreloads and stylesheets). Mapbox GL JS is loaded later
// (src/map/LazyMapView.tsx), so a static import that pulls it back in shows up here.
const html = readFileSync(join(root, 'dist', 'index.html'), 'utf8')
const upFront = new Set([...html.matchAll(/(?:src|href)="[^"]*\/assets\/([^"/]+\.(?:js|css))"/g)].map((m) => m[1]))
for (const f of files) f.upFront = upFront.has(f.name)
const totalUpFront = (ext, field = 'size') =>
  files.filter((f) => f.upFront && f.name.endsWith(ext)).reduce((sum, f) => sum + f[field], 0)
if (!files.some((f) => f.upFront && f.name.endsWith('.js'))) {
  console.error('dist/index.html names no script in dist/assets: is this the built app?')
  process.exit(1)
}

const measured = { appJs: total('appJs'), css: total('css'), entryJs: totalUpFront('.js'), entryCss: totalUpFront('.css') }
const gzipOf = { appJs: total('appJs', 'gzip'), css: total('css', 'gzip'), entryJs: totalUpFront('.js', 'gzip'), entryCss: totalUpFront('.css', 'gzip') }
const labels = {
  appJs: 'App JavaScript (without Mapbox GL JS)',
  css: 'CSS',
  entryJs: 'JavaScript loaded before first paint',
  entryCss: 'CSS loaded before first paint',
}
const kB = (bytes) => `${(bytes / 1000).toFixed(1)} kB`

if (process.argv.includes('--update')) {
  const budget = {
    note: 'Bundle-size budget for scripts/check-bundle-size.mjs, in bytes (minified, not compressed). Each budget is the measured size + 10 %. Update with `npm run build && npm run size -- --update` and say why in the pull request.',
    ...Object.fromEntries(
      Object.entries(measured).map(([key, size]) => [key, { measured: size, budget: Math.ceil(size * (1 + HEADROOM)) }]),
    ),
  }
  writeFileSync(budgetFile, `${JSON.stringify(budget, null, 2)}\n`)
  console.log(`Wrote ${budgetFile}`)
}

const budget = JSON.parse(readFileSync(budgetFile, 'utf8'))
const rows = Object.keys(measured).map((key) => {
  const limit = budget[key]?.budget
  if (!Number.isFinite(limit)) {
    console.error(`scripts/bundle-budget.json has no numeric "${key}.budget".`)
    process.exit(1)
  }
  return { key, label: labels[key], size: measured[key], gzip: gzipOf[key], limit, over: measured[key] > limit }
})

const lines = [
  '### Bundle size',
  '',
  '| | size | gzip | budget | used |',
  '| --- | ---: | ---: | ---: | ---: |',
  ...rows.map(
    (r) =>
      `| ${r.over ? '❌' : '✅'} ${r.label} | ${kB(r.size)} | ${kB(r.gzip)} | ${kB(r.limit)} | ${((r.size / r.limit) * 100).toFixed(1)} % |`,
  ),
  `| Mapbox GL JS (not budgeted) | ${kB(total('mapbox'))} | ${kB(total('mapbox', 'gzip'))} | | |`,
  '',
  '<details><summary>Files</summary>',
  '',
  '| file | counted as | up front | size | gzip |',
  '| --- | --- | :---: | ---: | ---: |',
  ...files
    .toSorted((a, b) => b.size - a.size)
    .map((f) => `| \`${f.name}\` | ${f.kind} | ${f.upFront ? 'yes' : ''} | ${kB(f.size)} | ${kB(f.gzip)} |`),
  '',
  '</details>',
  '',
]
console.log(lines.join('\n'))
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`)

const over = rows.filter((r) => r.over)
for (const r of over) {
  const message = `${r.label} is ${kB(r.size)} (${r.size} bytes), over its budget of ${kB(r.limit)} (${r.limit} bytes).`
  console.error(process.env.GITHUB_ACTIONS ? `::error title=Bundle size::${message}` : message)
}
if (over.length > 0) {
  console.error('Make it smaller, or, if the growth is wanted, run `npm run build && npm run size -- --update` and say why in the pull request.')
  process.exit(1)
}
