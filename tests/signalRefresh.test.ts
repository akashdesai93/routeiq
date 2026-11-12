import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { OsmSignalNode } from '../src/providers/osm/adapter.ts'
import { buildBundleIndex, groupIntoTiles } from '../src/providers/osm/bundle.ts'
import {
  DEFAULT_BUNDLE_REFRESH_CHECKS,
  judgeRefresh,
  refreshSummary,
  type BundleSnapshot,
} from '../src/providers/osm/refresh.ts'
import { main as buildTiles } from '../scripts/build-signal-tiles.mjs'
import { EXIT, main as refresh } from '../scripts/refresh-signal-bundle.mjs'
import { nodeBlock, pbfFile, wayBlock, type FixtureNode } from './helpers/pbf.ts'

// The monthly refresh of the bundled signal tiles: a fresh build replaces the shipped bundle only
// when it looks like the same data a month later. The rules are the spec; the script is then run
// whole against hand-built extracts in a temporary folder, with no network.

const DAY = 24 * 60 * 60 * 1000
const NOV_10 = Date.UTC(2026, 10, 10, 20, 0, 0)
const DEC_10 = NOV_10 + 30 * DAY
const NOW = DEC_10 + 2 * DAY

/** Uptown Charlotte's tile (-809_352) and three of its neighbours. */
const TILES = [
  { west: -80.9, south: 35.2 },
  { west: -80.8, south: 35.2 },
  { west: -80.9, south: 35.1 },
  { west: -80.8, south: 35.1 },
]

/** `perTile[t]` signals in tile t (at most 400), ids 1000 * (t + 1) + n, on a grid well inside the tile. */
function signals(perTile: readonly number[]): OsmSignalNode[] {
  return perTile.flatMap((count, t) =>
    Array.from({ length: count }, (_, n) => ({
      id: 1000 * (t + 1) + n,
      lng: TILES[t]!.west + 0.01 + (n % 20) * 0.004,
      lat: TILES[t]!.south + 0.01 + Math.floor(n / 20) * 0.004,
    })),
  )
}

const COVERED = ['-809_352', '-808_352', '-809_351', '-808_351', '-810_352']

function bundle(
  nodes: readonly OsmSignalNode[],
  dataDate: number,
  { covered = COVERED, extracts = ['north-carolina', 'south-carolina'] }: { covered?: string[]; extracts?: string[] } = {},
): BundleSnapshot {
  const tiles = groupIntoTiles(nodes, dataDate)
  const index = buildBundleIndex(tiles, covered, extracts.map((name) => ({ name, dataDate })))
  const files = tiles.map((tile) => ({ fileName: `${tile.tileId}.json`, tile }))
  const bytes = files.reduce((sum, { tile }) => sum + JSON.stringify(tile).length + 1, JSON.stringify(index).length + 1)
  return { index, tiles: files, unreadable: [], bytes }
}

/** 100 signals in each of the four tiles: 400. */
const SHIPPED = bundle(signals([100, 100, 100, 100]), NOV_10)

const failed = (result: ReturnType<typeof judgeRefresh>) => result.verdict.checks.filter((check) => !check.pass).map((check) => check.name)

