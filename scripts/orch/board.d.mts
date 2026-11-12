// Types for board.mjs, so the tests can import it. The script itself is plain JavaScript.
import type { FleetState } from './derive.mjs'
export function renderBoard(state: FleetState): string
export function renderMorning(state: FleetState, opts?: { sinceHours?: number }): string
export function renderAlert(state: FleetState): { ok: boolean; keys: string[]; body: string }
