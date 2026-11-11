import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CHARLOTTE_SEED_PATH,
  createSignalSession,
  fetchSeedSnapshot,
  isCharlotteSnapshot,
  SIGNALS_LAYER_URL,
  type CharlotteSnapshot,
  type SignalsResult,
} from '../src/providers/charlotte/client.ts'
import { OSM_BUNDLE_PATH } from '../src/providers/osm/bundle.ts'
import { memoryStore } from '../src/storage/kv.ts'
import { SIGNAL_DATA_ATTRIBUTION } from '../src/map/attribution.ts'
import {
  CHARLOTTE_DIR,
  CHARLOTTE_FILE,
  CHARLOTTE_LICENSE_MD,
  describePlan,
  main,
  parseArgs,
  USER_AGENT,
} from '../scripts/seed-charlotte.mjs'
import { writeFilesAtomically } from '../scripts/lib/write-files.mjs'

// The City of Charlotte snapshot: the script that saves it, run whole against a stand-in for the
// city's server and a temporary folder, and the app's fallback on it. No test here touches the
// network or the real public/seed folder. Positions are made up.

const NOW = 1_800_000_000_000
const DAY_MS = 24 * 60 * 60 * 1000

const CITY_PAGE = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { OBJECTID: 1, UNITTYPE: 'TSL', SERVSTAT: 'OP', UNITDESC: 'A ST_B ST' },
      geometry: { type: 'Point', coordinates: [-80.84, 35.22] },
    },
    {
      type: 'Feature',
      properties: { OBJECTID: 2, UNITTYPE: 'SF', SERVSTAT: 'OP', UNITDESC: 'A SCHOOL FLASHER' },
      geometry: { type: 'Point', coordinates: [-80.83, 35.21] },
    },
  ],
}

type Answer = { status: number; body: unknown } | 'throw'

/** Stands in for the city's server. It answers from its list, in order; the last answer repeats. */
function server(answers: Answer[] = [{ status: 200, body: CITY_PAGE }]) {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  let inFlight = 0
  let mostAtOnce = 0
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    inFlight++
    mostAtOnce = Math.max(mostAtOnce, inFlight)
    await Promise.resolve()
    inFlight--
    const answer = answers.length > 1 ? answers.shift()! : answers[0]!
    if (answer === 'throw') throw new TypeError('fetch failed')
    const text = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body)
    return new Response(text, { status: answer.status })
  }) as typeof fetch
  return { fetchImpl, calls, mostAtOnce: () => mostAtOnce }
}

const temporary: string[] = []
function outDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'routeiq-seed-'))
  temporary.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function run(argv: string[], city: ReturnType<typeof server>, dir: string) {
  const lines: string[] = []
  const sleeps: number[] = []
  const done = main(argv, {
    fetchImpl: city.fetchImpl,
    sleep: (ms) => {
      sleeps.push(ms)
      return Promise.resolve()
    },
    now: () => NOW,
    log: (line) => lines.push(line),
    outDir: dir,
  })
  return { done, lines, sleeps }
}

const readJson = (...path: string[]): unknown => JSON.parse(readFileSync(join(...path), 'utf8'))

describe('Charlotte seed script arguments', () => {
  it('takes --dry-run and --attempts, and has nothing to do with OpenStreetMap any more', () => {
    expect(parseArgs([])).toEqual({ dryRun: false, attempts: 3 })
    expect(parseArgs(['--dry-run', '--attempts', '1'])).toEqual({ dryRun: true, attempts: 1 })
    // The OpenStreetMap tiles are built by scripts/build-signal-tiles.mjs, from extracts on disk.
    expect(parseArgs(['--only', 'osm'])).toHaveProperty('error')
    expect(parseArgs(['--endpoint', 'https://overpass.example/api/interpreter'])).toHaveProperty('error')
  })

  it('refuses what it does not understand, with exit code 1 and no request', async () => {
    for (const argv of [['--attempts', '99'], ['--attempts'], ['--fast']]) {
      expect(parseArgs(argv)).toHaveProperty('error')
      const city = server()
      const dir = outDir()
      const { done, lines } = run(argv, city, dir)
      expect(await done).toBe(1)
      expect(lines.join('\n')).toContain('Usage:')
      expect(city.calls).toHaveLength(0)
      expect(readdirSync(dir)).toEqual([])
    }
  })

  it('prints the plan on --dry-run and touches neither the network nor the disk', async () => {
    const city = server()
    const dir = outDir()
    const { done, lines } = run(['--dry-run'], city, dir)
    expect(await done).toBe(0)
    const text = lines.join('\n')
    expect(text).toContain('Dry run')
    expect(text).toContain(SIGNALS_LAYER_URL)
    expect(text).not.toMatch(/overpass/i)
    expect(describePlan({ dryRun: true, attempts: 2 }, dir).join('\n')).toContain('Up to 2 tries')
    expect(city.calls).toHaveLength(0)
    expect(readdirSync(dir)).toEqual([])
  })
})