describe('judgeRefresh: when a new bundle may replace the shipped one', () => {
  it('takes an ordinary month: newer data, a few signals added, removed and moved', () => {
    const nodes = signals([100, 100, 100, 100]).filter((node) => node.id !== 1003 && node.id !== 2007)
    nodes.push({ id: 9001, lng: -80.85, lat: 35.25 }, { id: 9002, lng: -80.75, lat: 35.15 }, { id: 9003, lng: -80.76, lat: 35.16 })
    const at = nodes.findIndex((node) => node.id === 3001)
    nodes[at] = { ...nodes[at]!, lat: nodes[at]!.lat + 0.0002 }
    const result = judgeRefresh(SHIPPED, bundle(nodes, DEC_10), NOW)

    expect(result.verdict.kind).toBe('refresh')
    expect(result.diff.added).toEqual([9001, 9002, 9003])
    expect(result.diff.removed).toEqual([1003, 2007])
    expect(result.diff.moved).toEqual([3001])
    expect(result.diff.before.signals).toBe(400)
    expect(result.diff.after.signals).toBe(401)
    // Per tile: -809_352 lost one and gained one (no change), -808_352 lost one, -808_351 gained two.
    expect(result.diff.tiles).toEqual([
      { tileId: '-808_351', before: 100, after: 102 },
      { tileId: '-808_352', before: 100, after: 99 },
    ])
  })

  it('does nothing when the extracts are no newer than what ships', () => {
    expect(judgeRefresh(SHIPPED, SHIPPED, NOW).verdict.kind).toBe('unchanged')
  })

  it('rejects a drop of more than 3 % of the signals, and takes 3 %', () => {
    // 13 of 400 gone is 3.25 %; 12 is exactly 3 %.
    const thirteen = judgeRefresh(SHIPPED, bundle(signals([87, 100, 100, 100]), DEC_10), NOW)
    expect(thirteen.verdict.kind).toBe('reject')
    expect(failed(thirteen)).toContain('Signals drop by at most 3.0 %')
    expect(judgeRefresh(SHIPPED, bundle(signals([88, 100, 100, 100]), DEC_10), NOW).verdict.kind).toBe('refresh')
  })

  it('rejects heavy churn even when the total holds: more than 5 % of the old signals gone', () => {
    // 21 of 400 removed (5.25 %) and 21 new ones elsewhere: the total is unchanged.
    const nodes = signals([100, 100, 100, 100]).filter((node) => !(node.id >= 1000 && node.id < 1021))
    for (let n = 0; n < 21; n++) nodes.push({ id: 8000 + n, lng: -80.79 + n * 0.003, lat: 35.13 })
    const result = judgeRefresh(SHIPPED, bundle(nodes, DEC_10), NOW)
    expect(result.diff.after.signals).toBe(400)
    expect(failed(result)).toEqual(['At most 5.0 % of the signals removed'])
  })

  it('rejects a hole in one city while the state total looks fine', () => {
    // A 40-signal tile among 1,000 signals loses 11 (27.5 %): only 1.1 % of the total.
    const shipped = bundle(signals([40, 320, 320, 320]), NOV_10)
    const hole = judgeRefresh(shipped, bundle(signals([29, 320, 320, 320]), DEC_10), NOW)
    expect(failed(hole)).toEqual(['No tile with 20+ signals loses more than 25.0 %'])
    expect(hole.verdict.checks.find((check) => !check.pass)!.detail).toBe('-809_352 40 -> 29')
    // Losing 10 (25 %) is allowed, and so is a small tile losing most of its few signals.
    expect(judgeRefresh(shipped, bundle(signals([30, 320, 320, 320]), DEC_10), NOW).verdict.kind).toBe('refresh')
    const small = bundle(signals([19, 320, 320, 320]), NOV_10)
    expect(judgeRefresh(small, bundle(signals([5, 320, 320, 320]), DEC_10), NOW).verdict.kind).toBe('refresh')
  })

  it('rejects a boundary that grew: a new covered tile without a file would show 0 signals', () => {
    const result = judgeRefresh(SHIPPED, bundle(signals([100, 100, 100, 100]), DEC_10, { covered: [...COVERED, '-810_351'] }), NOW)
    expect(failed(result)).toEqual(['The covered tiles stay the same'])
    expect(result.diff.coveredGained).toEqual(['-810_351'])
  })

  it('rejects a boundary that shrank: a sign it is damaged', () => {
    const result = judgeRefresh(SHIPPED, bundle(signals([100, 100, 100, 100]), DEC_10, { covered: COVERED.slice(0, 4) }), NOW)
    expect(failed(result)).toEqual(['The covered tiles stay the same'])
    expect(result.diff.coveredLost).toEqual(['-810_352'])
  })

  it('rejects positions shifted en masse while ids and counts hold, and takes a few moves', () => {
    // 21 of 400 signals 200 m north, each still in its tile: 5.25 %. 20 is exactly 5 %.
    const shift = (count: number) =>
      bundle(signals([100, 100, 100, 100]).map((node, n) => (n < count ? { ...node, lat: node.lat + 0.0018 } : node)), DEC_10)
    const shifted = judgeRefresh(SHIPPED, shift(21), NOW)
    expect(shifted.diff.moved).toHaveLength(21)
    expect(failed(shifted)).toEqual(['At most 5.0 % of the signals moved'])
    expect(judgeRefresh(SHIPPED, shift(20), NOW).verdict.kind).toBe('refresh')
  })

  it('rejects other regions, a date going backwards and a date in the future', () => {
    const other = judgeRefresh(SHIPPED, bundle(signals([100, 100, 100, 100]), DEC_10, { extracts: ['north-carolina'] }), NOW)
    expect(failed(other)).toEqual(['Same extracts'])
    const older = judgeRefresh(bundle(signals([100, 100, 100, 100]), DEC_10), bundle(signals([100, 100, 100, 100]), NOV_10), NOW)
    expect(failed(older)).toEqual(['Data date does not go backwards'])
    const future = judgeRefresh(SHIPPED, bundle(signals([100, 100, 100, 100]), NOW + 2 * DAY), NOW)
    expect(failed(future)).toEqual(['Data date is not in the future'])
  })

  it('rejects growth of more than 15 %: a wrong region or a bulk import to look at first', () => {
    // 61 new signals is 15.25 %; 60 is exactly 15 %.
    const grown = judgeRefresh(SHIPPED, bundle(signals([100, 100, 100, 161]), DEC_10), NOW)
    expect(failed(grown)).toContain('Signals grow by at most 15.0 %')
    // (The bytes grow past 15 % with them, which is its own check.)
    expect(failed(judgeRefresh(SHIPPED, bundle(signals([100, 100, 100, 160]), DEC_10), NOW))).not.toContain('Signals grow by at most 15.0 %')
  })

  it('rejects a bundle that grew in bytes past 15 % with the same signals', () => {
    const fat = { ...bundle(signals([100, 100, 100, 100]), DEC_10), bytes: Math.ceil(SHIPPED.bytes * 1.16) }
    expect(failed(judgeRefresh(SHIPPED, fat, NOW))).toEqual(['Bytes grow by at most 15.0 %'])
  })

  it('rejects a new bundle whose index and files disagree', () => {
    const good = bundle(signals([100, 100, 100, 100]), DEC_10)
    const missingFile = { ...good, tiles: good.tiles.slice(1) }
    const missing = judgeRefresh(SHIPPED, missingFile, NOW)
    expect(failed(missing)).toContain('The new bundle is sound')
    expect(missing.verdict.checks[1]!.detail).toContain('The index lists 1 tile files that are missing')
    const miscounted = { ...good, index: { ...good.index, nodeCount: 399 } }
    expect(failed(judgeRefresh(SHIPPED, miscounted, NOW))).toEqual(['The new bundle is sound'])
  })

  // Each of these is a corrupt build the app would misread; each must stop the refresh on its own.
  const good = () => bundle(signals([100, 100, 100, 100]), DEC_10)
  const withTile = (index: number, change: (entry: BundleSnapshot['tiles'][number]) => BundleSnapshot['tiles'][number]) => {
    const b = good()
    return { ...b, tiles: b.tiles.map((entry, i) => (i === index ? change(entry) : entry)) }
  }
  it.each([
    ['a tile dated differently from the index', () => withTile(0, (e) => ({ ...e, tile: { ...e.tile, fetchedAt: NOV_10 } })), 'is dated differently'],
    ['a tile file under the wrong name', () => withTile(0, (e) => ({ ...e, fileName: '-807_352.json' })), 'holds tile'],
    ['an empty tile file', () => withTile(0, (e) => ({ ...e, tile: { ...e.tile, nodes: [] } })), 'has no signals'],
    [
      'a tile file the index does not list',
      () => {
        const b = good()
        const extra = { tileId: '-807_352', fetchedAt: DEC_10, nodes: [{ id: 1, lng: -80.65, lat: 35.25 }] }
        return { ...b, tiles: [...b.tiles, { fileName: '-807_352.json', tile: extra }], index: { ...b.index, nodeCount: 401 } }
      },
      'is not listed in the index',
    ],
    ['a file that could not be read', () => ({ ...good(), unreadable: ['-809_352.json'] }), 'is not a readable tile file'],
    ['an index that names no extract', () => ({ ...good(), index: { ...good().index, extracts: [] } }), 'names no extract'],
  ])('rejects %s', (_, make, words) => {
    const result = judgeRefresh(SHIPPED, make(), NOW)
    expect(failed(result)).toContain('The new bundle is sound')
    expect(result.verdict.checks.find((check) => check.name === 'The new bundle is sound')!.detail).toContain(words)
  })

  it('rejects when the shipped bundle is itself broken, or empty: there is nothing sound to compare with', () => {
    const broken = { ...SHIPPED, unreadable: ['-809_352.json'] }
    expect(failed(judgeRefresh(broken, good(), NOW))).toEqual(['The bundle that ships is sound'])
    const empty = bundle([], NOV_10)
    expect(failed(judgeRefresh(empty, good(), NOW))).toContain('Signals drop by at most 3.0 %')
  })

  it('keeps every threshold in DEFAULT_BUNDLE_REFRESH_CHECKS', () => {
    // A looser drop limit takes the 3.25 % drop the default refuses.
    const thirteen = bundle(signals([87, 100, 100, 100]), DEC_10)
    expect(judgeRefresh(SHIPPED, thirteen, NOW, { ...DEFAULT_BUNDLE_REFRESH_CHECKS, maxSignalDrop: 0.04 }).verdict.kind).toBe('refresh')
  })
})

