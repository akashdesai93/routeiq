#!/usr/bin/env node
// Writes a GPX track of a simulated drive: one point per second at a steady speed along a list
// of waypoints, each with a timestamp, so a tool that replays GPX (pymobiledevice3's
// `simulate-location play`) moves the phone the way a car would. See docs/phone-sim-location.md.
//
//   node scripts/phone/make-gpx.mjs --preset wrong-turn --out drive.gpx
//   node scripts/phone/make-gpx.mjs --waypoints "-80.8431,35.2271;-80.8453,35.2257" --speed 10
//
// It is pure: no network, no clock (the timestamps start at --start, a fixed moment by default),
// so the same arguments always give the same file. Without --out the GPX goes to standard output.

import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { PRESETS } from './presets.mjs'

/** @typedef {readonly [lng: number, lat: number]} LngLat */

/** Every default of the generator, in one place. */
export const DEFAULT_GPX_OPTIONS = Object.freeze({
  /** About 47 km/h (29 mph): a city street. */
  speedMps: 13,
  /** One point per second, the rate a phone's GPS reports at. */
  intervalSec: 1,
  /** Seconds standing at the first point before setting off (time to plan the route on the phone). */
  holdSec: 0,
  /** Meters of the path skipped at the start. */
  fromM: 0,
  /** The track is cut after this many seconds; 0 keeps all of it. */
  maxSec: 0,
  /** Only the differences between timestamps matter to a replay, so the start is a fixed moment. */
  startTime: '2026-01-01T00:00:00Z',
})

export const MIN_SPEED_MPS = 0.5
export const MAX_SPEED_MPS = 60

const EARTH_RADIUS_M = 6_371_008.8
const RAD = Math.PI / 180

/**
 * Meters between two coordinates (haversine).
 * @param {LngLat} a
 * @param {LngLat} b
 */
export function distanceM(a, b) {
  const dLat = (b[1] - a[1]) * RAD
  const dLng = (b[0] - a[0]) * RAD
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * Meters along a path.
 * @param {readonly LngLat[]} path
 */
export function pathLengthM(path) {
  let total = 0
  for (let i = 1; i < path.length; i++) total += distanceM(path[i - 1], path[i])
  return total
}

/**
 * The point a fraction of the way from a to b. Straight in longitude and latitude, which over
 * the length of a city block differs from the great circle by less than a millimeter.
 * @param {LngLat} a
 * @param {LngLat} b
 * @param {number} t 0 at a, 1 at b
 * @returns {LngLat}
 */
function between(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

/**
 * The path from `fromM` meters along it to its end. Past the end, the answer is the last point alone.
 * @param {readonly LngLat[]} path
 * @param {number} fromM
 * @returns {LngLat[]}
 */
export function pathFrom(path, fromM) {
  if (!(fromM > 0) || path.length < 2) return [...path]
  let walked = 0
  for (let i = 1; i < path.length; i++) {
    const length = distanceM(path[i - 1], path[i])
    if (walked + length > fromM) return [between(path[i - 1], path[i], (fromM - walked) / length), ...path.slice(i)]
    walked += length
  }
  return [path[path.length - 1]]
}

/**
 * The positions of a car driving the path at a steady speed, one per interval: the first is the
 * first waypoint, each next one is `speedMps * intervalSec` meters farther along the path
 * (around corners, not across them), and the last is the last waypoint exactly, however short
 * the final step. Waypoints that repeat the one before are skipped.
 * @param {readonly LngLat[]} waypoints at least one
 * @param {{ speedMps?: number, intervalSec?: number }} [options]
 * @returns {LngLat[]}
 */
export function interpolateTrack(waypoints, options = {}) {
  const speedMps = options.speedMps ?? DEFAULT_GPX_OPTIONS.speedMps
  const intervalSec = options.intervalSec ?? DEFAULT_GPX_OPTIONS.intervalSec
  const stepM = speedMps * intervalSec
  if (!(stepM > 0) || !Number.isFinite(stepM)) throw new RangeError('speed and interval must be positive')
  if (waypoints.length === 0) throw new RangeError('a track needs at least one waypoint')

  /** @type {LngLat[]} */
  const track = [[waypoints[0][0], waypoints[0][1]]]
  // Meters still to drive before the next point is due.
  let untilNextM = stepM
  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1]
    const b = waypoints[i]
    const length = distanceM(a, b)
    if (length === 0) continue
    let doneM = 0
    while (length - doneM >= untilNextM) {
      doneM += untilNextM
      track.push(between(a, b, doneM / length))
      untilNextM = stepM
    }
    untilNextM -= length - doneM
  }
  const end = waypoints[waypoints.length - 1]
  const last = track[track.length - 1]
  // A final step shorter than a millimeter is rounding, not a place: end on the waypoint itself.
  if (track.length > 1 && distanceM(last, end) < 0.001) track[track.length - 1] = [end[0], end[1]]
  else if (last[0] !== end[0] || last[1] !== end[1]) track.push([end[0], end[1]])
  return track
}

