import type { OsmSignalTile } from './adapter.ts'
import { decodeTileRows, type OsmBundleIndex } from './bundle.ts'

/**
 * The monthly refresh of the bundled signal tiles (scripts/refresh-signal-bundle.mjs, run by
 * .github/workflows/signals-refresh.yml). A fresh build from new extracts is compared with the
 * bundle that ships, and replaces it only when it looks like the same data a month later. A bad
 * extract (truncated, a mass deletion, a broken boundary) must never shrink or corrupt what the
 * app relies on, so every check here fails closed: when one fails, nothing is written and no
 * pull request is opened. This file is the pure part: the rules, the diff and the summary.
 */

/** The limits a refreshed bundle must stay inside. Each one fails closed. */
export const DEFAULT_BUNDLE_REFRESH_CHECKS = {
  /** The signal count may fall by at most this share (OSM grows; a drop means lost data). */
  maxSignalDrop: 0.03,
  /** At most this share of the old signals may disappear, even when as many new ones hide it. */
  maxRemovedShare: 0.05,
  /** The signal count may grow by at most this share (more is a wrong region or an import to look at). */
  maxSignalGrowth: 0.15,
  /** The bundle's bytes may grow by at most this share (it is in the repo and on every deploy). */
  maxBytesGrowth: 0.15,
  /** A tile with at least this many signals is watched on its own... */
  localTileMinSignals: 20,
  /** ...and may lose at most this share of them (a city vanishing while the total looks fine). */
  maxLocalTileDrop: 0.25,
  /** At most this share of the signals that stay may move (a reader or extract defect shifting positions). */
  maxMovedShare: 0.05,
  /**
   * Tiles that may join the covered set: none. A covered tile without a file is "0 signals" to the
   * app, so a boundary larger than its extract would show 0 where the data was clipped.
   */
  maxCoveredTilesGained: 0,
  /** Tiles that may leave the covered set: none. Safe for the app (it asks Overpass), but a sign the boundary is damaged. */
  maxCoveredTilesLost: 0,
  /** A data date further ahead of the clock than this is wrong, in milliseconds. */
  maxFutureMs: 24 * 60 * 60 * 1000,
} as const

export type BundleRefreshChecks = { readonly [K in keyof typeof DEFAULT_BUNDLE_REFRESH_CHECKS]: number }

/** A bundle folder as read from disk. */
export interface BundleSnapshot {
  readonly index: OsmBundleIndex
  /** The tile files in the folder, whatever their names (each checked against its name). */
  readonly tiles: readonly { readonly fileName: string; readonly tile: OsmSignalTile }[]
  /** Files in the folder that are neither a tile, index.json nor LICENSE.md, or a tile that could not be read. */
  readonly unreadable: readonly string[]
  /** Bytes of all the bundle's files together. */
  readonly bytes: number
}

/** What is wrong with a bundle on its own, before any comparison. Empty when it is sound. */
export function bundleProblems(bundle: BundleSnapshot): string[] {
  const problems: string[] = []
  for (const name of bundle.unreadable) problems.push(`${name} is not a readable tile file.`)
  const listed = new Set(decodeTileRows(bundle.index.files))
  const present = new Set<string>()
  const ids = new Set<number>()
  for (const { fileName, tile } of bundle.tiles) {
    if (fileName !== `${tile.tileId}.json`) problems.push(`${fileName} holds tile ${tile.tileId}.`)
    if (tile.fetchedAt !== bundle.index.dataDate) problems.push(`${fileName} is dated differently from the index.`)
    if (tile.nodes.length === 0) problems.push(`${fileName} has no signals (an empty tile has no file).`)
    if (!listed.has(tile.tileId)) problems.push(`${fileName} is not listed in the index.`)
    present.add(tile.tileId)
    for (const node of tile.nodes) ids.add(node.id)
  }
  const missing = [...listed].filter((id) => !present.has(id))
  if (missing.length > 0) problems.push(`The index lists ${missing.length} tile files that are missing (${missing.slice(0, 5).join(', ')}).`)
  if (ids.size !== bundle.index.nodeCount) problems.push(`The index says ${bundle.index.nodeCount} signals; the files hold ${ids.size}.`)
  if (bundle.index.extracts.length === 0) problems.push('The index names no extract.')
  return problems
}

