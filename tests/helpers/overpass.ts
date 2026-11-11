import { tileIdAt } from '../../src/core/index.ts'

/** A signal node as a test writes it: [OpenStreetMap node id, longitude, latitude]. */
export type NodeSpec = readonly [id: number, lng: number, lat: number]

/** What the stand-in server answers for a tile: its nodes, or an HTTP status to fail with. */
export type TileAnswer = readonly NodeSpec[] | number

export interface OverpassCall {
  readonly url: string
  readonly init: RequestInit | undefined
  /** The request body as sent: "data=<encoded query>". */
  readonly body: string
  /** The Overpass QL query inside the body. */
  readonly query: string
  /** The tile the query's bounding box is, or null if it is not one tile's box. */
  readonly tileId: string | null
}

/** An Overpass JSON body holding the given nodes, shaped like the real thing. */
export function overpassBody(nodes: readonly NodeSpec[]): unknown {
  return {
    version: 0.6,
    generator: 'hand-written test data',
    elements: nodes.map(([id, lng, lat]) => ({
      type: 'node',
      id,
      lat,
      lon: lng,
      tags: { highway: 'traffic_signals' },
    })),
  }
}

/**
 * Stands in for fetch against an Overpass server, so no test touches the
 * network. It reads the tile out of each query's bounding box and answers
 * with that tile's nodes (none, unless given), or with an error status.
 * `answers` can be changed between calls.
 */
export function fakeOverpass(initial: Record<string, TileAnswer> = {}) {
  const calls: OverpassCall[] = []
  const answers = new Map<string, TileAnswer>(Object.entries(initial))
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const body = String(init?.body)
    const query = new URLSearchParams(body).get('data') ?? ''
    const box = /\((-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\)/.exec(query)
    const [south, west, north, east] = box === null ? [] : box.slice(1).map(Number)
    const isOneTile =
      box !== null && Math.abs(north! - south! - 0.1) < 1e-9 && Math.abs(east! - west! - 0.1) < 1e-9
    const tileId = isOneTile ? tileIdAt([west! + 0.05, south! + 0.05]) : null
    calls.push({ url: String(input), init, body, query, tileId })
    const answer: TileAnswer = tileId === null ? 400 : (answers.get(tileId) ?? [])
    if (typeof answer === 'number') return Promise.resolve(new Response('The server is busy.', { status: answer }))
    return Promise.resolve(new Response(JSON.stringify(overpassBody(answer))))
  }) as typeof fetch
  return {
    fetchImpl,
    calls,
    answers,
    /** The tiles asked for so far, in order. */
    requested: () => calls.map((c) => c.tileId),
  }
}

/** A clock a test moves by hand. */
export function fakeClock(startMs = 1_800_000_000_000) {
  let nowMs = startMs
  return {
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms
    },
  }
}

/** Lets promise chains started in the background (a refresh) run to their end. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0))
}