describe('refreshSummary: the before/after report on the pull request', () => {
  it('gives the counts, the tiles that changed and the node ids added and removed', () => {
    const nodes = signals([100, 100, 100, 100]).filter((node) => node.id !== 4005)
    nodes.push({ id: 9001, lng: -80.85, lat: 35.25 })
    const { verdict, diff } = judgeRefresh(SHIPPED, bundle(nodes, DEC_10), NOW)
    const text = refreshSummary(verdict, diff)
    expect(text).toContain('## Signal bundle refresh: data of 2026-12-10 (was 2026-11-10)')
    expect(text).toContain('| Signals | 400 | 400 | 0 |')
    expect(text).toContain('| -808_351 | 100 | 99 | -1 |')
    expect(text).toContain('Added: [9001](https://www.openstreetmap.org/node/9001)')
    expect(text).toContain('Removed: [4005](https://www.openstreetmap.org/node/4005)')
    expect(text).not.toContain('FAIL')
  })

  it('says it was rejected and marks the failed check', () => {
    const { verdict, diff } = judgeRefresh(SHIPPED, bundle(signals([50, 100, 100, 100]), DEC_10), NOW)
    const text = refreshSummary(verdict, diff)
    expect(text).toContain('REJECTED')
    expect(text).toContain('- **FAIL**: Signals drop by at most 3.0 %: 400 -> 350 (-12.5 %)')
  })

  it('stays well inside a pull request body when thousands of signals change', () => {
    const many = bundle(signals([100, 100, 100, 100]).map((node) => ({ ...node, id: node.id + 50_000 })), DEC_10)
    const { verdict, diff } = judgeRefresh(SHIPPED, many, NOW)
    expect(diff.added).toHaveLength(400)
    const text = refreshSummary(verdict, diff)
    expect(text).toContain('and 360 more')
    expect(text.length).toBeLessThan(20_000)
  })
})

