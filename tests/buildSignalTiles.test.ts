import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isOsmSignalTile } from '../src/providers/osm/adapter.ts'
import { decodeTileRows, isOsmBundleIndex, tileRowsHas, type OsmBundleIndex } from '../src/providers/osm/bundle.ts'
import { main, OSM_LICENSE_MD, parseArgs } from '../scripts/build-signal-tiles.mjs'
import { nodeBlock, pbfFile, wayBlock, type FixtureNode } from './helpers/pbf.ts'

// The tile build script, run whole against two hand-built extracts ("north" and "south", two
// squares that meet along latitude 35.05) in a temporary folder. It needs no downloaded extract
// and makes no network request: fetch is replaced by a trap for the whole file.

const NORTH_DATE_SEC = 1_794_345_699
const SOUTH_DATE_SEC = NORTH_DATE_SEC - 2 * 24 * 60 * 60
const SIGNAL = { highway: 'traffic_signals' }

const NORTH_NODES: FixtureNode[] = [
  { id: 101, lng: -80.8431, lat: 35.2271, tags: SIGNAL },
  { id: 102, lng: -80.8433, lat: 35.2272, tags: { highway: 'traffic_signals', traffic_signals: 'signal' } },
  // On the edge between two tiles.
  { id: 104, lng: -80.8, lat: 35.25, tags: SIGNAL },
  // Left out: a flasher, a fire-station signal, a pedestrian signal, and a node that is no signal.
  { id: 105, lng: -80.75, lat: 35.25, tags: { highway: 'traffic_signals', traffic_signals: 'blinker' } },
  { id: 106, lng: -80.74, lat: 35.25, tags: { highway: 'traffic_signals', traffic_signals: 'emergency' } },
  { id: 107, lng: -80.73, lat: 35.25, tags: { highway: 'crossing', crossing: 'traffic_signals' } },
  { id: 108, lng: -80.72, lat: 35.25, tags: { highway: 'stop' } },
  // In the tile that pokes out past the west boundary (-80.95).
  { id: 109, lng: -80.93, lat: 35.15, tags: SIGNAL },
  // Close to the state line: the two extracts overlap a little, so the south one has it too.
  { id: 110, lng: -80.85, lat: 35.0502, tags: SIGNAL },
]
const SOUTH_NODES: FixtureNode[] = [
  { id: 110, lng: -80.85, lat: 35.0502, tags: SIGNAL },
  { id: 201, lng: -80.8561, lat: 35.0015, tags: SIGNAL },
  { id: 202, lng: -80.77, lat: 34.72, tags: SIGNAL },
]

const square = (west: number, south: number, east: number, north: number) =>
  ['none', '1', `   ${west}   ${south}`, `   ${east}   ${south}`, `   ${east}   ${north}`, `   ${west}   ${north}`, `   ${west}   ${south}`, 'END', 'END', ''].join('\n')

const temporary: string[] = []
function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'routeiq-build-'))
  temporary.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Writes the two extracts, their boundaries and their checksums into a new folder. */
function extracts(): string {
  const dir = join(folder(), 'osm-extracts')
  mkdirSync(dir)
  const write = (name: string, nodes: FixtureNode[], timestampSec: number, box: [number, number, number, number]) => {
    const pbf = pbfFile([nodeBlock(nodes.slice(0, 2)), nodeBlock(nodes.slice(2)), wayBlock()], { timestampSec })
    writeFileSync(join(dir, `${name}-latest.osm.pbf`), pbf)
    writeFileSync(join(dir, `${name}-latest.osm.pbf.md5`), `${createHash('md5').update(pbf).digest('hex')}  ${name}-latest.osm.pbf\n`)
    writeFileSync(join(dir, `${name}.poly`), square(...box))
  }
  write('north', NORTH_NODES, NORTH_DATE_SEC, [-80.95, 35.05, -80.5, 35.4])
  write('south', SOUTH_NODES, SOUTH_DATE_SEC, [-80.95, 34.7, -80.5, 35.05])
  return dir
}

async function run(argv: string[]) {
  const lines: string[] = []
  const realFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = (() => {
    requests++
    return Promise.reject(new Error('the build script must not use the network'))
  }) as typeof fetch
  try {
    const code = await main(argv, { log: (line) => lines.push(line), progressMs: 0 })
    return { code, text: lines.join('\n'), requests }
  } finally {
    globalThis.fetch = realFetch
  }
}

const readJson = (...path: string[]): unknown => JSON.parse(readFileSync(join(...path), 'utf8'))

