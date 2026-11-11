// A minimal streaming reader for OpenStreetMap .osm.pbf files: just enough to pull tagged nodes
// out of a regional extract. Plain Node, no dependencies.
//
// The format (https://wiki.openstreetmap.org/wiki/PBF_Format) is a sequence of blobs:
//
//   4 bytes   length of the BlobHeader, big-endian
//   BlobHeader  { type = 1 (string: "OSMHeader" | "OSMData"), datasize = 3 }
//   Blob        { raw = 1 | zlib_data = 3 | zstd_data = 7, raw_size = 2 }
//
// The first blob holds a HeaderBlock, every other one a PrimitiveBlock of about 8,000 entities:
//
//   PrimitiveBlock { stringtable = 1, primitivegroup = 2 (repeated), granularity = 17,
//                    lat_offset = 19, lon_offset = 20 }
//   PrimitiveGroup { nodes = 1, dense = 2, ways = 3, relations = 4, changesets = 5 }
//   DenseNodes     { id = 1, lat = 8, lon = 9 (packed sint64, delta coded), keys_vals = 10 (packed
//                    int32: key, value, key, value, 0 for each node in turn) }
//   Node           { id = 1 (sint64), keys = 2, vals = 3 (packed uint32), lat = 8, lon = 9 (sint64) }
//
// A coordinate is 1e-9 * (offset + granularity * value) degrees. Ways and relations are skipped
// without being decoded. Nothing here holds more than one blob in memory.

import * as zlib from 'node:zlib'

/** The largest blob the format allows (32 MiB), and the largest header (64 KiB). */
const MAX_BLOB_BYTES = 32 * 1024 * 1024
const MAX_BLOB_HEADER_BYTES = 64 * 1024

/** Features a file may require of its reader. Anything else is refused rather than misread. */
const SUPPORTED_FEATURES = new Set(['OsmSchema-V0.6', 'DenseNodes'])

/** Walks protobuf wire format in a Buffer, between `pos` and `end`. */
class Reader {
  constructor(buf, pos = 0, end = buf.length) {
    this.buf = buf
    this.pos = pos
    this.end = end
  }

  /**
   * An unsigned varint as a Number: exact up to 2^53, which covers node ids, lengths, string
   * indexes and zigzag-coded coordinates.
   */
  varint() {
    const buf = this.buf
    let byte = buf[this.pos++]
    if (byte < 0x80) return byte
    let result = byte & 0x7f
    let scale = 128
    do {
      if (this.pos > this.end) throw new Error('PBF: a number runs past the end of its message')
      byte = buf[this.pos++]
      result += (byte & 0x7f) * scale
      scale *= 128
    } while (byte >= 0x80)
    return result
  }

  /** A zigzag-coded signed varint (sint32, sint64). */
  svarint() {
    const n = this.varint()
    return n % 2 === 0 ? n / 2 : -(n + 1) / 2
  }

  /**
   * A two's-complement signed varint (int64). A negative value takes ten bytes, more than a
   * Number holds exactly, so those are put together as a BigInt first.
   */
  int64() {
    const start = this.pos
    const n = this.varint()
    if (this.pos - start < 8) return n
    let big = 0n
    for (let i = this.pos - 1; i >= start; i--) big = (big << 7n) | BigInt(this.buf[i] & 0x7f)
    return Number(BigInt.asIntN(64, big))
  }

  /** The [start, end) of a length-delimited field, leaving the reader after it. */
  span() {
    const length = this.varint()
    const start = this.pos
    const end = start + length
    if (end > this.end) throw new Error('PBF: a field runs past the end of its message')
    this.pos = end
    return [start, end]
  }

  skip(wireType) {
    if (wireType === 0) this.varint()
    else if (wireType === 1) this.pos += 8
    else if (wireType === 2) this.span()
    else if (wireType === 5) this.pos += 4
    else throw new Error(`PBF: unsupported wire type ${wireType}`)
  }
}

/**
 * Calls `visit(field, wireType, reader)` for every field of the message in buf[start, end).
 * The visitor must consume the field (or return false to have it skipped).
 */
function eachField(buf, start, end, visit) {
  const r = new Reader(buf, start, end)
  while (r.pos < end) {
    const tag = r.varint()
    const field = Math.floor(tag / 8)
    const wireType = tag % 8
    if (visit(field, wireType, r) === false) r.skip(wireType)
  }
}

