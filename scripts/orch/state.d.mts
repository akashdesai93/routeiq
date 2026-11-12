// Types for state.mjs, so the tests can import it. The script itself is plain JavaScript.
import type { FleetState } from './derive.mjs'
export function parseArgs(argv: string[]): Record<string, string>
export function outputs(state: FleetState): Record<string, string>