interface Point {
  readonly lng: number
  readonly lat: number
}

function signalsOf(bundle: BundleSnapshot): Map<number, Point> {
  const byId = new Map<number, Point>()
  for (const { tile } of bundle.tiles) for (const node of tile.nodes) byId.set(node.id, { lng: node.lng, lat: node.lat })
  return byId
}

function countsByTile(bundle: BundleSnapshot): Map<string, number> {
  return new Map(bundle.tiles.map(({ tile }) => [tile.tileId, tile.nodes.length]))
}

export interface TileChange {
  readonly tileId: string
  readonly before: number
  readonly after: number
}

/** What changed between the bundle that ships and a fresh build. */
export interface BundleDiff {
  readonly before: BundleTotals
  readonly after: BundleTotals
  /** OSM node ids, sorted. */
  readonly added: readonly number[]
  readonly removed: readonly number[]
  /** Same node id, new position. */
  readonly moved: readonly number[]
  /** Tiles whose signal count changed (a new or a dropped file included), largest change first. */
  readonly tiles: readonly TileChange[]
  readonly coveredLost: readonly string[]
  readonly coveredGained: readonly string[]
}

export interface BundleTotals {
  readonly dataDate: number
  readonly extracts: readonly string[]
  readonly signals: number
  readonly tileFiles: number
  readonly coveredTiles: number
  readonly bytes: number
}

function totals(bundle: BundleSnapshot): BundleTotals {
  return {
    dataDate: bundle.index.dataDate,
    extracts: bundle.index.extracts.map((extract) => extract.name).sort(),
    signals: signalsOf(bundle).size,
    tileFiles: bundle.tiles.length,
    coveredTiles: decodeTileRows(bundle.index.covered).length,
    bytes: bundle.bytes,
  }
}

const byNumber = (a: number, b: number) => a - b

export function diffBundles(before: BundleSnapshot, after: BundleSnapshot): BundleDiff {
  const old = signalsOf(before)
  const next = signalsOf(after)
  const added = [...next.keys()].filter((id) => !old.has(id)).sort(byNumber)
  const removed = [...old.keys()].filter((id) => !next.has(id)).sort(byNumber)
  const moved = [...next.entries()]
    .filter(([id, point]) => {
      const was = old.get(id)
      return was !== undefined && (was.lng !== point.lng || was.lat !== point.lat)
    })
    .map(([id]) => id)
    .sort(byNumber)

  const oldCounts = countsByTile(before)
  const newCounts = countsByTile(after)
  const tiles: TileChange[] = []
  for (const tileId of new Set([...oldCounts.keys(), ...newCounts.keys()])) {
    const change = { tileId, before: oldCounts.get(tileId) ?? 0, after: newCounts.get(tileId) ?? 0 }
    if (change.before !== change.after) tiles.push(change)
  }
  tiles.sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before) || (a.tileId < b.tileId ? -1 : 1))

  const oldCovered = new Set(decodeTileRows(before.index.covered))
  const newCovered = new Set(decodeTileRows(after.index.covered))
  return {
    before: totals(before),
    after: totals(after),
    added,
    removed,
    moved,
    tiles,
    coveredLost: [...oldCovered].filter((id) => !newCovered.has(id)).sort(),
    coveredGained: [...newCovered].filter((id) => !oldCovered.has(id)).sort(),
  }
}

export interface RefreshCheck {
  readonly name: string
  readonly pass: boolean
  /** What was measured, against what limit. */
  readonly detail: string
}

export type RefreshVerdict =
  /** Newer data, every check passed: write it and open a pull request. */
  | { readonly kind: 'refresh'; readonly checks: readonly RefreshCheck[] }
  /** The data is no newer than what ships: nothing to do. */
  | { readonly kind: 'unchanged'; readonly checks: readonly RefreshCheck[] }
  /** A check failed: write nothing, open nothing, and say why. */
  | { readonly kind: 'reject'; readonly checks: readonly RefreshCheck[] }

