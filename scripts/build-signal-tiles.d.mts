// Types for build-signal-tiles.mjs, so the tests can import it. The script itself is plain JavaScript.

export const DEFAULT_EXTRACTS_DIR: string
export const DEFAULT_OUT_DIR: string
export const EXTRACTS_URL: string
export const OSM_LICENSE_MD: string

export interface BuildOptions {
  dryRun: boolean
  extractsDir: string
  outDir: string
}

export function parseArgs(argv: readonly string[]): BuildOptions | { error: string }

/** Resolves with the exit code. */
export function main(argv: readonly string[], deps?: { log?: (line: string) => void; progressMs?: number }): Promise<number>
