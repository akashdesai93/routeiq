#!/usr/bin/env node
// Builds the OpenStreetMap signal tiles RouteIQ ships with, from regional extracts on disk.
//
//   npm run build:signals                         read data/osm-extracts, write public/seed/osm-signals
//   npm run build:signals -- --dry-run            read and report, write nothing
//   npm run build:signals -- --extracts <dir>     another folder of extracts
//   npm run build:signals -- --out <dir>          another output folder
//
// Input, in the extracts folder (download them by hand from Geofabrik; see README.md):
//   <region>-latest.osm.pbf       the extract                      (required, one or more)
//   <region>.poly                 the boundary it was clipped to   (required, one per extract)
//   <region>-latest.osm.pbf.md5   its checksum                     (checked when present)
//
// Output: one JSON file per 0.1 degree tile that holds at least one traffic signal, in the shape
// the app's tile cache uses, plus index.json (which tiles lie entirely inside the boundaries, which
// have a file, and the date of the data) and LICENSE.md. A tile inside the boundaries without a
// file is known to be empty; a tile that pokes outside them is not "covered", because the extract
// is clipped there and would undercount.
//
// This script makes no network request. It streams each extract once (nothing is loaded whole)
// and stops at the end of the nodes. Needs Node 24 (it imports the app's TypeScript modules
// directly). No dependencies.
// Exit codes: 0 written (or dry run finished); 1 bad arguments; 2 an input is missing, damaged or
// does not match its checksum. A run that fails leaves the files already on disk as they were.

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  buildBundleIndex,
  classifySignalTags,
  decodeTileRows,
  groupIntoTiles,
  OSM_ATTRIBUTION,
  tileRowsHas,
} from '../src/providers/osm/bundle.ts'
import { fullyCoveredTiles, parsePoly } from '../src/providers/osm/coverage.ts'
import { collectTaggedNodes } from './lib/osm-pbf.mjs'
import { writeFilesAtomically } from './lib/write-files.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_EXTRACTS_DIR = resolve(HERE, '../data/osm-extracts')
export const DEFAULT_OUT_DIR = resolve(HERE, '../public/seed/osm-signals')

/** Where the extracts come from. Only named in messages: this script never downloads. */
export const EXTRACTS_URL = 'https://download.geofabrik.de/north-america/us/'

export const OSM_LICENSE_MD = `# Traffic signal tiles: OpenStreetMap

The files in this folder hold map data from OpenStreetMap: the positions of nodes tagged
\`highway=traffic_signals\`, one file per 0.1 degree tile that has any, and an \`index.json\` that
says which tiles are covered. They were built from regional extracts of OpenStreetMap
(extract by Geofabrik, https://download.geofabrik.de/).

${OSM_ATTRIBUTION}

The data is available under the Open Database License (ODbL) 1.0:
https://www.openstreetmap.org/copyright
https://opendatacommons.org/licenses/odbl/1-0/

You are free to copy, distribute, transmit and adapt this data, as long as you credit
OpenStreetMap and its contributors. If you alter or build upon the data, you may distribute the
result only under the same license.

Nothing from any other source is in this folder. Written by scripts/build-signal-tiles.mjs.
`

const USAGE = 'Usage: node scripts/build-signal-tiles.mjs [--dry-run] [--extracts <dir>] [--out <dir>]'
const TILE_FILE = /^-?\d+_-?\d+\.json$/
const EXTRACT_FILE = /^(.+?)(?:-latest|-\d{6})?\.osm\.pbf$/

/**
 * Reads the command line. Returns the options, or `{ error }` with a message.
 * @param {readonly string[]} argv arguments after the script name
 */
export function parseArgs(argv) {
  const options = { dryRun: false, extractsDir: DEFAULT_EXTRACTS_DIR, outDir: DEFAULT_OUT_DIR }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--extracts' || arg === '--out') {
      const value = argv[++i]
      if (value === undefined || value.startsWith('--')) return { error: `${arg} needs a folder` }
      if (arg === '--extracts') options.extractsDir = resolve(value)
      else options.outDir = resolve(value)
    } else return { error: `Unknown argument: ${arg}` }
  }
  return options
}

