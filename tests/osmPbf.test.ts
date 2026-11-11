import { describe, expect, it } from 'vitest'
import { collectTaggedNodes, nodesWithTag, parseHeaderBlock, readBlobs } from '../scripts/lib/osm-pbf.mjs'
import { blob, headerBlock, inChunks, nodeBlock, pbfFile, wayBlock, type FixtureNode } from './helpers/pbf.ts'

// The .osm.pbf reader, against extracts built by hand in the test itself (tests/helpers/pbf.ts
// writes them from the format description). No downloaded file is needed and nothing touches
// the network. Positions are made up, in the four quadrants of the globe.

const SIGNAL = { highway: 'traffic_signals' }

/** Nodes with big ids, out of id order, and with negative as well as positive coordinates. */
const NODES: FixtureNode[] = [
  { id: 172130323, lng: -80.8431297, lat: 35.2270082 },
  { id: 172130392, lng: -80.8433306, lat: 35.2275889, tags: { highway: 'traffic_signals', traffic_signals: 'signal' } },
  // An id past 2^32, as current OpenStreetMap node ids are.
  { id: 12_345_678_901, lng: -80.8093306, lat: 35.275889, tags: { highway: 'crossing', crossing: 'traffic_signals' } },
  // Going back down in id and position: the deltas are negative.
  { id: 9_000_000_001, lng: -80.9, lat: 35.2, tags: { name: 'Café Ünïcode', highway: 'traffic_signals' } },
  { id: 9_000_000_002, lng: 151.2093, lat: -33.8568, tags: SIGNAL },
  { id: 9_000_000_003, lng: -58.3816, lat: -34.6037, tags: SIGNAL },
  { id: 9_000_000_004, lng: 2.3522, lat: 48.8566, tags: { amenity: 'cafe' } },
  { id: 9_000_000_005, lng: 0, lat: 0, tags: SIGNAL },
]

const signalsOf = (block: Uint8Array) => nodesWithTag(block, 'highway', ['traffic_signals'])

describe('nodesWithTag: DenseNodes', () => {
  it('decodes delta-coded ids and coordinates, negative ones included, with every tag of the node', () => {
    const found = signalsOf(nodeBlock(NODES))
    expect(found.nodeCount).toBe(8)
    expect(found.hasNodes).toBe(true)
    expect(found.hasWays).toBe(false)
    expect(found.matches).toEqual([
      { id: 172130392, lng: -80.8433306, lat: 35.2275889, tags: { highway: 'traffic_signals', traffic_signals: 'signal' } },
      { id: 9_000_000_001, lng: -80.9, lat: 35.2, tags: { name: 'Café Ünïcode', highway: 'traffic_signals' } },
      { id: 9_000_000_002, lng: 151.2093, lat: -33.8568, tags: SIGNAL },
      { id: 9_000_000_003, lng: -58.3816, lat: -34.6037, tags: SIGNAL },
      { id: 9_000_000_005, lng: 0, lat: 0, tags: SIGNAL },
    ])
  })

  it('matches on the key and the value together, and on any of several values', () => {
    const block = nodeBlock(NODES)
    // highway=crossing with crossing=traffic_signals is not highway=traffic_signals.
    expect(signalsOf(block).matches.map((n) => n.id)).not.toContain(12_345_678_901)
    const both = nodesWithTag(block, 'highway', ['traffic_signals', 'crossing'])
    expect(both.matches.map((n) => n.id)).toContain(12_345_678_901)
    expect(both.matches).toHaveLength(6)
    // The value under another key, or the key with another value, is no match.
    expect(nodesWithTag(block, 'crossing', ['signal']).matches).toEqual([])
    expect(nodesWithTag(block, 'amenity', ['cafe']).matches.map((n) => n.id)).toEqual([9_000_000_004])
  })

  it('only counts a block that cannot hold a match', () => {
    const untagged = nodeBlock(NODES.map(({ id, lng, lat }) => ({ id, lng, lat })))
    expect(signalsOf(untagged)).toMatchObject({ nodeCount: 8, hasNodes: true, matches: [] })
    const other = nodeBlock([{ id: 1, lng: 1, lat: 1, tags: { highway: 'stop' } }])
    expect(signalsOf(other)).toMatchObject({ nodeCount: 1, matches: [] })
  })

  it('applies granularity and the latitude and longitude offsets', () => {
    const nodes: FixtureNode[] = [
      { id: 5, lng: -80.85, lat: 35.25, tags: SIGNAL },
      { id: 6, lng: -80.86, lat: -35.26, tags: SIGNAL },
    ]
    for (const options of [
      { granularity: 1000 },
      { granularity: 100, latOffset: 500, lonOffset: -500 },
      { granularity: 10_000, latOffset: -35_000_000_000, lonOffset: 80_000_000_000 },
    ]) {
      expect(signalsOf(nodeBlock(nodes, options)).matches.map(({ id, lng, lat }) => [id, lng, lat])).toEqual([
        [5, -80.85, 35.25],
        [6, -80.86, -35.26],
      ])
    }
  })
})