describe('Charlotte seed script run', () => {
  it('writes the snapshot and its license into a folder of its own, and asks no other server', async () => {
    const city = server()
    const dir = outDir()
    const { done, sleeps } = run([], city, dir)
    expect(await done).toBe(0)
    expect(sleeps).toEqual([])
    expect(readdirSync(dir)).toEqual([CHARLOTTE_DIR])
    expect(readdirSync(join(dir, CHARLOTTE_DIR)).sort()).toEqual(['LICENSE.md', CHARLOTTE_FILE])
    for (const call of city.calls) expect(call.url.startsWith(SIGNALS_LAYER_URL)).toBe(true)

    const snapshot = readJson(dir, CHARLOTTE_DIR, CHARLOTTE_FILE)
    expect(isCharlotteSnapshot(snapshot)).toBe(true)
    // Operating traffic signals only: the school flasher is left out.
    expect(snapshot).toEqual({ fetchedAt: NOW, signals: [{ id: 'clt-1', position: [-80.84, 35.22], name: 'A ST_B ST' }] })

    const cityLicense = readFileSync(join(dir, CHARLOTTE_DIR, 'LICENSE.md'), 'utf8')
    expect(cityLicense).toBe(CHARLOTTE_LICENSE_MD)
    expect(cityLicense).toContain('CC BY-NC-SA 4.0')
    expect(cityLicense).toContain('City of Charlotte')
    expect(cityLicense).toContain('CDOT')
    expect(cityLicense).toContain('Non-commercial')
    // Nothing of the OpenStreetMap dataset is in it.
    expect(readFileSync(join(dir, CHARLOTTE_DIR, CHARLOTTE_FILE), 'utf8')).not.toContain('"nodes"')
  })

  it('ships a license file that matches the script, next to the real snapshot', () => {
    const shipped = readFileSync(join(import.meta.dirname, '../public/seed/charlotte-signals/LICENSE.md'), 'utf8')
    expect(shipped.replace(/\r\n/g, '\n')).toBe(CHARLOTTE_LICENSE_MD)
  })

  it('says who is asking without naming anyone, and asks one thing at a time', async () => {
    const city = server()
    expect(await run([], city, outDir()).done).toBe(0)
    expect(USER_AGENT).toBe('routeiq-seed/0.1 (personal hobby project)')
    expect(USER_AGENT).not.toMatch(/@|https?:|\d{3,}/)
    for (const call of city.calls) {
      expect(new Headers(call.init?.headers).get('user-agent')).toBe(USER_AGENT)
    }
    expect(city.mostAtOnce()).toBe(1)
  })

  it('waits a minute, then two, between tries, and stops when one works', async () => {
    const city = server([{ status: 503, body: 'busy' }, 'throw', { status: 200, body: CITY_PAGE }])
    const dir = outDir()
    const { done, sleeps, lines } = run([], city, dir)
    expect(await done).toBe(0)
    expect(sleeps).toEqual([60_000, 120_000])
    expect(city.calls).toHaveLength(3)
    expect(lines.join('\n')).toContain('try 1 of 3 failed')
    expect(readdirSync(join(dir, CHARLOTTE_DIR))).toHaveLength(2)
  })

  it('gives up after the tries it was given, with exit 3 and nothing written', async () => {
    const city = server([{ status: 503, body: 'busy' }])
    const dir = outDir()
    const { done, sleeps, lines } = run(['--attempts', '2'], city, dir)
    expect(await done).toBe(3)
    expect(city.calls).toHaveLength(2)
    expect(sleeps).toEqual([60_000])
    expect(lines.join('\n')).toContain('City of Charlotte: not seeded')
    expect(readdirSync(dir)).toEqual([])
  })

  it('never replaces a good snapshot with an error body or a web page', async () => {
    const dir = outDir()
    expect(await run([], server(), dir).done).toBe(0)
    const before = () =>
      Object.fromEntries(
        readdirSync(join(dir, CHARLOTTE_DIR)).map((name) => [name, readFileSync(join(dir, CHARLOTTE_DIR, name), 'utf8')]),
      )
    const good = before()
    const failures: Answer[] = [
      { status: 500, body: 'Internal Server Error' },
      { status: 200, body: { error: { code: 400, message: 'Invalid query' } } },
      { status: 200, body: 'not json' },
      'throw',
    ]
    for (const failure of failures) {
      expect(await run(['--attempts', '1'], server([failure]), dir).done).toBe(3)
      expect(before()).toEqual(good)
    }
  })

  it('writes through temporary files and leaves none behind when a write fails', async () => {
    const dir = outDir()
    await writeFilesAtomically(dir, [['a.json', '{"a":1}\n']])
    // A folder where the second file should go makes its write fail before anything is renamed.
    mkdirSync(join(dir, '.b.json.tmp'))
    await expect(writeFilesAtomically(dir, [['a.json', 'BROKEN'], ['b.json', '{}']])).rejects.toThrow()
    expect(readFileSync(join(dir, 'a.json'), 'utf8')).toBe('{"a":1}\n')
    expect(readdirSync(dir).sort()).toEqual(['.b.json.tmp', 'a.json'])
    writeFileSync(join(dir, 'c.json'), 'old')
    await writeFilesAtomically(dir, [['c.json', 'new']])
    expect(readFileSync(join(dir, 'c.json'), 'utf8')).toBe('new')
  })
})

