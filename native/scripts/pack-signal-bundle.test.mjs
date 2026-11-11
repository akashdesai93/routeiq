// node --test native/scripts/pack-signal-bundle.test.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { decodeTileRows, packSignalBundle } from './pack-signal-bundle.mjs'

function bundle(files) {
  const dir = mkdtempSync(join(tmpdir(), 'routeiq-pack-'))
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content))
  }
  return dir
}

const index = {
  version: 2,
  dataDate: 1794345699000,
  covered: { 352: [-810, -808] },
  files: { 352: [-809, -809] },
  attribution: '© OpenStreetMap contributors',
}
const tile = { tileId: '-809_352', fetchedAt: 1794345699000, nodes: [{ id: 1, lng: -80.85, lat: 35.27 }] }

test('decodes tile rows row by row, west to east', () => {
  assert.deepEqual(decodeTileRows({ 352: [-812, -810, -805, -805] }), ['-812_352', '-811_352', '-810_352', '-805_352'])
})

test('packs the index and every listed tile verbatim, and copies the license', () => {
  const dir = bundle({ 'index.json': index, '-809_352.json': tile, 'LICENSE.md': '# ODbL' })
  const out = join(dir, 'out')
  try {
    assert.deepEqual(packSignalBundle(dir, out).tiles, 1)
    const packed = JSON.parse(readFileSync(join(out, 'osm-signals.json'), 'utf8'))
    assert.deepEqual(packed, { version: 1, index, tiles: [tile] })
    assert.equal(readFileSync(join(out, 'osm-signals-LICENSE.md'), 'utf8'), '# ODbL')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('refuses a bundle that would make counts wrong or ship without its license', () => {
  const cases = [
    [{ 'index.json': index, 'LICENSE.md': 'x' }, /-809_352\.json is missing/],
    [{ 'index.json': index, '-809_352.json': { ...tile, tileId: '-808_352' }, 'LICENSE.md': 'x' }, /not a well-formed tile/],
    [{ 'index.json': { ...index, version: 1 }, 'LICENSE.md': 'x' }, /version 2/],
    [{ 'index.json': { ...index, files: { 352: [-809] } }, 'LICENSE.md': 'x' }, /malformed tile rows/],
    [{ 'index.json': index, '-809_352.json': tile }, /LICENSE\.md is missing/],
  ]
  for (const [files, error] of cases) {
    const dir = bundle(files)
    try {
      assert.throws(() => packSignalBundle(dir, join(dir, 'out')), error)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})
