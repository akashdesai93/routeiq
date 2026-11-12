#!/usr/bin/env node
// The monthly refresh of the bundled OpenStreetMap signal tiles. Run by
// .github/workflows/signals-refresh.yml after it has downloaded the extracts; can be run by hand.
//
//   node scripts/refresh-signal-bundle.mjs                       build, compare, write if sound
//   node scripts/refresh-signal-bundle.mjs --dry-run             build and compare, write nothing
//   ... --extracts <dir>      the extracts (default data/osm-extracts)
//   ... --current <dir>       the bundle that ships (default public/seed/osm-signals)
//   ... --summary <file>      write the before/after report (Markdown) there
//   ... --result <file>       write { outcome, dataDate } as JSON there (for the workflow)
//
// It builds the new bundle into a temporary folder with build-signal-tiles.mjs, compares it with
// the current one (src/providers/osm/refresh.ts: the rules and DEFAULT_BUNDLE_REFRESH_CHECKS),
// and only when every check passes copies it over the current one (the index last, stale tile
// files removed). When a check fails it writes nothing: it fails closed.
// No network request. Needs Node 24. No dependencies.
// Exit codes: 0 refreshed (or would be, on a dry run); 1 bad arguments; 2 the build failed (an
// extract missing or damaged); 3 nothing to do (the data is no newer); 4 rejected (a check failed).

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isOsmSignalTile } from '../src/providers/osm/adapter.ts'
import { decodeTileRows, isOsmBundleIndex } from '../src/providers/osm/bundle.ts'
import { judgeRefresh, refreshSummary } from '../src/providers/osm/refresh.ts'
import { DEFAULT_EXTRACTS_DIR, DEFAULT_OUT_DIR, main as buildTiles } from './build-signal-tiles.mjs'
import { writeFilesAtomically } from './lib/write-files.mjs'

export const EXIT = { refreshed: 0, badArguments: 1, buildFailed: 2, unchanged: 3, rejected: 4 }

const USAGE =
  'Usage: node scripts/refresh-signal-bundle.mjs [--dry-run] [--extracts <dir>] [--current <dir>] [--summary <file>] [--result <file>]'
const TILE_FILE = /^-?\d+_-?\d+\.json$/
const BUNDLE_FILES = new Set(['index.json', 'LICENSE.md'])

/** @param {readonly string[]} argv */
export function parseArgs(argv) {
  const options = { dryRun: false, extractsDir: DEFAULT_EXTRACTS_DIR, currentDir: DEFAULT_OUT_DIR, summary: null, result: null }
  const flags = { '--extracts': 'extractsDir', '--current': 'currentDir', '--summary': 'summary', '--result': 'result' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') options.dryRun = true
    else if (Object.hasOwn(flags, arg)) {
      const value = argv[++i]
      if (value === undefined || value.startsWith('--')) return { error: `${arg} needs a path` }
      options[flags[arg]] = resolve(value)
    } else return { error: `Unknown argument: ${arg}` }
  }
  return options
}

/**
 * Reads a bundle folder. Resolves with `{ error }` when there is no readable index: without one
 * there is nothing to compare. Everything else that is wrong is left for bundleProblems to report.
 */
export async function readBundle(dir) {
  const names = await readdir(dir).catch(() => null)
  if (names === null) return { error: `${dir} cannot be read.` }
  const indexText = await readFile(join(dir, 'index.json'), 'utf8').catch(() => null)
  if (indexText === null) return { error: `${dir} has no index.json.` }
  let index
  try {
    index = JSON.parse(indexText)
  } catch {
    return { error: `${dir}/index.json is not JSON.` }
  }
  if (!isOsmBundleIndex(index) || !Array.isArray(index.extracts) || typeof index.nodeCount !== 'number') {
    return { error: `${dir}/index.json is not a bundle index.` }
  }
  let bytes = 0
  const tiles = []
  const unreadable = []
  for (const name of names.sort()) {
    if (name.startsWith('.')) continue
    const text = await readFile(join(dir, name), 'utf8').catch(() => null)
    if (text === null) {
      unreadable.push(name)
      continue
    }
    bytes += Buffer.byteLength(text)
    if (BUNDLE_FILES.has(name)) continue
    let tile = null
    if (TILE_FILE.test(name)) {
      try {
        tile = JSON.parse(text)
      } catch {
        tile = null
      }
    }
    if (tile !== null && isOsmSignalTile(tile)) tiles.push({ fileName: name, tile })
    else unreadable.push(name)
  }
  return { index, tiles, unreadable, bytes }
}