function decompress(blob) {
  let raw = null
  let packed = null
  let method = ''
  eachField(blob, 0, blob.length, (field, wireType, r) => {
    if (wireType !== 2) return false
    const [start, end] = r.span()
    if (field === 1) raw = blob.subarray(start, end)
    else if (field === 3) [packed, method] = [blob.subarray(start, end), 'zlib']
    else if (field === 7) [packed, method] = [blob.subarray(start, end), 'zstd']
    else if (field === 4 || field === 6) method = field === 4 ? 'lzma' : 'lz4'
    return true
  })
  if (raw !== null) return raw
  if (method === 'zlib') return zlib.inflateSync(packed, { maxOutputLength: MAX_BLOB_BYTES })
  if (method === 'zstd' && typeof zlib.zstdDecompressSync === 'function') {
    return zlib.zstdDecompressSync(packed, { maxOutputLength: MAX_BLOB_BYTES })
  }
  throw new Error(`PBF: blob compression ${method === '' ? 'missing' : `"${method}"`} is not supported`)
}

/**
 * Reads the blobs of a .osm.pbf file one at a time from a stream of Buffers (for example
 * fs.createReadStream). Yields `{ type, data }`: the blob type ("OSMHeader" or "OSMData") and
 * its decompressed bytes. Stops reading as soon as the consumer stops asking.
 * @param {AsyncIterable<Uint8Array>} source
 */
export async function* readBlobs(source) {
  const chunks = source[Symbol.asyncIterator]()
  let pending = Buffer.alloc(0)
  /** The next n bytes, or null at a clean end of file (nothing left at all). */
  const take = async (n) => {
    if (pending.length < n) {
      const parts = [pending]
      let have = pending.length
      while (have < n) {
        const { value, done } = await chunks.next()
        if (done) {
          if (have === 0) return null
          throw new Error('PBF: the file ends in the middle of a blob')
        }
        parts.push(value)
        have += value.length
      }
      pending = Buffer.concat(parts)
    }
    const out = pending.subarray(0, n)
    pending = pending.subarray(n)
    return out
  }

  try {
    for (;;) {
      const lengthBytes = await take(4)
      if (lengthBytes === null) return
      const headerLength = lengthBytes.readUInt32BE(0)
      if (headerLength > MAX_BLOB_HEADER_BYTES) throw new Error('PBF: not an .osm.pbf file (blob header too large)')
      const header = await take(headerLength)
      if (header === null) throw new Error('PBF: the file ends in the middle of a blob')
      let type = ''
      let dataSize = -1
      eachField(header, 0, header.length, (field, wireType, r) => {
        if (field === 1 && wireType === 2) {
          const [start, end] = r.span()
          type = header.toString('utf8', start, end)
        } else if (field === 3 && wireType === 0) dataSize = r.varint()
        else return false
        return true
      })
      if (dataSize < 0 || dataSize > MAX_BLOB_BYTES) throw new Error('PBF: not an .osm.pbf file (bad blob size)')
      const blob = await take(dataSize)
      if (blob === null) throw new Error('PBF: the file ends in the middle of a blob')
      yield { type, data: decompress(blob) }
    }
  } finally {
    await chunks.return?.()
  }
}

/**
 * Reads a HeaderBlock (the data of the "OSMHeader" blob). Throws when the file needs a feature
 * this reader does not have.
 * @param {Uint8Array} data
 */
export function parseHeaderBlock(data) {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  const header = {
    /** [west, south, east, north] in degrees, or null when the file gives none. */
    bbox: null,
    requiredFeatures: [],
    optionalFeatures: [],
    writingProgram: null,
    source: null,
    /** When the data was current, in seconds since 1970 (osmosis_replication_timestamp), or null. */
    replicationTimestampSec: null,
    /** True when the file promises nodes first, then ways, then relations. */
    sortedByType: false,
  }
  eachField(buf, 0, buf.length, (field, wireType, r) => {
    if (field === 32 && wireType === 0) header.replicationTimestampSec = r.int64()
    else if (wireType !== 2) return false
    else {
      const [start, end] = r.span()
      const text = () => buf.toString('utf8', start, end)
      if (field === 1) {
        const box = { 1: 0, 2: 0, 3: 0, 4: 0 }
        eachField(buf, start, end, (f, w, br) => {
          if (w !== 0 || !(f in box)) return false
          box[f] = br.svarint() / 1e9
          return true
        })
        // HeaderBBox is left, right, top, bottom.
        header.bbox = [box[1], box[4], box[2], box[3]]
      } else if (field === 4) header.requiredFeatures.push(text())
      else if (field === 5) header.optionalFeatures.push(text())
      else if (field === 16) header.writingProgram = text()
      else if (field === 17) header.source = text()
    }
    return true
  })
  const unsupported = header.requiredFeatures.filter((feature) => !SUPPORTED_FEATURES.has(feature))
  if (unsupported.length > 0) throw new Error(`PBF: the file needs unsupported features: ${unsupported.join(', ')}`)
  header.sortedByType = header.optionalFeatures.includes('Sort.Type_then_ID')
  return header
}