/**
 * The whole simulated drive: standing at the start for `holdSec`, then driving.
 * @param {readonly LngLat[]} waypoints
 * @param {Partial<typeof DEFAULT_GPX_OPTIONS>} [options]
 * @returns {LngLat[]} one position per interval
 */
export function buildTrack(waypoints, options = {}) {
  const o = { ...DEFAULT_GPX_OPTIONS, ...options }
  const driven = interpolateTrack(pathFrom(waypoints, o.fromM), o)
  const holdPoints = Math.max(0, Math.round(o.holdSec / o.intervalSec))
  const track = [...Array.from({ length: holdPoints }, () => driven[0]), ...driven]
  if (!(o.maxSec > 0)) return track
  return track.slice(0, Math.max(1, Math.floor(o.maxSec / o.intervalSec) + 1))
}

const escapeXml = (text) => text.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c])

/**
 * GPX 1.1 text for a track: one `trkpt` per position, `intervalSec` apart from `startTime` on.
 * @param {readonly LngLat[]} track
 * @param {{ name?: string, startTime?: string, intervalSec?: number }} [options]
 */
export function toGpx(track, options = {}) {
  const startMs = Date.parse(options.startTime ?? DEFAULT_GPX_OPTIONS.startTime)
  if (Number.isNaN(startMs)) throw new RangeError('startTime is not a date')
  const intervalMs = (options.intervalSec ?? DEFAULT_GPX_OPTIONS.intervalSec) * 1000
  const points = track.map(([lng, lat], i) => {
    const time = new Date(startMs + i * intervalMs).toISOString()
    return `      <trkpt lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}"><time>${time}</time></trkpt>`
  })
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="RouteIQ scripts/phone/make-gpx.mjs" xmlns="http://www.topografix.com/GPX/1/1">',
    '  <trk>',
    `    <name>${escapeXml(options.name ?? 'Simulated drive')}</name>`,
    '    <trkseg>',
    ...points,
    '    </trkseg>',
    '  </trk>',
    '</gpx>',
    '',
  ].join('\n')
}

/**
 * Reads "lng,lat;lng,lat;..." (semicolons or spaces between points).
 * @param {string} text
 * @returns {LngLat[] | { error: string }}
 */
export function parseWaypoints(text) {
  const parts = text.split(/[;\s]+/).filter((part) => part !== '')
  if (parts.length < 2) return { error: '--waypoints needs at least two points, as "lng,lat;lng,lat"' }
  /** @type {LngLat[]} */
  const points = []
  for (const part of parts) {
    const numbers = part.split(',').map(Number)
    const [lng, lat] = numbers
    if (numbers.length !== 2 || !Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90) {
      return { error: `Not a "lng,lat" point: ${part} (longitude first, for example -80.8431,35.2271)` }
    }
    points.push([lng, lat])
  }
  return points
}