describe('nodesWithTag: plain nodes, ways', () => {
  it('reads plain Node messages the same way', () => {
    const found = signalsOf(nodeBlock(NODES, { plain: true }))
    expect(found.nodeCount).toBe(8)
    expect(found.matches).toEqual(signalsOf(nodeBlock(NODES)).matches)
  })

  it('skips a block of ways without decoding it, even one tagged like a signal', () => {
    expect(signalsOf(wayBlock())).toEqual({ nodeCount: 0, hasNodes: false, hasWays: true, hasRelations: false, matches: [] })
  })
})

describe('readBlobs and parseHeaderBlock', () => {
  it('frames blobs from a stream however it is cut up, zlib or raw', async () => {
    const file = Buffer.concat([
      blob('OSMHeader', headerBlock({ timestampSec: 1_794_345_699 })),
      blob('OSMData', nodeBlock(NODES)),
      blob('OSMData', nodeBlock(NODES.slice(0, 2)), true),
    ])
    for (const size of [1, 7, 64, file.length]) {
      const types: string[] = []
      let matches = 0
      for await (const { type, data } of readBlobs(inChunks(file, size))) {
        types.push(type)
        if (type === 'OSMData') matches += signalsOf(data).matches.length
      }
      expect(types).toEqual(['OSMHeader', 'OSMData', 'OSMData'])
      expect(matches).toBe(6)
    }
  })

  it('reads the features, the sort order and the date of the data from the header', () => {
    const header = parseHeaderBlock(headerBlock({ timestampSec: 1_794_345_699 }))
    expect(header.requiredFeatures).toEqual(['OsmSchema-V0.6', 'DenseNodes'])
    expect(header.sortedByType).toBe(true)
    expect(header.replicationTimestampSec).toBe(1_794_345_699)
    expect(header.writingProgram).toBe('routeiq-test-fixture')
    expect(parseHeaderBlock(headerBlock({ sorted: false }))).toMatchObject({ sortedByType: false, replicationTimestampSec: null })
  })

  it('refuses a file that needs a feature it does not have, a cut-off file and a file that is not one', async () => {
    expect(() => parseHeaderBlock(headerBlock({ requiredFeatures: ['OsmSchema-V0.6', 'HistoricalInformation'] }))).toThrow(
      /HistoricalInformation/,
    )
    const file = pbfFile([nodeBlock(NODES)])
    const drain = async (bytes: Uint8Array) => {
      for await (const each of readBlobs(inChunks(bytes, 50))) void each
    }
    await expect(drain(file.subarray(0, file.length - 3))).rejects.toThrow(/middle of a blob/)
    await expect(drain(Buffer.from('<?xml version="1.0"?><osm></osm>'))).rejects.toThrow(/not an \.osm\.pbf/)
    await expect(drain(Buffer.alloc(0))).resolves.toBeUndefined()
  })
})

describe('collectTaggedNodes', () => {
  const options = { key: 'highway', values: ['traffic_signals'] }

  it('collects the matches of every block and stops at the first block of ways in a sorted file', async () => {
    let pulled = 0
    const file = pbfFile([nodeBlock(NODES.slice(0, 4)), nodeBlock(NODES.slice(4)), wayBlock(), nodeBlock(NODES)], {
      timestampSec: 1_794_345_699,
    })
    async function* counted() {
      for await (const chunk of inChunks(file, 32)) {
        pulled += chunk.length
        yield chunk
      }
    }
    const scan = await collectTaggedNodes(counted(), options)
    expect(scan.nodes.map((n) => n.id)).toEqual([172130392, 9_000_000_001, 9_000_000_002, 9_000_000_003, 9_000_000_005])
    expect(scan.nodeCount).toBe(8)
    expect(scan.blocks).toBe(3)
    expect(scan.stoppedEarly).toBe(true)
    expect(scan.header.replicationTimestampSec).toBe(1_794_345_699)
    // It streams: the block after the ways was never pulled from the file.
    expect(pulled).toBeLessThan(file.length - 32)
  })

  it('reads to the end of a file that does not promise an order', async () => {
    const file = pbfFile([wayBlock(), nodeBlock(NODES)], { sorted: false })
    const scan = await collectTaggedNodes(inChunks(file, 4096), options)
    expect(scan.stoppedEarly).toBe(false)
    expect(scan.nodes).toHaveLength(5)
  })

  it('rejects a file without a header', async () => {
    await expect(collectTaggedNodes(inChunks(blob('OSMData', nodeBlock(NODES)), 64), options)).rejects.toThrow(/header/)
  })
})