async function md5Of(path) {
  const hash = createHash('md5')
  for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 })) hash.update(chunk)
  return hash.digest('hex')
}

const count = (n) => n.toLocaleString('en-US')
const megabytes = (bytes) => `${(bytes / 1e6).toFixed(0)} MB`

/**
 * Reads one extract: checks it against its .md5 when there is one, reads its boundary, and
 * streams it for signal nodes. Resolves with `{ error }` instead of throwing.
 */
async function readExtract(dir, fileName, { log, progressMs }) {
  const name = EXTRACT_FILE.exec(fileName)[1]
  const path = join(dir, fileName)
  const polyText = await readFile(join(dir, `${name}.poly`), 'utf8').catch(() => null)
  if (polyText === null) return { error: `${fileName}: its boundary file ${name}.poly is missing (${EXTRACTS_URL}${name}.poly).` }
  const parsed = parsePoly(polyText)
  if (parsed === null) return { error: `${name}.poly is not a boundary polygon file.` }
  // The name inside Geofabrik's .poly files is "none"; the file name is the one that means something.
  const poly = { ...parsed, name }

  const expected = await readFile(`${path}.md5`, 'utf8').then((text) => text.trim().split(/\s+/)[0].toLowerCase(), () => null)
  if (expected === null) log(`${name}: no ${fileName}.md5 next to the extract, so it was not checked.`)
  else if ((await md5Of(path)) !== expected) return { error: `${fileName} does not match its .md5 checksum. Download it again.` }
  else log(`${name}: MD5 matches.`)

  const { size } = await stat(path)
  let read = 0
  let lastLog = Date.now()
  let found = 0
  async function* counted() {
    for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 })) {
      read += chunk.length
      yield chunk
    }
  }
  let scan
  try {
    scan = await collectTaggedNodes(counted(), {
      key: 'highway',
      values: ['traffic_signals', 'crossing'],
      onBlock: () => {
        if (Date.now() - lastLog < progressMs) return
        lastLog = Date.now()
        log(`${name}: ${megabytes(read)} of ${megabytes(size)} read...`)
      },
    })
    found = scan.nodes.length
  } catch (error) {
    return { error: `${fileName} could not be read: ${error instanceof Error ? error.message : String(error)}` }
  }

  // Sort the nodes found into kept signals and everything else, counting each kind.
  const kinds = {}
  const signals = []
  let tagged = 0
  let crossingOnly = 0
  for (const node of scan.nodes) {
    const verdict = classifySignalTags(node.tags)
    if (verdict.kind === 'crossing_only') crossingOnly++
    if (node.tags.highway !== 'traffic_signals') continue
    tagged++
    const kind = (kinds[verdict.kind] ??= { nodes: 0, kept: verdict.keep })
    kind.nodes++
    if (verdict.keep) signals.push({ id: node.id, lng: node.lng, lat: node.lat })
  }
  const dataDate = scan.header.replicationTimestampSec === null ? null : scan.header.replicationTimestampSec * 1000
  log(
    `${name}: ${count(scan.nodeCount)} nodes in ${megabytes(read)}${scan.stoppedEarly ? ` (stopped at the end of the nodes; the file is ${megabytes(size)})` : ''}, ` +
      `${count(found)} candidates, ${count(tagged)} tagged highway=traffic_signals, ${count(signals.length)} kept.`,
  )
  return { name, poly, signals, kinds, tagged, crossingOnly, dataDate, nodeCount: scan.nodeCount }
}

