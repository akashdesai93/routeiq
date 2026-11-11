import { deflateSync } from 'node:zlib'

// A tiny .osm.pbf WRITER, for tests only: just enough of the format to build a hand-made extract
// in memory, so the reader in scripts/lib/osm-pbf.mjs can be tested without any downloaded file.
// It is written from the format description (https://wiki.openstreetmap.org/wiki/PBF_Format)
// independently of the reader: the two only share the wire format.

export interface FixtureNode {
  id: number
  lng: number
  lat: number
  tags?: Record<string, string>
}

/** An unsigned varint. BigInt, so 64-bit values (negative int64, large ids) come out right. */
function varint(value: number | bigint): Buffer {
  let n = BigInt.asUintN(64, BigInt(value))
  const bytes: number[] = []
  do {
    const low = Number(n & 0x7fn)
    n >>= 7n
    bytes.push(n > 0n ? low | 0x80 : low)
  } while (n > 0n)
  return Buffer.from(bytes)
}

/** Zigzag coding for sint64: 0, -1, 1, -2 ... become 0, 1, 2, 3 ... */
function zigzag(value: number): bigint {
  const n = BigInt(value)
  return n >= 0n ? n * 2n : -n * 2n - 1n
}

const key = (field: number, wireType: number) => varint(field * 8 + wireType)
const varintField = (field: number, value: number | bigint) => Buffer.concat([key(field, 0), varint(value)])
const bytesField = (field: number, bytes: Uint8Array) => Buffer.concat([key(field, 2), varint(bytes.length), bytes])
const stringField = (field: number, text: string) => bytesField(field, Buffer.from(text, 'utf8'))
const packed = (values: readonly (number | bigint)[]) => Buffer.concat(values.map(varint))

/** Collects strings into a string table; index 0 is the empty string the format reserves. */
function stringTable() {
  const strings = ['']
  return {
    index(text: string): number {
      const at = strings.indexOf(text)
      return at >= 0 ? at : strings.push(text) - 1
    },
    encode: () => Buffer.concat(strings.map((s) => stringField(1, s))),
  }
}

export interface BlockOptions {
  /** Nanodegrees per unit. 100 (the default every real file uses) is 1e-7 degrees. */
  granularity?: number
  /** Nanodegrees added to every latitude and longitude. */
  latOffset?: number
  lonOffset?: number
  /** Write the nodes as plain Node messages instead of DenseNodes. */
  plain?: boolean
}

/** A PrimitiveBlock holding the given nodes, in the order given. */
export function nodeBlock(nodes: readonly FixtureNode[], options: BlockOptions = {}): Buffer {
  const { granularity = 100, latOffset = 0, lonOffset = 0, plain = false } = options
  const strings = stringTable()
  const unit = (degrees: number, offset: number) => Math.round((degrees * 1e9 - offset) / granularity)
  let group: Buffer
  if (plain) {
    group = Buffer.concat(
      nodes.map((node) => {
        const tags = Object.entries(node.tags ?? {})
        return bytesField(
          1,
          Buffer.concat([
            varintField(1, zigzag(node.id)),
            ...(tags.length > 0
              ? [bytesField(2, packed(tags.map(([k]) => strings.index(k)))), bytesField(3, packed(tags.map(([, v]) => strings.index(v))))]
              : []),
            varintField(8, zigzag(unit(node.lat, latOffset))),
            varintField(9, zigzag(unit(node.lng, lonOffset))),
          ]),
        )
      }),
    )
  } else {
    const ids: bigint[] = []
    const lats: bigint[] = []
    const lons: bigint[] = []
    const keysVals: number[] = []
    let previous = { id: 0, lat: 0, lon: 0 }
    for (const node of nodes) {
      const lat = unit(node.lat, latOffset)
      const lon = unit(node.lng, lonOffset)
      // Delta coding: each value is written as its difference from the node before.
      ids.push(zigzag(node.id - previous.id))
      lats.push(zigzag(lat - previous.lat))
      lons.push(zigzag(lon - previous.lon))
      previous = { id: node.id, lat, lon }
      for (const [k, v] of Object.entries(node.tags ?? {})) keysVals.push(strings.index(k), strings.index(v))
      keysVals.push(0)
    }
    const anyTags = keysVals.some((n) => n !== 0)
    group = bytesField(
      2,
      Buffer.concat([
        bytesField(1, packed(ids)),
        bytesField(8, packed(lats)),
        bytesField(9, packed(lons)),
        // A block in which no node has a tag leaves keys_vals out altogether.
        ...(anyTags ? [bytesField(10, packed(keysVals))] : []),
      ]),
    )
  }
  return Buffer.concat([
    bytesField(1, strings.encode()),
    bytesField(2, group),
    ...(granularity !== 100 ? [varintField(17, granularity)] : []),
    ...(latOffset !== 0 ? [varintField(19, latOffset)] : []),
    ...(lonOffset !== 0 ? [varintField(20, lonOffset)] : []),
  ])
}

/** A PrimitiveBlock holding one way (tagged like a road with signals, to tempt a careless reader). */
export function wayBlock(): Buffer {
  const strings = stringTable()
  const way = Buffer.concat([
    varintField(1, 500),
    bytesField(2, packed([strings.index('highway')])),
    bytesField(3, packed([strings.index('traffic_signals')])),
    bytesField(8, packed([zigzag(1), zigzag(1)])),
  ])
  return Buffer.concat([bytesField(1, strings.encode()), bytesField(2, bytesField(3, way))])
}

export interface HeaderOptions {
  /** Seconds since 1970 (osmosis_replication_timestamp). Left out when undefined. */
  timestampSec?: number
  requiredFeatures?: readonly string[]
  /** Declares the file sorted (nodes, then ways, then relations), as Geofabrik extracts are. */
  sorted?: boolean
}

export function headerBlock(options: HeaderOptions = {}): Buffer {
  const { timestampSec, requiredFeatures = ['OsmSchema-V0.6', 'DenseNodes'], sorted = true } = options
  return Buffer.concat([
    ...requiredFeatures.map((feature) => stringField(4, feature)),
    ...(sorted ? [stringField(5, 'Sort.Type_then_ID')] : []),
    stringField(16, 'routeiq-test-fixture'),
    ...(timestampSec === undefined ? [] : [varintField(32, timestampSec)]),
  ])
}

/** One blob as it sits in a file: length, BlobHeader, Blob. Compressed with zlib unless `raw`. */
export function blob(type: 'OSMHeader' | 'OSMData', data: Uint8Array, raw = false): Buffer {
  const body = raw
    ? bytesField(1, data)
    : Buffer.concat([varintField(2, data.length), bytesField(3, deflateSync(data))])
  const header = Buffer.concat([stringField(1, type), varintField(3, body.length)])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(header.length)
  return Buffer.concat([length, header, body])
}

/** A whole file: the header blob, then one data blob per block. */
export function pbfFile(blocks: readonly Uint8Array[], header: HeaderOptions = {}): Buffer {
  return Buffer.concat([blob('OSMHeader', headerBlock(header)), ...blocks.map((block) => blob('OSMData', block))])
}

/** Hands a buffer over in pieces of `size` bytes, the way a file stream would. */
export async function* inChunks(bytes: Uint8Array, size: number): AsyncGenerator<Buffer> {
  for (let at = 0; at < bytes.length; at += size) yield Buffer.from(bytes.subarray(at, at + size))
}