describe('the credit on the map', () => {
  it('names OpenStreetMap contributors and links to the copyright page', () => {
    const html = SIGNAL_DATA_ATTRIBUTION
    expect(html).toContain('© OpenStreetMap contributors')
    expect(html).toContain('href="https://www.openstreetmap.org/copyright"')
  })
})

/** Serves JSON "files" by URL and answers 404 for the rest. */
function staticFiles(files: Record<string, unknown>) {
  return ((input: RequestInfo | URL) => {
    const url = String(input)
    if (!(url in files)) return Promise.resolve(new Response('<!doctype html><title>Not found</title>', { status: 404 }))
    const file = files[url]
    return Promise.resolve(new Response(typeof file === 'string' ? file : JSON.stringify(file)))
  }) as typeof fetch
}

describe('the City of Charlotte seed snapshot', () => {
  const URL = `/${CHARLOTTE_SEED_PATH}`
  const snapshot: CharlotteSnapshot = {
    fetchedAt: NOW - 10 * DAY_MS,
    signals: [{ id: 'clt-1', position: [-80.84, 35.22], name: 'A ST_B ST' }],
  }
  const live: SignalsResult = {
    ok: true,
    signals: [
      { id: 'clt-1', position: [-80.84, 35.22], name: 'A ST_B ST' },
      { id: 'clt-2', position: [-80.83, 35.21], name: null },
    ],
  }
  const failed: SignalsResult = { ok: false, kind: 'network', message: 'offline' }

  it('is kept in a folder of its own, apart from the OpenStreetMap tiles', () => {
    expect(CHARLOTTE_SEED_PATH.startsWith('seed/charlotte-signals/')).toBe(true)
    expect(OSM_BUNDLE_PATH).toBe('seed/osm-signals')
    expect(CHARLOTTE_SEED_PATH.startsWith(OSM_BUNDLE_PATH)).toBe(false)
  })

  it('reads a well-formed snapshot and nothing else', async () => {
    expect(await fetchSeedSnapshot(URL, staticFiles({ [URL]: snapshot }))).toEqual(snapshot)
    expect(await fetchSeedSnapshot(URL, staticFiles({}))).toBeNull()
    expect(await fetchSeedSnapshot(URL, staticFiles({ [URL]: '<!doctype html>' }))).toBeNull()
    expect(await fetchSeedSnapshot(URL, staticFiles({ [URL]: { fetchedAt: NOW, signals: [] } }))).toBeNull()
    // An OpenStreetMap tile is not a city snapshot.
    const tile = { tileId: '-809_352', fetchedAt: NOW, nodes: [] }
    expect(await fetchSeedSnapshot(URL, staticFiles({ [URL]: tile }))).toBeNull()
    expect(await fetchSeedSnapshot(URL, () => Promise.reject(new Error('offline')))).toBeNull()
  })

  it('stands in when the live download fails, without being stored or remembered', async () => {
    const store = memoryStore<CharlotteSnapshot>()
    const answers = [failed, live]
    let downloads = 0
    let seedReads = 0
    const session = createSignalSession(
      () => Promise.resolve(answers[downloads++]!),
      { store, now: () => NOW },
      () => {
        seedReads++
        return Promise.resolve(snapshot)
      },
    )
    // The city's server is down: the seed answers.
    expect(await session.load()).toEqual({ ok: true, signals: snapshot.signals })
    expect(await store.get('all')).toBeNull()
    // Next time the live list is tried again, and that is what is kept.
    expect(await session.load()).toEqual(live)
    expect(await store.get('all')).toEqual({ fetchedAt: NOW, signals: live.signals })
    expect(downloads).toBe(2)
    expect(seedReads).toBe(1)
  })

  it('is not read when the live download works or the device already has the list', async () => {
    let seedReads = 0
    const seed = () => {
      seedReads++
      return Promise.resolve(snapshot)
    }
    expect(await createSignalSession(() => Promise.resolve(live), null, seed).load()).toEqual(live)
    const store = memoryStore<CharlotteSnapshot>()
    await store.put('all', { fetchedAt: NOW - DAY_MS, signals: live.signals })
    const stored = createSignalSession(() => Promise.resolve(failed), { store, now: () => NOW }, seed)
    expect(await stored.load()).toEqual(live)
    expect(seedReads).toBe(0)
  })

  it('leaves the failure as it is when there is no usable seed either', async () => {
    const none = createSignalSession(() => Promise.resolve(failed), null, () => Promise.resolve(null))
    expect(await none.load()).toEqual(failed)
    const broken = createSignalSession(() => Promise.resolve(failed), null, () => Promise.reject(new Error('gone')))
    expect(await broken.load()).toEqual(failed)
    const aborted: SignalsResult = { ok: false, kind: 'aborted', message: 'cancelled' }
    const cancelled = createSignalSession(() => Promise.resolve(aborted), null, () => Promise.resolve(snapshot))
    expect(await cancelled.load()).toEqual(aborted)
  })
})
