// Types for osm-pbf.mjs, so the tests can import it. The reader itself is plain JavaScript.

export interface PbfHeader {
  /** [west, south, east, north] in degrees, or null when the file gives none. */
  bbox: [number, number, number, number] | null
  requiredFeatures: string[]
  optionalFeatures: string[]
  writingProgram: string | null
  source: string | null
  /** When the data was current, in seconds since 1970, or null. */
  replicationTimestampSec: number | null
  sortedByType: boolean
}

export interface PbfNode {
  id: number
  lng: number
  lat: number
  tags: Record<string, string>
}

export interface PbfBlockNodes {
  nodeCount: number
  hasNodes: boolean
  hasWays: boolean
  hasRelations: boolean
  matches: PbfNode[]
}

export function readBlobs(source: AsyncIterable<Uint8Array>): AsyncGenerator<{ type: string; data: Uint8Array }>
export function parseHeaderBlock(data: Uint8Array): PbfHeader
export function nodesWithTag(data: Uint8Array, key: string, values: readonly string[]): PbfBlockNodes
export function collectTaggedNodes(
  source: AsyncIterable<Uint8Array>,
  options: { key: string; values: readonly string[]; onBlock?: (blocks: number) => void },
): Promise<{ header: PbfHeader; nodes: PbfNode[]; nodeCount: number; blocks: number; stoppedEarly: boolean }>
