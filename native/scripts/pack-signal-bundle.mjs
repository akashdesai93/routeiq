#!/usr/bin/env node
// Packs the bundled OpenStreetMap signal tiles (public/seed/osm-signals: an
// index.json and one file per tile with signals) into ONE file for the iPhone
// app, so it ships one resource instead of about 900. The index and every tile
// are copied verbatim: { "version": 1, "index": <index.json>, "tiles": [<tile>, ...] }.
// The ODbL license file is copied next to it; it must ship with the data.
//
// Usage: node native/scripts/pack-signal-bundle.mjs <bundle folder> <output folder>
// Writes <output>/osm-signals.json and <output>/osm-signals-LICENSE.md.
// Fails (exit 1) on anything that would make the app's counts wrong: a
// malformed index, a tile listed in the index without a well-formed file, or
// a file whose tileId does not match its name.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const PACKED_VERSION = 1

/** Every tile id in a TileRows object, row by row, west to east (decodeTileRows). */
export function decodeTileRows(rows) {
  const ids = []
  for (const [y, runs] of Object.entries(rows)) {
    for (let i = 0; i + 1 < runs.length; i += 2) {
      for (let x = runs[i]; x <= runs[i + 1]; x++) ids.push(`${x}_${y}`)
    }
  }
  return ids
}

function isTileRows(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.entries(value).every(
    ([y, runs]) =>
      /^-?\d+$/.test(y) &&
      Array.isArray(runs) &&
      runs.length % 2 === 0 &&
      runs.every((x) => Number.isInteger(x)) &&
      runs.every((x, i) => i === 0 || (i % 2 === 1 ? x >= runs[i - 1] : x > runs[i - 1] + 1)),
  )
}

function isTile(value, tileId) {
  return (
    typeof value === 'object' &&
    value !== null &&
    value.tileId === tileId &&
    typeof value.fetchedAt === 'number' &&
    Array.isArray(value.nodes) &&
    value.nodes.every(
      (n) => Number.isSafeInteger(n?.id) && Number.isFinite(n?.lng) && Number.isFinite(n?.lat),
    )
  )
}

/** Packs the folder; returns a summary. Throws with a plain message on bad input. */
export function packSignalBundle(bundleDir, outDir) {
  const index = JSON.parse(readFileSync(join(bundleDir, 'index.json'), 'utf8'))
  if (index?.version !== 2 || !Number.isFinite(index.dataDate)) throw new Error('index.json is not a version 2 bundle index')
  if (!isTileRows(index.covered) || !isTileRows(index.files)) throw new Error('index.json has malformed tile rows')
  const licensePath = join(bundleDir, 'LICENSE.md')
  if (!existsSync(licensePath)) throw new Error('LICENSE.md is missing: the data cannot ship without it')

  const tiles = []
  let nodes = 0
  for (const tileId of decodeTileRows(index.files)) {
    const path = join(bundleDir, `${tileId}.json`)
    if (!existsSync(path)) throw new Error(`index.json lists ${tileId} but ${tileId}.json is missing`)
    const tile = JSON.parse(readFileSync(path, 'utf8'))
    if (!isTile(tile, tileId)) throw new Error(`${tileId}.json is not a well-formed tile`)
    tiles.push(tile)
    nodes += tile.nodes.length
  }

  mkdirSync(outDir, { recursive: true })
  const packed = JSON.stringify({ version: PACKED_VERSION, index, tiles })
  writeFileSync(join(outDir, 'osm-signals.json'), packed)
  copyFileSync(licensePath, join(outDir, 'osm-signals-LICENSE.md'))
  return { tiles: tiles.length, nodes, bytes: Buffer.byteLength(packed) }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [bundleDir, outDir] = process.argv.slice(2)
  if (!bundleDir || !outDir) {
    console.error('Usage: node native/scripts/pack-signal-bundle.mjs <bundle folder> <output folder>')
    process.exit(2)
  }
  try {
    const { tiles, nodes, bytes } = packSignalBundle(bundleDir, outDir)
    console.log(`Packed ${tiles} tiles (${nodes} node entries, ${(bytes / 1e6).toFixed(2)} MB) into ${join(outDir, 'osm-signals.json')}`)
  } catch (error) {
    console.error(`pack-signal-bundle: ${error.message}`)
    process.exit(1)
  }
}
