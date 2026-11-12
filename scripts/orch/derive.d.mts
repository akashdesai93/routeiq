// Types for derive.mjs, so the tests can import it. The script itself is plain JavaScript.
/* The records are plain JSON; the tests read them field by field. */
export type Json = any
export interface FleetState {
  generated_at: string; repo: string
  sessions: Json[]; prs: Json[]; issues: Json[]; events: { at: string; who: string; kind: string; what: string }[]
  decisions: { issue: number; title: string; question: string | null; recommendation: string | null; options: string[]; asked_at: string | null; url: string }[]
  health: Json; phoneQueue: Json[]
}
export function needsPhone(pr: { labels: string[]; body?: string }): boolean
export function phoneCheckSteps(body: string): string[]
export function derive(raw: Json, opts?: { now?: string; [k: string]: unknown }): FleetState
export function mergeLocal(state: FleetState, local: { sessions?: Json[]; events?: Json[] }): FleetState
