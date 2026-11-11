#!/usr/bin/env node
// Saves a snapshot of the City of Charlotte signal list under public/seed/charlotte-signals.
// The app uses it only when the city's server cannot be reached (see providers/charlotte/client.ts).
//
//   npm run seed:charlotte                    fetch and write the snapshot
//   npm run seed:charlotte -- --dry-run       print the plan, touch nothing, no network
//   npm run seed:charlotte -- --attempts 2    tries (default 3)
//
// The snapshot is City of Charlotte (CDOT) data, CC BY-NC-SA 4.0. It has a folder and a license
// file of its own and is never written into a file with any other signal source. The
// OpenStreetMap signal tiles are built by another script, from extracts on disk and without any
// network request: scripts/build-signal-tiles.mjs (npm run build:signals).
//
// One request at a time; after a failure it waits at least a minute (doubling) and gives up after
// a few tries. Needs Node 24 (it imports the app's TypeScript modules directly). No dependencies.
// Exit codes: 0 written; 1 bad arguments; 3 the City of Charlotte download failed. A run that
// fails leaves the files already on disk exactly as they were.

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fetchSignals, SIGNALS_LAYER_URL } from '../src/providers/charlotte/client.ts'
import { writeFilesAtomically } from './lib/write-files.mjs'

/** Says what is asking, with no name, address or contact detail in it. */
export const USER_AGENT = 'routeiq-seed/0.1 (personal hobby project)'

export const DEFAULT_OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../public/seed')
export const CHARLOTTE_DIR = 'charlotte-signals'
export const CHARLOTTE_FILE = 'signals.json'

/** The wait after a failed try; doubles each time. Never less than a minute. */
const BACKOFF_MS = 60_000
const DEFAULT_ATTEMPTS = 3

export const CHARLOTTE_LICENSE_MD = `# Traffic signal seed snapshot: City of Charlotte

\`${CHARLOTTE_FILE}\` in this folder is a snapshot of the operating traffic signals in the City of
Charlotte "Traffic Signals" layer:
${SIGNALS_LAYER_URL}
https://www.arcgis.com/home/item.html?id=3bf079185338440fbb7febe81dd5d9a9

Credit: City of Charlotte, Charlotte Department of Transportation (CDOT).

License: Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0):
https://creativecommons.org/licenses/by-nc-sa/4.0/

Non-commercial use only. Adaptations must be shared under the same license. The city gives no
warranty of accuracy or completeness. Changes made here: only records that are operating traffic
signals are kept, with their id, position and description.

Nothing from any other source is in this folder. Written by scripts/seed-charlotte.mjs.
`

/**
 * Reads the command line. Returns the options, or `{ error }` with a message.
 * @param {readonly string[]} argv arguments after the script name
 */
export function parseArgs(argv) {
  const options = { dryRun: false, attempts: DEFAULT_ATTEMPTS }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--attempts') {
      const value = Number(argv[++i])
      if (!Number.isInteger(value) || value < 1 || value > 5) return { error: '--attempts needs a whole number from 1 to 5' }
      options.attempts = value
    } else return { error: `Unknown argument: ${arg}` }
  }
  return options
}

/**
 * What a run would do, as lines of text. No network, no files.
 * @param {{ attempts: number }} options
 * @param {string} outDir
 */
export function describePlan(options, outDir) {
  return [
    `City of Charlotte: the whole Traffic Signals layer from ${SIGNALS_LAYER_URL}`,
    `  writes: ${join(outDir, CHARLOTTE_DIR)} (${CHARLOTTE_FILE}, LICENSE.md)`,
    `Up to ${options.attempts} tries, one request at a time, at least ${BACKOFF_MS / 1000} s apart after a failure.`,
  ]
}

/**
 * Runs `attempt` up to `attempts` times, one at a time, waiting between
 * tries: a minute, then two, then four. Stops early on success or on a
 * failure that waiting cannot fix.
 */
async function withBackoff(attempt, { attempts, sleep, log, what }) {
  let result = { ok: false, retry: false, message: 'not tried' }
  for (let n = 1; n <= attempts; n++) {
    result = await attempt()
    if (result.ok) return result
    log(`${what}: try ${n} of ${attempts} failed (${result.message}).`)
    if (!result.retry || n === attempts) break
    const waitMs = BACKOFF_MS * 2 ** (n - 1)
    log(`${what}: waiting ${waitMs / 1000} s before trying again.`)
    await sleep(waitMs)
  }
  return result
}

/**
 * The whole layer, through the app's own client and adapter, written as one
 * snapshot file plus LICENSE.md, in a folder of its own. Returns true when written.
 */
export async function seedCharlotte({ attempts, outDir, fetchImpl, sleep, now, log }) {
  const identified = (input, init) =>
    fetchImpl(input, { ...init, headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(60_000) })
  const fetched = await withBackoff(
    async () => {
      const result = await fetchSignals({ fetchImpl: identified })
      return result.ok ? result : { ok: false, retry: result.kind !== 'malformed', message: result.message }
    },
    { attempts, sleep, log, what: 'City of Charlotte' },
  )
  if (!fetched.ok) {
    log('City of Charlotte: not seeded. Files already on disk were left as they were.')
    return false
  }
  const snapshot = { fetchedAt: now(), signals: fetched.signals }
  await writeFilesAtomically(join(outDir, CHARLOTTE_DIR), [
    ['LICENSE.md', CHARLOTTE_LICENSE_MD],
    [CHARLOTTE_FILE, `${JSON.stringify(snapshot)}\n`],
  ])
  log(`City of Charlotte: ${snapshot.signals.length} operating traffic signals written to ${join(outDir, CHARLOTTE_DIR)}.`)
  return true
}

/**
 * The whole script. Everything it touches can be swapped out, which is how
 * the tests run it without a network or the real public folder.
 * @param {readonly string[]} argv
 * @param {{ fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void>, now?: () => number,
 *           log?: (line: string) => void, outDir?: string }} [deps]
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, deps = {}) {
  const {
    fetchImpl = fetch,
    sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
    now = Date.now,
    log = console.log,
    outDir = DEFAULT_OUT_DIR,
  } = deps
  const options = parseArgs(argv)
  if ('error' in options) {
    log(options.error)
    log('Usage: node scripts/seed-charlotte.mjs [--dry-run] [--attempts <n>]')
    return 1
  }
  if (options.dryRun) {
    log('Dry run: nothing is fetched or written.')
    for (const line of describePlan(options, outDir)) log(line)
    return 0
  }
  return (await seedCharlotte({ attempts: options.attempts, outDir, fetchImpl, sleep, now, log })) ? 0 : 3
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