// The script, whole: build, compare, write or refuse.

const temporary: string[] = []
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'routeiq-refresh-'))
  temporary.push(dir)
  return dir
}

/** One extract ("carolina", a square around Charlotte) with `count` signals, dated `date`. */
function extract(count: number, date: number, extra: FixtureNode[] = []): string {
  const dir = join(folder(), 'osm-extracts')
  mkdirSync(dir)
  const nodes: FixtureNode[] = Array.from({ length: count }, (_, n) => ({
    id: 500 + n,
    lng: -80.89 + (n % 20) * 0.004,
    lat: 35.21 + Math.floor(n / 20) * 0.004,
    tags: { highway: 'traffic_signals' },
  }))
  nodes.push(...extra)
  const pbf = pbfFile([nodeBlock(nodes), wayBlock()], { timestampSec: date / 1000 })
  writeFileSync(join(dir, 'carolina-latest.osm.pbf'), pbf)
  writeFileSync(join(dir, 'carolina-latest.osm.pbf.md5'), `${createHash('md5').update(pbf).digest('hex')}\n`)
  const poly = ['none', '1', '  -81.0  35.0', '  -80.5  35.0', '  -80.5  35.5', '  -81.0  35.5', '  -81.0  35.0', 'END', 'END', '']
  writeFileSync(join(dir, 'carolina.poly'), poly.join('\n'))
  return dir
}

/** The shipped bundle: built from a 100-signal extract of Nov 10 into a folder of its own. */
async function shipped(extra: FixtureNode[] = []): Promise<string> {
  const dir = join(folder(), 'osm-signals')
  expect(await buildTiles(['--extracts', extract(100, NOV_10, extra), '--out', dir], { log: () => {} })).toBe(0)
  return dir
}

