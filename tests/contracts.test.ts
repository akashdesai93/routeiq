import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CORE_CONTRACT_VERSION, EMPTY_PLACE_BOOK, serializePlaceBook, type PlaceBook } from '../src/core/index.ts'
import { CONTRACT_ROOTS, CONTRACT_SCHEMAS, contractHash, contractSurface, declarationsOf, tokenize } from './helpers/contractSurface.ts'

// PLAN step 10 (#7): the core contracts are versioned. The shapes the Swift port and the iPhone
// shell depend on (docs/contracts.md) are read from the source, with everything they refer to,
// and compared with the snapshot in docs/contracts/core-contract.json. A change of shape without
// a bump of CORE_CONTRACT_VERSION fails here. To change a contract on purpose:
//   1. bump CORE_CONTRACT_VERSION (src/core/contract.ts),
//   2. UPDATE_CONTRACT=1 npx vitest run tests/contracts.test.ts,
//   3. say in docs/contracts.md what changed, and in native/RouteIQCore/README.md what the Swift port matches.

const SNAPSHOT = 'docs/contracts/core-contract.json'

interface Snapshot {
  readonly version: number
  readonly hash: string
  /** Every version there has been, oldest first, with its hash. */
  readonly history: readonly { readonly version: number; readonly hash: string }[]
  readonly declarations: Record<string, string>
}

const surface = contractSurface()
const hash = contractHash(surface)
const readSnapshot = (): Snapshot | null => (existsSync(SNAPSHOT) ? (JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Snapshot) : null)

if (process.env.UPDATE_CONTRACT === '1') {
  const old = readSnapshot()
  if (old !== null && old.hash !== hash && old.version === CORE_CONTRACT_VERSION) {
    throw new Error(`The contract changed: bump CORE_CONTRACT_VERSION (now ${CORE_CONTRACT_VERSION}) before regenerating ${SNAPSHOT}.`)
  }
  const history = old === null ? [] : old.history.filter((h) => h.version !== CORE_CONTRACT_VERSION)
  const next: Snapshot = { version: CORE_CONTRACT_VERSION, hash, history: [...history, { version: CORE_CONTRACT_VERSION, hash }], declarations: surface }
  writeFileSync(SNAPSHOT, `${JSON.stringify(next, null, 2)}\n`)
}

/** The names of an interface's fields as written, with whether each is optional. */
function fieldsOf(text: string): Map<string, boolean> {
  const tokens = text.split(' ')
  const fields = new Map<string, boolean>()
  let depth = 0
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t === '{' || t === '[' || t === '(' || t === '<') depth++
    else if (t === '}' || t === ']' || t === ')' || t === '>') depth--
    if (depth !== 1 || t === 'readonly') continue
    const next = tokens[i + 1]
    if (next === ':' && /^[a-zA-Z]+$/.test(t)) fields.set(t, false)
    if (next === '?' && tokens[i + 2] === ':' && /^[a-zA-Z]+$/.test(t)) fields.set(t, true)
  }
  return fields
}

