// The bundle-size rules (#170), shared by scripts/check-bundle-size.mjs and its tests.
//
// - A ceiling the owner sets, per measure, in scripts/bundle-budget.json (`ceiling`): a product
//   number (what the first screen may cost on a phone), not "measured + 10 %". Feature pull
//   requests never change it; the Gate holds a PR that edits the file (scripts/orch/gates.mjs).
// - A growth limit per pull request (`growthPerPr`): the size job also builds the main the PR
//   was tested on and reports what the PR adds. The Gate's `required` job fails a PR that grows
//   a measure by more than its limit unless it has the label `size-ok` (scripts/orch/gates.mjs).
// - A headroom alert (`alertAt`, a fraction of the ceiling): main's size job reports its sizes,
//   and the fleet board flags main above it (scripts/orch/derive.mjs).
//
// "The app's own JavaScript" is every .js file in dist/assets except Mapbox GL JS: the
// mapbox-gl-*.js chunk (split out in vite.config.ts) and the files Mapbox loads on demand
// (its worker, the HD and Standard style code, ...), which are recognised by the names of
// the files in node_modules/mapbox-gl/dist/esm. React is counted as the app's own.
// Sizes are bytes on disk, minified and not compressed, so the same build always measures
// the same; the gzip size is shown for information.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

export const MEASURES = Object.freeze({
  appJs: 'App JavaScript (without Mapbox GL JS)',
  css: 'CSS',
})

/** "hd.main-DaqRWeDh.js" -> "hd.main" (Vite adds "-<hash>" to every file). */
export const baseName = (file) => file.replace(/-[A-Za-z0-9_-]{8}\.(js|css)$/, '')

/**
 * Mapbox's own file names, without ".js". The three it loads up front (mapbox-gl, core,
 * shared) are in the mapbox-gl chunk, so only that chunk's name is matched for them: an
 * app chunk that happens to be called "core" or "shared" still counts as the app's.
 */
export function mapboxNamesIn(mapboxEsmDir) {
  return new Set(
    readdirSync(mapboxEsmDir)
      .filter((name) => name.endsWith('.js'))
      .map((name) => name.slice(0, -'.js'.length))
      .filter((name) => name !== 'core' && name !== 'shared'),
  )
}

/** Every file of a build's assets folder, with its kind, size and gzip size. Throws when it cannot be measured. */
export function measureAssets(assetsDir, mapboxNames) {
  if (!existsSync(assetsDir)) throw new Error(`${assetsDir} is missing. Run \`npm run build\` first.`)
  const files = readdirSync(assetsDir).map((name) => {
    const bytes = readFileSync(join(assetsDir, name))
    const kind = name.endsWith('.css') ? 'css' : !name.endsWith('.js') ? 'other' : mapboxNames.has(baseName(name)) ? 'mapbox' : 'appJs'
    return { name, kind, size: bytes.length, gzip: gzipSync(bytes).length }
  })
  // Without the split there is no way to tell the app's code from Mapbox's.
  if (!files.some((f) => f.kind === 'mapbox' && baseName(f.name) === 'mapbox-gl')) {
    throw new Error(`No mapbox-gl-*.js chunk in ${assetsDir}: the split in vite.config.ts is gone, so the app's own size cannot be measured.`)
  }
  return files
}

export const total = (files, kind, field = 'size') => files.filter((f) => f.kind === kind).reduce((sum, f) => sum + f[field], 0)

/** { appJs, css } in bytes. */
export const measuredSizes = (files) => Object.fromEntries(Object.keys(MEASURES).map((k) => [k, total(files, k)]))

/** Checks scripts/bundle-budget.json's shape: a positive whole number for every measure in each section. Returns problems. */
export function budgetProblems(budget) {
  const problems = []
  for (const section of ['ceiling', 'growthPerPr']) {
    for (const key of Object.keys(MEASURES)) {
      const v = budget?.[section]?.[key]
      if (!Number.isInteger(v) || v <= 0) problems.push(`scripts/bundle-budget.json has no positive whole "${section}.${key}" (bytes).`)
    }
  }
  if (!(typeof budget?.alertAt === 'number' && budget.alertAt > 0 && budget.alertAt < 1)) problems.push('scripts/bundle-budget.json has no "alertAt" between 0 and 1.')
  return problems
}

/** One row per measure: the size against the owner's ceiling. `over` when the size is above it. */
export function ceilingRows(sizes, budget) {
  return Object.keys(MEASURES).map((key) => {
    const ceiling = budget.ceiling[key]
    return { key, label: MEASURES[key], size: sizes[key], ceiling, used: sizes[key] / ceiling, over: sizes[key] > ceiling }
  })
}

/**
 * What a pull request adds to each measure, against the main it was tested on. This is the
 * shape the size job hands to the Gate's `required` job (scripts/orch/gates.mjs, sizeGrowthFailures):
 * { appJs: { base, pr, limit }, css: { base, pr, limit } }.
 */
export function growthReport(baseSizes, prSizes, budget) {
  return Object.fromEntries(Object.keys(MEASURES).map((key) => [key, { base: baseSizes[key], pr: prSizes[key], limit: budget.growthPerPr[key] }]))
}

/** Main's sizes against the ceiling, for the fleet board's headroom alert (scripts/orch/derive.mjs, bundleHeadroom). */
export function headroomReport(sizes, budget) {
  return { alertAt: budget.alertAt, ...Object.fromEntries(Object.keys(MEASURES).map((key) => [key, { size: sizes[key], ceiling: budget.ceiling[key] }])) }
}
