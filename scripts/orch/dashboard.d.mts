// Types for dashboard.mjs, so the tests can import it. The script itself is plain JavaScript.
import type { FleetState, Json } from './derive.mjs'
export const DASHBOARD_FILES: string[]
export function dashboardSession(s: Json): Json
export function issueStage(i: { state: string; labels: string[] }): string
export function recommendedOption(recommendation: string | null, options: string[]): string | null
export function dashboardHealth(state: FleetState): { main: string; phone_build: string; phone_state: string; heartbeat_at: string; notes: string }[]
export function dashboardFiles(state: FleetState): Record<string, string>