describe('core contracts (PLAN step 10, #7)', () => {
  it('a change of shape is not possible without a bump of CORE_CONTRACT_VERSION', () => {
    const snapshot = readSnapshot()
    expect(snapshot, `${SNAPSHOT} is missing: run UPDATE_CONTRACT=1 npx vitest run tests/contracts.test.ts`).not.toBeNull()
    const latest = snapshot!.history.at(-1)!
    if (snapshot!.hash !== hash) {
      const changed = Object.keys({ ...surface, ...snapshot!.declarations }).filter((k) => surface[k] !== snapshot!.declarations[k])
      const hint =
        CORE_CONTRACT_VERSION === latest.version
          ? `bump CORE_CONTRACT_VERSION (src/core/contract.ts, now ${CORE_CONTRACT_VERSION}), then run UPDATE_CONTRACT=1 npx vitest run tests/contracts.test.ts`
          : `run UPDATE_CONTRACT=1 npx vitest run tests/contracts.test.ts to record version ${CORE_CONTRACT_VERSION}`
      expect.fail(`The core contract changed (${changed.join(', ') || 'a schema file'}): ${hint}, and note the change in docs/contracts.md.`)
    }
    expect(snapshot!.version).toBe(CORE_CONTRACT_VERSION)
    expect(latest).toEqual({ version: CORE_CONTRACT_VERSION, hash })
    expect(snapshot!.declarations).toEqual(surface)
  })

  it('the version history only goes up, and each version has a shape of its own', () => {
    const { history } = readSnapshot()!
    for (let i = 1; i < history.length; i++) {
      expect(history[i]!.version).toBeGreaterThan(history[i - 1]!.version)
      expect(history[i]!.hash).not.toBe(history[i - 1]!.hash)
    }
    expect(Number.isInteger(CORE_CONTRACT_VERSION) && CORE_CONTRACT_VERSION >= 1).toBe(true)
  })

  it('covers the shapes the Swift port and the shell depend on, and everything they refer to', () => {
    for (const root of CONTRACT_ROOTS) expect(surface[root], root).toBeDefined()
    // A few that come along by reference.
    for (const name of ['LngLat', 'Maneuver', 'GuidanceStep', 'SegmentTraffic', 'CongestionLevel', 'RouteSource', 'TileRows', 'SavedPlace', 'StoredTrip', 'NativeFix', 'PositionFix', 'SpokenLine', 'RerouteCode']) {
      expect(surface[name], name).toBeDefined()
    }
    expect(surface.RouteCandidate).toContain('readonly source ? : RouteSource')
    expect(surface.RouteCandidate).toContain('readonly segmentTraffic ? : SegmentTraffic | null')
    expect(surface.RouteSource).toBe("type RouteSource = 'provider' | 'probe'")
  })

  it('the surface is the shape only: comments and layout make no difference', () => {
    const a = declarationsOf(`/** A point. */\nexport interface P {\n  // the x\n  readonly x: number\n  readonly y?: string\n}\nexport type U =\n  | 'a'\n  | 'b'\n`)
    const b = declarationsOf(`export interface P { readonly x: number; readonly y?: string }\nexport type U = 'a' | 'b'`)
    expect(a.get('P')!.text).toBe(b.get('P')!.text)
    expect(a.get('U')!.text).toBe(b.get('U')!.text)
    expect(declarationsOf('export interface P { readonly x: number }').get('P')!.text).not.toBe(b.get('P')!.text)
    // Strings stay whole; a comment marker inside one is not a comment.
    expect(tokenize(`type S = 'https://x' // gone`).map((t) => t.text)).toEqual(['type', 'S', '=', "'https://x'"])
  })

  describe('the JSON formats match their schemas (docs/contracts/schemas)', () => {
    const schema = (name: string) => JSON.parse(readFileSync(join('docs/contracts/schemas', name), 'utf8')) as JsonSchema

    it('every bundled signal tile, and the bundle index', () => {
      const dir = 'public/seed/osm-signals'
      const tiles = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'index.json')
      expect(tiles.length).toBeGreaterThan(100)
      const tile = schema('signal-tile.schema.json')
      for (const f of tiles) expect(validate(tile, JSON.parse(readFileSync(join(dir, f), 'utf8'))), f).toEqual([])
      expect(validate(schema('signal-index.schema.json'), JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')))).toEqual([])
    })

    it('the place book as it is stored, empty and full', () => {
      const place = (id: string, label: string, position: readonly [number, number]) => ({ id, label, position })
      const uptown = place('p1', 'Uptown Charlotte', [-80.8431, 35.2271])
      const book: PlaceBook = {
        home: { id: 'home', name: 'Home', label: 'Uptown Charlotte', position: [-80.8431, 35.2271] },
        work: null,
        custom: [{ id: 'c1', name: 'Gym', label: 'SouthPark', position: [-80.8295, 35.1527] }],
        recents: [uptown],
        lastTrip: { origin: null, destination: uptown },
      }
      const stored = schema('place-book.schema.json')
      expect(validate(stored, JSON.parse(JSON.stringify(serializePlaceBook(EMPTY_PLACE_BOOK))))).toEqual([])
      expect(validate(stored, JSON.parse(JSON.stringify(serializePlaceBook(book))))).toEqual([])
      expect(validate(stored, { ...serializePlaceBook(book), version: 2 })).not.toEqual([])
    })

    it('the native bridge payloads', () => {
      const bridge = schema('native-bridge.schema.json')
      const def = (name: string) => ({ ...bridge.$defs![name]!, $defs: bridge.$defs })
      expect(validate(def('fix'), { lng: -80.8431, lat: 35.2271, accuracy: 5, speed: 12, course: 180, timestamp: 1_794_345_699_000 })).toEqual([])
      expect(validate(def('fix'), { lng: -80.8431 })).not.toEqual([])
      expect(validate(def('httpGetRequest'), { id: 'get-1', url: 'https://api.mapbox.com/directions/v5/x', timeoutMs: 20_000 })).toEqual([])
      expect(validate(def('httpGetRequest'), { id: 'get-1', url: 'https://example.com/', timeoutMs: 20_000 })).not.toEqual([])
      expect(validate(def('httpGetErrorCode'), 'timeout')).toEqual([])
      // The test drive (#86): a made-up fix says so, and the route it drives is points, a speed and a script.
      expect(validate(def('fix'), { lng: -80.8431, lat: 35.2271, accuracy: 5, speed: 15, timestamp: 1_794_345_699_000, simulated: true })).toEqual([])
      expect(validate(def('fix'), { lng: -80.8431, lat: 35.2271, simulated: 'yes' })).not.toEqual([])
      const route = { points: [[-80.8431, 35.2271], [-80.8431, 35.2181]], speedMps: 15, script: [{ atM: 870, speedMps: 5 }, { atM: 900, stopSec: 3 }] }
      expect(validate(def('simulatedRouteRequest'), route)).toEqual([])
      expect(validate(def('simulatedRouteRequest'), { ...route, points: [] })).not.toEqual([])
      expect(validate(def('simulatedRouteRequest'), { ...route, script: [{ speedMps: 5 }] })).not.toEqual([])
      expect(validate(def('shareRequest'), { text: 'RouteIQ drive diagnostics' })).toEqual([])
      expect(validate(def('shareRequest'), {})).not.toEqual([])
    })

    it('each schema names the same fields as the TypeScript type it stands for', () => {
      const pairs: [string, string, string][] = [
        ['signal-tile.schema.json', '', 'OsmSignalTile'],
        ['signal-tile.schema.json', 'node', 'OsmSignalNode'],
        ['signal-index.schema.json', '', 'OsmBundleIndex'],
        ['signal-index.schema.json', 'extract', 'OsmExtractInfo'],
        ['place-book.schema.json', 'place', 'Place'],
        ['place-book.schema.json', 'savedPlace', 'SavedPlace'],
        ['place-book.schema.json', 'storedTrip', 'StoredTrip'],
        ['native-bridge.schema.json', 'fix', 'NativeFix'],
        ['native-bridge.schema.json', 'locationError', 'NativeLocationError'],
        ['native-bridge.schema.json', 'simulatedStep', 'NativeSimulatedStep'],
      ]
      for (const [file, def, type] of pairs) {
        const s = schema(file)
        const node = def === '' ? s : s.$defs![def]!
        const fields = fieldsOf(surface[type]!)
        expect(Object.keys(node.properties!).sort(), `${file} ${def || '(root)'} vs ${type}`).toEqual([...fields.keys()].sort())
        expect([...(node.required ?? [])].sort(), `${file} ${def || '(root)'} required`).toEqual([...fields].filter(([, optional]) => !optional).map(([n]) => n).sort())
      }
      // The stored place book is PlaceBook plus its version.
      const book = schema('place-book.schema.json')
      expect(Object.keys(book.properties!).sort()).toEqual([...fieldsOf(surface.PlaceBook!).keys(), 'version'].sort())
    })

    it('every schema file is part of the contract hash', () => {
      expect(CONTRACT_SCHEMAS.map((f) => f.split('/').at(-1))).toEqual([
        'native-bridge.schema.json',
        'place-book.schema.json',
        'signal-index.schema.json',
        'signal-tile.schema.json',
      ])
    })
  })
})

// A small JSON Schema checker for the parts of draft 2020-12 these schemas use. Returns the problems found.
interface JsonSchema {
  readonly $defs?: Record<string, JsonSchema>
  readonly $ref?: string
  readonly type?: string
  readonly const?: unknown
  readonly enum?: readonly unknown[]
  readonly required?: readonly string[]
  readonly properties?: Record<string, JsonSchema>
  readonly patternProperties?: Record<string, JsonSchema>
  readonly additionalProperties?: boolean
  readonly items?: JsonSchema
  readonly prefixItems?: readonly JsonSchema[]
  readonly minItems?: number
  readonly maxItems?: number
  readonly minimum?: number
  readonly maximum?: number
  readonly pattern?: string
  readonly oneOf?: readonly JsonSchema[]
}

function validate(schema: JsonSchema, value: unknown, root: JsonSchema = schema, at = '$'): string[] {
  if (schema.$ref !== undefined) {
    const name = schema.$ref.replace('#/$defs/', '')
    const target = root.$defs?.[name]
    return target === undefined ? [`${at}: unknown $ref ${schema.$ref}`] : validate(target, value, root, at)
  }
  const problems: string[] = []
  const typeOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)
  if (schema.type !== undefined) {
    const ok = schema.type === 'integer' ? Number.isInteger(value) : typeOf(value) === schema.type && !(schema.type === 'number' && !Number.isFinite(value))
    if (!ok) return [`${at}: expected ${schema.type}, got ${typeOf(value)}`]
  }
  if ('const' in schema && value !== schema.const) problems.push(`${at}: expected ${JSON.stringify(schema.const)}`)
  if (schema.enum !== undefined && !schema.enum.includes(value)) problems.push(`${at}: not one of ${schema.enum.join(', ')}`)
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) problems.push(`${at}: below ${schema.minimum}`)
    if (schema.maximum !== undefined && value > schema.maximum) problems.push(`${at}: above ${schema.maximum}`)
  }
  if (typeof value === 'string' && schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) problems.push(`${at}: does not match ${schema.pattern}`)
  if (schema.oneOf !== undefined) {
    const passing = schema.oneOf.filter((s) => validate(s, value, root, at).length === 0).length
    if (passing !== 1) problems.push(`${at}: matches ${passing} of oneOf`)
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) problems.push(`${at}: fewer than ${schema.minItems} items`)
    if (schema.maxItems !== undefined && value.length > schema.maxItems) problems.push(`${at}: more than ${schema.maxItems} items`)
    value.forEach((item, i) => {
      const s = schema.prefixItems?.[i] ?? schema.items
      if (s !== undefined) problems.push(...validate(s, item, root, `${at}[${i}]`))
    })
  }
  if (typeOf(value) === 'object') {
    const obj = value as Record<string, unknown>
    for (const key of schema.required ?? []) if (!(key in obj)) problems.push(`${at}: missing ${key}`)
    for (const [key, v] of Object.entries(obj)) {
      const direct = schema.properties?.[key]
      const byPattern = Object.entries(schema.patternProperties ?? {}).find(([p]) => new RegExp(p).test(key))?.[1]
      const s = direct ?? byPattern
      if (s !== undefined) problems.push(...validate(s, v, root, `${at}.${key}`))
      else if (schema.additionalProperties === false) problems.push(`${at}: unexpected ${key}`)
    }
  }
  return problems
}