/** Number of varints in buf[start, end): every varint ends in exactly one byte below 0x80. */
function countVarints(buf, start, end) {
  let count = 0
  for (let i = start; i < end; i++) if (buf[i] < 0x80) count++
  return count
}

/**
 * Finds, in one PrimitiveBlock (the data of an "OSMData" blob), every node that carries the tag
 * `key` with one of `values`, and returns it with all of its tags. Blocks whose string table
 * lacks the key or all of the values (nearly all of them) are only counted, not decoded.
 *
 * @param {Uint8Array} data
 * @param {string} key for example "highway"
 * @param {readonly string[]} values for example ["traffic_signals"]
 * @returns {{ nodeCount: number, hasNodes: boolean, hasWays: boolean, hasRelations: boolean,
 *             matches: { id: number, lng: number, lat: number, tags: Record<string, string> }[] }}
 */
export function nodesWithTag(data, key, values) {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  const result = { nodeCount: 0, hasNodes: false, hasWays: false, hasRelations: false, matches: [] }
  let stringTable = null
  const groups = []
  let granularity = 100
  let latOffset = 0
  let lonOffset = 0
  eachField(buf, 0, buf.length, (field, wireType, r) => {
    if (field === 1 && wireType === 2) stringTable = r.span()
    else if (field === 2 && wireType === 2) groups.push(r.span())
    else if (field === 17 && wireType === 0) granularity = r.varint()
    else if (field === 19 && wireType === 0) latOffset = r.int64()
    else if (field === 20 && wireType === 0) lonOffset = r.int64()
    else return false
    return true
  })

  // The string table: where each string is, and the indexes of the key and the values wanted.
  const strings = []
  let keyIndex = -1
  const valueIndexes = new Set()
  if (stringTable !== null) {
    const wantedKey = Buffer.from(key, 'utf8')
    const wantedValues = values.map((value) => Buffer.from(value, 'utf8'))
    eachField(buf, stringTable[0], stringTable[1], (field, wireType, r) => {
      if (field !== 1 || wireType !== 2) return false
      const [start, end] = r.span()
      const index = strings.length
      strings.push(start, end)
      const length = end - start
      if (length === wantedKey.length && buf.compare(wantedKey, 0, length, start, end) === 0) keyIndex = index / 2
      for (const wanted of wantedValues) {
        if (length === wanted.length && buf.compare(wanted, 0, length, start, end) === 0) valueIndexes.add(index / 2)
      }
      return true
    })
  }
  const possible = keyIndex >= 0 && valueIndexes.size > 0
  const stringAt = (index) => {
    const start = strings[index * 2]
    if (start === undefined) throw new Error('PBF: a tag points outside the string table')
    return buf.toString('utf8', start, strings[index * 2 + 1])
  }
  const degrees = (offset, value) => Math.round((offset + granularity * value) / 100) / 1e7

  const dense = (start, end) => {
    let ids = null
    let lats = null
    let lons = null
    let keysVals = null
    eachField(buf, start, end, (field, wireType, r) => {
      if (wireType !== 2) return false
      const span = r.span()
      if (field === 1) ids = span
      else if (field === 8) lats = span
      else if (field === 9) lons = span
      else if (field === 10) keysVals = span
      return true
    })
    if (ids === null) return
    result.nodeCount += countVarints(buf, ids[0], ids[1])
    if (!possible || keysVals === null || lats === null || lons === null) return

    // Pass 1 over keys_vals: which nodes (by position) carry the tag, and where their tags start.
    const wanted = []
    const kv = new Reader(buf, keysVals[0], keysVals[1])
    let node = 0
    let runStart = kv.pos
    let hit = false
    while (kv.pos < kv.end) {
      const k = kv.varint()
      if (k === 0) {
        if (hit) wanted.push(node, runStart)
        node++
        runStart = kv.pos
        hit = false
        continue
      }
      const v = kv.varint()
      if (k === keyIndex && valueIndexes.has(v)) hit = true
    }
    if (wanted.length === 0) return

    // Pass 2: ids and coordinates are running sums, so decode up to the last node wanted.
    const idReader = new Reader(buf, ids[0], ids[1])
    const latReader = new Reader(buf, lats[0], lats[1])
    const lonReader = new Reader(buf, lons[0], lons[1])
    let id = 0
    let lat = 0
    let lon = 0
    let at = 0
    for (let w = 0; w < wanted.length; w += 2) {
      const target = wanted[w]
      for (; at <= target; at++) {
        id += idReader.svarint()
        lat += latReader.svarint()
        lon += lonReader.svarint()
      }
      const tags = {}
      const run = new Reader(buf, wanted[w + 1], keysVals[1])
      for (let k = run.varint(); k !== 0; k = run.varint()) tags[stringAt(k)] = stringAt(run.varint())
      result.matches.push({ id, lng: degrees(lonOffset, lon), lat: degrees(latOffset, lat), tags })
    }
  }

  const plainNode = (start, end) => {
    result.nodeCount++
    if (!possible) return
    let id = 0
    let lat = 0
    let lon = 0
    let keys = null
    let vals = null
    eachField(buf, start, end, (field, wireType, r) => {
      if (field === 1 && wireType === 0) id = r.svarint()
      else if (field === 8 && wireType === 0) lat = r.svarint()
      else if (field === 9 && wireType === 0) lon = r.svarint()
      else if (field === 2 && wireType === 2) keys = r.span()
      else if (field === 3 && wireType === 2) vals = r.span()
      else return false
      return true
    })
    if (keys === null || vals === null) return
    const keyReader = new Reader(buf, keys[0], keys[1])
    const valReader = new Reader(buf, vals[0], vals[1])
    const tags = {}
    let hit = false
    while (keyReader.pos < keyReader.end && valReader.pos < valReader.end) {
      const k = keyReader.varint()
      const v = valReader.varint()
      if (k === keyIndex && valueIndexes.has(v)) hit = true
      tags[k] = v
    }
    if (!hit) return
    const named = {}
    for (const [k, v] of Object.entries(tags)) named[stringAt(Number(k))] = stringAt(v)
    result.matches.push({ id, lng: degrees(lonOffset, lon), lat: degrees(latOffset, lat), tags: named })
  }

  for (const [groupStart, groupEnd] of groups) {
    eachField(buf, groupStart, groupEnd, (field, wireType, r) => {
      if (wireType !== 2) return false
      const [start, end] = r.span()
      if (field === 1) {
        result.hasNodes = true
        plainNode(start, end)
      } else if (field === 2) {
        result.hasNodes = true
        dense(start, end)
      } else if (field === 3) result.hasWays = true
      else if (field === 4) result.hasRelations = true
      return true
    })
  }
  return result
}