const percent = (share: number) => `${(share * 100).toFixed(1)} %`
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/**
 * Decides what to do with a fresh build. `now` is the clock, in milliseconds. Every check is
 * run and reported, so a rejected refresh shows all that is wrong at once. A broken bundle on
 * either side is a rejection: a bundle that cannot be read cannot be compared.
 */
export function judgeRefresh(
  before: BundleSnapshot,
  after: BundleSnapshot,
  now: number,
  limits: BundleRefreshChecks = DEFAULT_BUNDLE_REFRESH_CHECKS,
): { readonly verdict: RefreshVerdict; readonly diff: BundleDiff } {
  const diff = diffBundles(before, after)
  const { before: was, after: is } = diff
  const checks: RefreshCheck[] = []
  const check = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail })

  const shippedProblems = bundleProblems(before)
  check('The bundle that ships is sound', shippedProblems.length === 0, shippedProblems.join(' ') || 'index and files agree')
  const newProblems = bundleProblems(after)
  check('The new bundle is sound', newProblems.length === 0, newProblems.join(' ') || 'index and files agree')

  const sameRegions = was.extracts.join(',') === is.extracts.join(',')
  check('Same extracts', sameRegions, `${was.extracts.join(', ')} -> ${is.extracts.join(', ')}`)

  check(
    'Data date is not in the future',
    is.dataDate <= now + limits.maxFutureMs,
    `${day(is.dataDate)}, today ${day(now)}`,
  )
  check('Data date does not go backwards', is.dataDate >= was.dataDate, `${day(was.dataDate)} -> ${day(is.dataDate)}`)

  const change = was.signals === 0 ? (is.signals === 0 ? 0 : Infinity) : (is.signals - was.signals) / was.signals
  check(
    `Signals drop by at most ${percent(limits.maxSignalDrop)}`,
    was.signals > 0 && change >= -limits.maxSignalDrop,
    `${was.signals} -> ${is.signals} (${change >= 0 ? '+' : ''}${percent(change)})`,
  )
  check(
    `Signals grow by at most ${percent(limits.maxSignalGrowth)}`,
    change <= limits.maxSignalGrowth,
    `${was.signals} -> ${is.signals}`,
  )
  const removedShare = was.signals === 0 ? 0 : diff.removed.length / was.signals
  check(
    `At most ${percent(limits.maxRemovedShare)} of the signals removed`,
    removedShare <= limits.maxRemovedShare,
    `${diff.removed.length} removed (${percent(removedShare)}), ${diff.added.length} added`,
  )

  const holes = diff.tiles.filter(
    (tile) => tile.before >= limits.localTileMinSignals && (tile.before - tile.after) / tile.before > limits.maxLocalTileDrop,
  )
  check(
    `No tile with ${limits.localTileMinSignals}+ signals loses more than ${percent(limits.maxLocalTileDrop)}`,
    holes.length === 0,
    holes.length === 0
      ? 'none'
      : holes
          .slice(0, 10)
          .map((tile) => `${tile.tileId} ${tile.before} -> ${tile.after}`)
          .join(', '),
  )

  const kept = is.signals - diff.added.length
  const movedShare = kept <= 0 ? 0 : diff.moved.length / kept
  check(
    `At most ${percent(limits.maxMovedShare)} of the signals moved`,
    movedShare <= limits.maxMovedShare,
    `${diff.moved.length} moved (${percent(movedShare)})`,
  )

  check(
    'The covered tiles stay the same',
    diff.coveredLost.length <= limits.maxCoveredTilesLost && diff.coveredGained.length <= limits.maxCoveredTilesGained,
    `${was.coveredTiles} -> ${is.coveredTiles} (${diff.coveredLost.length} lost${diff.coveredLost.length > 0 ? `: ${diff.coveredLost.slice(0, 10).join(', ')}` : ''}, ${diff.coveredGained.length} gained${diff.coveredGained.length > 0 ? `: ${diff.coveredGained.slice(0, 10).join(', ')}` : ''})`,
  )

  const bytesGrowth = was.bytes === 0 ? Infinity : (is.bytes - was.bytes) / was.bytes
  check(
    `Bytes grow by at most ${percent(limits.maxBytesGrowth)}`,
    bytesGrowth <= limits.maxBytesGrowth,
    `${kiB(was.bytes)} -> ${kiB(is.bytes)}`,
  )

  const failed = checks.some((item) => !item.pass)
  const kind = failed ? 'reject' : is.dataDate === was.dataDate ? 'unchanged' : 'refresh'
  return { verdict: { kind, checks }, diff }
}