/**
 * The whole script. Everything it touches can be swapped out, which is how the tests run it
 * against a hand-built extract in a temporary folder.
 * @param {readonly string[]} argv
 * @param {{ log?: (line: string) => void, progressMs?: number }} [deps]
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, deps = {}) {
  const { log = console.log, progressMs = 2000 } = deps
  const options = parseArgs(argv)
  if ('error' in options) {
    log(options.error)
    log(USAGE)
    return 1
  }
  const started = Date.now()
  const names = await readdir(options.extractsDir).catch(() => [])
  const extractFiles = names.filter((name) => EXTRACT_FILE.test(name)).sort()
  if (extractFiles.length === 0) {
    log(`No .osm.pbf extract in ${options.extractsDir}.`)
    log(`Download <region>-latest.osm.pbf, its .md5 and <region>.poly from ${EXTRACTS_URL} into that folder first (see README.md).`)
    return 2
  }

  const extracts = []
  for (const fileName of extractFiles) {
    const extract = await readExtract(options.extractsDir, fileName, { log, progressMs })
    if ('error' in extract) {
      log(extract.error)
      log('Nothing was written. Files already on disk were left as they were.')
      return 2
    }
    if (extract.dataDate === null) {
      log(`${fileName} does not say how old its data is. Nothing was written.`)
      return 2
    }
    extracts.push(extract)
  }

  // Per-subtype report, all extracts together. A node in two extracts (they overlap a little) counts in each.
  const kinds = {}
  for (const extract of extracts) {
    for (const [kind, { nodes, kept }] of Object.entries(extract.kinds)) {
      const total = (kinds[kind] ??= { nodes: 0, kept })
      total.nodes += nodes
    }
  }
  log('highway=traffic_signals nodes by traffic_signals=* value:')
  for (const [kind, { nodes, kept }] of Object.entries(kinds).sort((a, b) => b[1].nodes - a[1].nodes)) {
    log(`  ${kept ? 'kept    ' : 'excluded'}  ${kind}: ${count(nodes)}`)
  }
  const crossingOnly = extracts.reduce((sum, extract) => sum + extract.crossingOnly, 0)
  log(`Also seen and not used: ${count(crossingOnly)} pedestrian signals (highway=crossing + crossing=traffic_signals).`)

  const index0 = extracts.map((extract) => ({ name: extract.name, dataDate: extract.dataDate }))
  const dataDate = Math.min(...index0.map((extract) => extract.dataDate))
  const covered = fullyCoveredTiles(extracts.map((extract) => extract.poly))
  const tiles = groupIntoTiles(extracts.flatMap((extract) => extract.signals), dataDate)
  const index = buildBundleIndex(tiles, covered, index0)
  const clipped = tiles.filter((tile) => !tileRowsHas(index.covered, tile.tileId)).length

  const files = [
    ['LICENSE.md', OSM_LICENSE_MD],
    ...tiles.map((tile) => [`${tile.tileId}.json`, `${JSON.stringify(tile)}\n`]),
    // The index goes last: it only ever lists files that are already in place.
    ['index.json', `${JSON.stringify(index)}\n`],
  ]
  const bytes = files.reduce((sum, [, text]) => sum + Buffer.byteLength(text), 0)
  const day = (ms) => new Date(ms).toISOString().slice(0, 10)
  log(
    `${count(index.nodeCount)} signal nodes in ${count(tiles.length)} tile files ` +
      `(${count(tiles.length - clipped)} fully covered, ${count(clipped)} on the edge of the boundaries).`,
  )
  log(
    `${count(covered.length)} tiles are fully covered (${count(covered.length - (tiles.length - clipped))} of them have no signals and no file); ` +
      `the covered set is ${Object.values(index.covered).reduce((sum, runs) => sum + runs.length / 2, 0)} runs in ${Object.keys(index.covered).length} rows.`,
  )
  log(`Data date: ${day(dataDate)} (${index0.map((extract) => `${extract.name} ${day(extract.dataDate)}`).join(', ')}).`)
  log(`Size: ${(bytes / 1024).toFixed(0)} KiB in ${files.length} files (index.json ${(Buffer.byteLength(files.at(-1)[1]) / 1024).toFixed(1)} KiB).`)

  if (options.dryRun) {
    log('Dry run: nothing was written.')
    return 0
  }
  await writeFilesAtomically(options.outDir, files)
  // Tile files from an earlier build that the new index no longer lists.
  const current = new Set(decodeTileRows(index.files).map((id) => `${id}.json`))
  const stale = (await readdir(options.outDir)).filter((name) => TILE_FILE.test(name) && !current.has(name))
  for (const name of stale) await rm(join(options.outDir, name), { force: true })
  log(`Written to ${options.outDir}${stale.length > 0 ? ` (${stale.length} tile files of an earlier build removed)` : ''} in ${((Date.now() - started) / 1000).toFixed(1)} s.`)
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