describe('build script arguments', () => {
  it('reads data/osm-extracts and writes public/seed/osm-signals unless told otherwise', () => {
    const defaults = parseArgs([])
    if ('error' in defaults) throw new Error(defaults.error)
    expect(defaults.dryRun).toBe(false)
    expect(defaults.extractsDir.replace(/\\/g, '/')).toMatch(/\/data\/osm-extracts$/)
    expect(defaults.outDir.replace(/\\/g, '/')).toMatch(/\/public\/seed\/osm-signals$/)
    expect(parseArgs(['--dry-run', '--extracts', 'a', '--out', 'b'])).toMatchObject({ dryRun: true })
    for (const argv of [['--extracts'], ['--out', '--dry-run'], ['--endpoint', 'https://overpass.example'], ['--fast']]) {
      expect(parseArgs(argv)).toHaveProperty('error')
    }
  })

  it('exits 1 on a bad argument and 2 when there is no extract, writing nothing and asking no server', async () => {
    const out = join(folder(), 'out')
    const bad = await run(['--fast'])
    expect(bad.code).toBe(1)
    expect(bad.text).toContain('Usage:')
    const none = await run(['--extracts', folder(), '--out', out])
    expect(none.code).toBe(2)
    expect(none.text).toContain('No .osm.pbf extract')
    expect(none.text).toContain('download.geofabrik.de')
    expect(existsSync(out)).toBe(false)
    expect(bad.requests + none.requests).toBe(0)
  })
})

describe('build script run', () => {
  it('writes one file per tile with signals, an index of what is covered, and the license', async () => {
    const out = join(folder(), 'osm-signals')
    const { code, text, requests } = await run(['--extracts', extracts(), '--out', out])
    expect(code).toBe(0)
    expect(requests).toBe(0)

    const index = readJson(out, 'index.json') as OsmBundleIndex
    expect(isOsmBundleIndex(index)).toBe(true)
    // The oldest extract dates the bundle; both are named.
    expect(index.dataDate).toBe(SOUTH_DATE_SEC * 1000)
    expect(index.extracts).toEqual([
      { name: 'north', dataDate: NORTH_DATE_SEC * 1000 },
      { name: 'south', dataDate: SOUTH_DATE_SEC * 1000 },
    ])
    expect(index.source).toBe('OpenStreetMap, regional extracts by Geofabrik (north, south)')
    // Kept: 101, 102, 104, 109, 110 (once), 201, 202.
    expect(index.nodeCount).toBe(7)

    // Covered: columns -809 to -806 (the tiles of column -810 poke out past -80.95), rows 347 to 353,
    // the row the two states share (350) included.
    expect(index.covered).toEqual(Object.fromEntries([347, 348, 349, 350, 351, 352, 353].map((y) => [String(y), [-809, -806]])))
    const tileFiles = readdirSync(out).filter((name) => name !== 'index.json' && name !== 'LICENSE.md').sort()
    expect(tileFiles).toEqual(['-808_347.json', '-808_352.json', '-809_350.json', '-809_352.json', '-810_351.json'])
    expect(decodeTileRows(index.files).map((id) => `${id}.json`).sort()).toEqual(tileFiles)
    // The tile on the edge has a file (a lower bound for when the network fails) but is not covered.
    expect(tileRowsHas(index.files, '-810_351')).toBe(true)
    expect(tileRowsHas(index.covered, '-810_351')).toBe(false)
    // An empty tile inside the boundaries is covered and has no file.
    expect(tileRowsHas(index.covered, '-807_351')).toBe(true)
    expect(tileRowsHas(index.files, '-807_351')).toBe(false)

    for (const name of tileFiles) {
      const tile = readJson(out, name)
      // Exactly the shape the app's cache and bundle layer take.
      expect(isOsmSignalTile(tile), name).toBe(true)
      expect(tile).toMatchObject({ tileId: name.replace('.json', ''), fetchedAt: SOUTH_DATE_SEC * 1000 })
      expect(Object.keys(tile as object)).toEqual(['tileId', 'fetchedAt', 'nodes'])
    }
    expect(readJson(out, '-809_352.json')).toMatchObject({
      nodes: [
        { id: 101, lng: -80.8431, lat: 35.2271 },
        { id: 102, lng: -80.8433, lat: 35.2272 },
        { id: 104, lng: -80.8, lat: 35.25 },
      ],
    })
    expect(readJson(out, '-808_352.json')).toMatchObject({ nodes: [{ id: 104 }] })
    // The node both extracts hold is written once, and the south state's signal is in the shared row.
    expect((readJson(out, '-809_350.json') as { nodes: { id: number }[] }).nodes.map((n) => n.id)).toEqual([110, 201])

    const license = readFileSync(join(out, 'LICENSE.md'), 'utf8')
    expect(license).toBe(OSM_LICENSE_MD)
    expect(license).toContain('© OpenStreetMap contributors')
    expect(license).toContain('Open Database License (ODbL) 1.0')
    expect(license).toContain('https://www.openstreetmap.org/copyright')
    expect(license).toContain('extract by Geofabrik')
    expect(readdirSync(out).some((name) => name.includes('.tmp'))).toBe(false)

    // The report: totals, what was left out by subtype, and that the checksums were checked.
    expect(text).toContain('north: MD5 matches.')
    expect(text).toContain('7 tagged highway=traffic_signals, 5 kept')
    expect(text).toMatch(/excluded\s+blinker: 1/)
    expect(text).toMatch(/excluded\s+emergency: 1/)
    expect(text).toMatch(/kept\s+unspecified: 7/)
    expect(text).toContain('1 pedestrian signals (highway=crossing + crossing=traffic_signals)')
    expect(text).toContain('7 signal nodes in 5 tile files (4 fully covered, 1 on the edge of the boundaries)')
    expect(text).toContain('28 tiles are fully covered')
    expect(text).toContain('stopped at the end of the nodes')
  })

  it('writes nothing on --dry-run', async () => {
    const out = join(folder(), 'osm-signals')
    const { code, text } = await run(['--dry-run', '--extracts', extracts(), '--out', out])
    expect(code).toBe(0)
    expect(text).toContain('7 signal nodes in 5 tile files')
    expect(text).toContain('Dry run: nothing was written.')
    expect(existsSync(out)).toBe(false)
  })

  it('removes the tile files of an earlier build that the new index no longer lists, and nothing else', async () => {
    const out = join(folder(), 'osm-signals')
    mkdirSync(out)
    writeFileSync(join(out, '-700_300.json'), '{"tileId":"-700_300","fetchedAt":1,"nodes":[]}')
    writeFileSync(join(out, 'notes.txt'), 'keep me')
    expect((await run(['--extracts', extracts(), '--out', out])).code).toBe(0)
    expect(existsSync(join(out, '-700_300.json'))).toBe(false)
    expect(readFileSync(join(out, 'notes.txt'), 'utf8')).toBe('keep me')
    expect(existsSync(join(out, '-809_352.json'))).toBe(true)
  })

  it('refuses an extract that fails its checksum, has no boundary, is damaged or has no date', async () => {
    const cases: [string, (dir: string) => void, RegExp][] = [
      ['checksum', (dir) => writeFileSync(join(dir, 'north-latest.osm.pbf.md5'), `${'0'.repeat(32)}  north-latest.osm.pbf\n`), /does not match its \.md5/],
      ['boundary', (dir) => rmSync(join(dir, 'south.poly')), /south\.poly is missing/],
      ['bad boundary', (dir) => writeFileSync(join(dir, 'south.poly'), '<html>404</html>'), /not a boundary polygon/],
      [
        'damaged',
        (dir) => {
          rmSync(join(dir, 'north-latest.osm.pbf.md5'))
          writeFileSync(join(dir, 'north-latest.osm.pbf'), readFileSync(join(dir, 'north-latest.osm.pbf')).subarray(0, 120))
        },
        /could not be read/,
      ],
      [
        'undated',
        (dir) => {
          rmSync(join(dir, 'north-latest.osm.pbf.md5'))
          writeFileSync(join(dir, 'north-latest.osm.pbf'), pbfFile([nodeBlock(NORTH_NODES)]))
        },
        /does not say how old/,
      ],
    ]
    for (const [name, damage, message] of cases) {
      const dir = extracts()
      const out = join(folder(), 'osm-signals')
      // A good build first, so there is something to protect.
      expect((await run(['--extracts', dir, '--out', out])).code).toBe(0)
      const before = Object.fromEntries(readdirSync(out).map((file) => [file, readFileSync(join(out, file), 'utf8')]))
      damage(dir)
      const { code, text } = await run(['--extracts', dir, '--out', out])
      expect(code, name).toBe(2)
      expect(text, name).toMatch(message)
      expect(Object.fromEntries(readdirSync(out).map((file) => [file, readFileSync(join(out, file), 'utf8')])), name).toEqual(before)
    }
  })

  it('builds without a checksum file, and says the extract was not checked', async () => {
    const dir = extracts()
    rmSync(join(dir, 'north-latest.osm.pbf.md5'))
    const { code, text } = await run(['--dry-run', '--extracts', dir, '--out', join(folder(), 'out')])
    expect(code).toBe(0)
    expect(text).toContain('north: no north-latest.osm.pbf.md5 next to the extract, so it was not checked.')
    expect(text).toContain('south: MD5 matches.')
  })
})