/**
 * Streams a whole .osm.pbf file and collects every node tagged `key` = one of `values`.
 * In a file sorted by type (every Geofabrik extract is), reading stops at the first block
 * without nodes, so the ways and relations that make up most of the file are never read.
 *
 * @param {AsyncIterable<Uint8Array>} source
 * @param {{ key: string, values: readonly string[], onBlock?: (blocks: number) => void }} options
 */
export async function collectTaggedNodes(source, { key, values, onBlock }) {
  let header = null
  let blocks = 0
  let nodeCount = 0
  let stoppedEarly = false
  const nodes = []
  for await (const blob of readBlobs(source)) {
    if (blob.type === 'OSMHeader') {
      header = parseHeaderBlock(blob.data)
      continue
    }
    if (blob.type !== 'OSMData') continue
    if (header === null) throw new Error('PBF: data before the header block')
    const found = nodesWithTag(blob.data, key, values)
    blocks++
    nodeCount += found.nodeCount
    for (const node of found.matches) nodes.push(node)
    onBlock?.(blocks)
    if (!found.hasNodes && header.sortedByType && (found.hasWays || found.hasRelations)) {
      stoppedEarly = true
      break
    }
  }
  if (header === null) throw new Error('PBF: no header block (is this an .osm.pbf file?)')
  return { header, nodes, nodeCount, blocks, stoppedEarly }
}