const kiB = (bytes: number) => `${(bytes / 1024).toFixed(0)} KiB`
const signed = (n: number) => (n > 0 ? `+${n}` : String(n))

/** How many ids and tiles the summary lists before it says "and N more" (a PR body holds 65,536 characters). */
export const SUMMARY_LIST_LIMIT = 40

function nodeLinks(ids: readonly number[]): string {
  const shown = ids.slice(0, SUMMARY_LIST_LIMIT).map((id) => `[${id}](https://www.openstreetmap.org/node/${id})`)
  const more = ids.length - shown.length
  return ids.length === 0 ? 'none' : `${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''}`
}

/** The before/after report, in Markdown: the workflow's run summary and the pull request's body. */
export function refreshSummary(verdict: RefreshVerdict, diff: BundleDiff): string {
  const { before: was, after: is } = diff
  const heading =
    verdict.kind === 'refresh'
      ? `Signal bundle refresh: data of ${day(is.dataDate)} (was ${day(was.dataDate)})`
      : verdict.kind === 'unchanged'
        ? `Signal bundle refresh: nothing to do (the extracts are still of ${day(is.dataDate)})`
        : 'Signal bundle refresh REJECTED: the new data looks wrong, nothing was written'
  const row = (label: string, a: string | number, b: string | number, delta = '') => `| ${label} | ${a} | ${b} | ${delta} |`
  const lines = [
    `## ${heading}`,
    '',
    '| | Before | After | Change |',
    '| --- | --- | --- | --- |',
    row('Data date', day(was.dataDate), day(is.dataDate)),
    row('Extracts', was.extracts.join(', '), is.extracts.join(', ')),
    row('Signals', was.signals, is.signals, signed(is.signals - was.signals)),
    row('Tile files', was.tileFiles, is.tileFiles, signed(is.tileFiles - was.tileFiles)),
    row('Covered tiles', was.coveredTiles, is.coveredTiles, signed(is.coveredTiles - was.coveredTiles)),
    row('Size', kiB(was.bytes), kiB(is.bytes), signed(Math.round((is.bytes - was.bytes) / 1024)) + ' KiB'),
    '',
    `Signals added: ${diff.added.length}, removed: ${diff.removed.length}, moved: ${diff.moved.length}.`,
    '',
    '### Checks',
    '',
    ...verdict.checks.map((item) => `- ${item.pass ? 'pass' : '**FAIL**'}: ${item.name}: ${item.detail}`),
    '',
    `### Tiles whose count changed (${diff.tiles.length})`,
    '',
  ]
  if (diff.tiles.length === 0) lines.push('None.')
  else {
    lines.push('| Tile | Before | After | Change |', '| --- | --- | --- | --- |')
    for (const tile of diff.tiles.slice(0, SUMMARY_LIST_LIMIT)) lines.push(row(tile.tileId, tile.before, tile.after, signed(tile.after - tile.before)))
    if (diff.tiles.length > SUMMARY_LIST_LIMIT) lines.push('', `And ${diff.tiles.length - SUMMARY_LIST_LIMIT} more tiles with smaller changes.`)
  }
  lines.push(
    '',
    '### Signals added and removed (OpenStreetMap node ids)',
    '',
    `Added: ${nodeLinks(diff.added)}`,
    '',
    `Removed: ${nodeLinks(diff.removed)}`,
    '',
  )
  if (diff.coveredLost.length + diff.coveredGained.length > 0) {
    lines.push(`Covered tiles lost: ${diff.coveredLost.join(', ') || 'none'}. Gained: ${diff.coveredGained.join(', ') || 'none'}.`, '')
  }
  return lines.join('\n')
}