describe('the bundle shipped with the app', () => {
  const dir = join(import.meta.dirname, '../public/seed/osm-signals')

  it('has an index the app accepts, a file for every tile the index lists and no other, and its license', () => {
    const index = readJson(dir, 'index.json') as OsmBundleIndex
    expect(isOsmBundleIndex(index)).toBe(true)
    const listed = decodeTileRows(index.files).map((id) => `${id}.json`).sort()
    const onDisk = readdirSync(dir).filter((name) => name !== 'index.json' && name !== 'LICENSE.md').sort()
    expect(onDisk).toEqual(listed)
    expect(decodeTileRows(index.covered).length).toBeGreaterThan(listed.length)
    // Uptown Charlotte and the default trip's destination across the state line are covered in full.
    for (const id of ['-809_352', '-809_350', '-809_349']) expect(tileRowsHas(index.covered, id), id).toBe(true)
    const uptown = readJson(dir, '-809_352.json')
    expect(isOsmSignalTile(uptown)).toBe(true)
    expect((uptown as { fetchedAt: number }).fetchedAt).toBe(index.dataDate)
    const license = readFileSync(join(dir, 'LICENSE.md'), 'utf8').replace(/\r\n/g, '\n')
    expect(license).toBe(OSM_LICENSE_MD)
    // Nothing of the City of Charlotte dataset is in the folder.
    expect(readFileSync(join(dir, '-809_352.json'), 'utf8')).not.toContain('clt-')
  })
})