export const USAGE = [
  'Usage: node scripts/phone/make-gpx.mjs (--preset <name> | --waypoints "lng,lat;lng,lat;...") [options]',
  `  --preset <name>     ${Object.keys(PRESETS).join(' | ')}`,
  '  --waypoints <list>  longitude,latitude pairs, separated by ; (at least two)',
  `  --speed <m/s>       driving speed (default ${DEFAULT_GPX_OPTIONS.speedMps})`,
  '  --hold <seconds>    stand at the start this long before setting off (default 0)',
  '  --from-m <meters>   skip this much of the path, to start nearer the interesting part',
  '  --seconds <n>       cut the track after n seconds',
  '  --out <file>        write there instead of standard output',
  '  --list              list the presets',
].join('\n')

const NUMBER_FLAGS = { '--speed': 'speedMps', '--hold': 'holdSec', '--from-m': 'fromM', '--seconds': 'maxSec' }

/**
 * Reads the command line. Returns the options, or `{ error }` with a message.
 * @param {readonly string[]} argv arguments after the script name
 */
export function parseArgs(argv) {
  const options = { ...DEFAULT_GPX_OPTIONS, list: false, preset: null, waypoints: null, out: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--list') {
      options.list = true
      continue
    }
    const value = argv[++i]
    if (value === undefined) return { error: `${arg} needs a value` }
    if (arg === '--preset') {
      if (!Object.hasOwn(PRESETS, value)) return { error: `Unknown preset: ${value}. Presets: ${Object.keys(PRESETS).join(', ')}` }
      options.preset = value
    } else if (arg === '--waypoints') {
      const points = parseWaypoints(value)
      if (!Array.isArray(points)) return points
      options.waypoints = points
    } else if (arg === '--out') options.out = value
    else if (Object.hasOwn(NUMBER_FLAGS, arg)) {
      const number = Number(value)
      if (value.trim() === '' || !Number.isFinite(number) || number < 0) return { error: `${arg} needs a number, 0 or more` }
      options[NUMBER_FLAGS[arg]] = number
    } else return { error: `Unknown argument: ${arg}` }
  }
  if (options.list) return options
  if ((options.preset === null) === (options.waypoints === null)) return { error: 'Give either --preset or --waypoints' }
  if (options.speedMps < MIN_SPEED_MPS || options.speedMps > MAX_SPEED_MPS) {
    return { error: `--speed must be between ${MIN_SPEED_MPS} and ${MAX_SPEED_MPS} m/s` }
  }
  return options
}

/**
 * Resolves with the exit code.
 * @param {readonly string[]} argv
 * @param {{ log?: (line: string) => void, write?: (text: string) => void }} [deps]
 */
export async function main(argv, deps = {}) {
  // Notes go to standard error, so that standard output is the GPX and nothing else.
  const log = deps.log ?? ((line) => console.error(line))
  const write = deps.write ?? ((text) => process.stdout.write(text))
  const options = parseArgs(argv)
  if ('error' in options) {
    log(`${options.error}\n${USAGE}`)
    return 2
  }
  if (options.list) {
    for (const [name, preset] of Object.entries(PRESETS)) {
      write(`${name}: ${preset.about} (${(pathLengthM(preset.waypoints) / 1000).toFixed(1)} km)\n`)
    }
    return 0
  }
  const waypoints = options.preset === null ? options.waypoints : PRESETS[options.preset].waypoints
  const track = buildTrack(waypoints, options)
  const gpx = toGpx(track, { name: options.preset ?? 'Simulated drive', startTime: options.startTime, intervalSec: options.intervalSec })
  const seconds = (track.length - 1) * options.intervalSec
  const summary = `${track.length} points, ${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s, ${(pathLengthM(track) / 1000).toFixed(2)} km`
  if (options.out === null) write(gpx)
  else {
    await writeFile(options.out, gpx, 'utf8')
    log(`Wrote ${options.out}: ${summary}. Starts at ${track[0][1].toFixed(5)}, ${track[0][0].toFixed(5)}.`)
  }
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
