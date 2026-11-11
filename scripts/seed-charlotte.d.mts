// Types for seed-charlotte.mjs, so the tests can import it. The script itself is plain JavaScript.

export const USER_AGENT: string
export const DEFAULT_OUT_DIR: string
export const CHARLOTTE_DIR: string
export const CHARLOTTE_FILE: string
export const CHARLOTTE_LICENSE_MD: string

export interface SeedOptions {
  dryRun: boolean
  attempts: number
}

export function parseArgs(argv: readonly string[]): SeedOptions | { error: string }
export function describePlan(options: SeedOptions, outDir: string): string[]

export interface SeedDeps {
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  log?: (line: string) => void
  outDir?: string
}

/** Resolves with the exit code. */
export function main(argv: readonly string[], deps?: SeedDeps): Promise<number>
