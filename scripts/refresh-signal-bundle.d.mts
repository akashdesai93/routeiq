// Types for refresh-signal-bundle.mjs, so the tests can import it. The script itself is plain JavaScript.
import type { BundleSnapshot } from '../src/providers/osm/refresh.ts'

export const EXIT: { refreshed: 0; badArguments: 1; buildFailed: 2; unchanged: 3; rejected: 4 }

export interface RefreshOptions {
  dryRun: boolean
  extractsDir: string
  currentDir: string
  summary: string | null
  result: string | null
}

export function parseArgs(argv: readonly string[]): RefreshOptions | { error: string }

export function readBundle(dir: string): Promise<BundleSnapshot | { error: string }>

/** Resolves with the exit code. */
export function main(argv: readonly string[], deps?: { log?: (line: string) => void; now?: number }): Promise<number>