/** Copies a checked bundle over the current one: tiles first, the index last, then old tile files removed. */
async function promote(fromDir, toDir, index) {
  const names = (await readdir(fromDir)).filter((name) => !name.startsWith('.')).sort()
  const ordered = [...names.filter((name) => name !== 'index.json'), 'index.json']
  const files = []
  for (const name of ordered) files.push([name, await readFile(join(fromDir, name), 'utf8')])
  await writeFilesAtomically(toDir, files)
  const current = new Set(decodeTileRows(index.files).map((id) => `${id}.json`))
  const stale = (await readdir(toDir)).filter((name) => TILE_FILE.test(name) && !current.has(name))
  for (const name of stale) await rm(join(toDir, name), { force: true })
  return stale.length
}

/**
 * The whole script; the tests run it against hand-built extracts in a temporary folder.
 * @param {readonly string[]} argv
 * @param {{ log?: (line: string) => void, now?: number }} [deps]
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, deps = {}) {
  const { log = console.log, now = Date.now() } = deps
  const options = parseArgs(argv)
  if ('error' in options) {
    log(options.error)
    log(USAGE)
    return EXIT.badArguments
  }
  const report = async (outcome, summary, dataDate = null) => {
    if (options.summary !== null) await writeFile(options.summary, `${summary}\n`, 'utf8')
    if (options.result !== null) await writeFile(options.result, `${JSON.stringify({ outcome, dataDate })}\n`, 'utf8')
  }

  const scratch = await mkdtemp(join(tmpdir(), 'routeiq-signals-refresh-'))
  try {
    const code = await buildTiles(['--extracts', options.extractsDir, '--out', scratch], { log })
    if (code !== 0) {
      await report('build-failed', '## Signal bundle refresh FAILED: the extracts could not be built\n\nSee the run log. Nothing was written.')
      return EXIT.buildFailed
    }
    const before = await readBundle(options.currentDir)
    const after = await readBundle(scratch)
    for (const side of [before, after]) {
      if ('error' in side) {
        log(side.error)
        await report('rejected', `## Signal bundle refresh REJECTED\n\n${side.error} Nothing was written.`)
        return EXIT.rejected
      }
    }

    const { verdict, diff } = judgeRefresh(before, after, now)
    const summary = refreshSummary(verdict, diff)
    for (const item of verdict.checks) log(`${item.pass ? 'pass' : 'FAIL'}  ${item.name}: ${item.detail}`)
    const dataDate = new Date(diff.after.dataDate).toISOString().slice(0, 10)

    if (verdict.kind === 'reject') {
      log('Rejected: the new data looks wrong. Nothing was written.')
      await report('rejected', summary, dataDate)
      return EXIT.rejected
    }
    if (verdict.kind === 'unchanged') {
      log(`Nothing to do: the extracts are still of ${dataDate}.`)
      await report('unchanged', summary, dataDate)
      return EXIT.unchanged
    }
    if (options.dryRun) log('Dry run: the refresh passed its checks; nothing was written.')
    else {
      const stale = await promote(scratch, options.currentDir, after.index)
      log(`Refreshed ${options.currentDir} with the data of ${dataDate} (${stale} old tile files removed).`)
    }
    await report('refreshed', summary, dataDate)
    return EXIT.refreshed
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