const snapshot = (dir: string) => Object.fromEntries(readdirSync(dir).sort().map((name) => [name, readFileSync(join(dir, name), 'utf8')]))

async function run(extracts: string, current: string, extra: string[] = []) {
  const out = folder()
  const lines: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (() => Promise.reject(new Error('the refresh script must not use the network'))) as typeof fetch
  try {
    const summary = join(out, 'summary.md')
    const result = join(out, 'result.json')
    const code = await refresh(['--extracts', extracts, '--current', current, '--summary', summary, '--result', result, ...extra], {
      log: (line) => lines.push(line),
      now: NOW,
    })
    return { code, log: lines.join('\n'), summary: readFileSync(summary, 'utf8'), result: JSON.parse(readFileSync(result, 'utf8')) }
  } finally {
    globalThis.fetch = realFetch
  }
}

describe('scripts/refresh-signal-bundle.mjs', () => {
  it('replaces the shipped bundle with a sound newer one and reports what changed', async () => {
    const current = await shipped()
    const { code, summary, result } = await run(extract(102, DEC_10), current)
    expect(code).toBe(EXIT.refreshed)
    expect(result).toEqual({ outcome: 'refreshed', dataDate: '2026-12-10' })
    const index = JSON.parse(readFileSync(join(current, 'index.json'), 'utf8'))
    expect(index.dataDate).toBe(DEC_10)
    expect(index.nodeCount).toBe(102)
    expect(summary).toContain('| Signals | 100 | 102 | +2 |')
    expect(summary).toContain('Added: [600](https://www.openstreetmap.org/node/600), [601](https://www.openstreetmap.org/node/601)')
  })

  it('removes the file of a tile that has no signal any more', async () => {
    // Two signals in a tile of their own (-806_352) are gone a month later; two new ones elsewhere keep the total.
    const lonely: FixtureNode[] = [
      { id: 90, lng: -80.55, lat: 35.25, tags: { highway: 'traffic_signals' } },
      { id: 91, lng: -80.56, lat: 35.26, tags: { highway: 'traffic_signals' } },
    ]
    const current = await shipped(lonely)
    expect(readdirSync(current)).toContain('-806_352.json')
    const { code } = await run(extract(102, DEC_10), current)
    expect(code).toBe(EXIT.refreshed)
    expect(readdirSync(current)).not.toContain('-806_352.json')
  })

  it('refuses when the shipped folder has no index, and writes nothing there', async () => {
    const current = await shipped()
    rmSync(join(current, 'index.json'))
    const before = snapshot(current)
    const { code, summary } = await run(extract(101, DEC_10), current)
    expect(code).toBe(EXIT.rejected)
    expect(summary).toContain('has no index.json')
    expect(snapshot(current)).toEqual(before)
  })

  it('fails closed on a truncated extract: the shipped files stay byte for byte as they were', async () => {
    const current = await shipped()
    const before = snapshot(current)
    const { code, summary, result, log } = await run(extract(60, DEC_10), current)
    expect(code).toBe(EXIT.rejected)
    expect(result.outcome).toBe('rejected')
    expect(log).toContain('Nothing was written.')
    expect(summary).toContain('- **FAIL**: Signals drop by at most 3.0 %: 100 -> 60 (-40.0 %)')
    expect(snapshot(current)).toEqual(before)
  })

  it('does nothing when the extracts are still the shipped ones', async () => {
    const current = await shipped()
    const before = snapshot(current)
    const { code, result } = await run(extract(100, NOV_10), current)
    expect(code).toBe(EXIT.unchanged)
    expect(result.outcome).toBe('unchanged')
    expect(snapshot(current)).toEqual(before)
  })

  it('writes nothing on a dry run that would refresh', async () => {
    const current = await shipped()
    const before = snapshot(current)
    expect((await run(extract(101, DEC_10), current, ['--dry-run'])).code).toBe(EXIT.refreshed)
    expect(snapshot(current)).toEqual(before)
  })

  it('fails when an extract does not match its checksum, and writes nothing', async () => {
    const current = await shipped()
    const before = snapshot(current)
    const extracts = extract(101, DEC_10)
    writeFileSync(join(extracts, 'carolina-latest.osm.pbf.md5'), `${'0'.repeat(32)}\n`)
    const { code, result } = await run(extracts, current)
    expect(code).toBe(EXIT.buildFailed)
    expect(result.outcome).toBe('build-failed')
    expect(snapshot(current)).toEqual(before)
  })
})
