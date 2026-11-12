// Types for make-gpx.mjs, so the tests can import it. The script itself is plain JavaScript.

export type LngLat = readonly [lng: number, lat: number]

export interface GpxOptions {
  speedMps: number
  intervalSec: number
  holdSec: number
  fromM: number
  maxSec: number
  startTime: string
}

export const DEFAULT_GPX_OPTIONS: Readonly<GpxOptions>
export const MIN_SPEED_MPS: number
export const MAX_SPEED_MPS: number
export const USAGE: string

export function distanceM(a: LngLat, b: LngLat): number
export function pathLengthM(path: readonly LngLat[]): number
export function pathFrom(path: readonly LngLat[], fromM: number): LngLat[]
export function interpolateTrack(waypoints: readonly LngLat[], options?: { speedMps?: number; intervalSec?: number }): LngLat[]
export function buildTrack(waypoints: readonly LngLat[], options?: Partial<GpxOptions>): LngLat[]
export function toGpx(track: readonly LngLat[], options?: { name?: string; startTime?: string; intervalSec?: number }): string
export function parseWaypoints(text: string): LngLat[] | { error: string }

export interface MakeGpxOptions extends GpxOptions {
  list: boolean
  preset: string | null
  waypoints: LngLat[] | null
  out: string | null
}

export function parseArgs(argv: readonly string[]): MakeGpxOptions | { error: string }

/** Resolves with the exit code. */
export function main(argv: readonly string[], deps?: { log?: (line: string) => void; write?: (text: string) => void }): Promise<number>
