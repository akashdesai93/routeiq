// Types for derive.mjs, so the tests can import it. The script itself is plain JavaScript.
/* The records are plain JSON; the tests read them field by field. */
export type Json = any
export interface FleetState {
  generated_at: string; repo: string
  sessions: Json[]; prs: Json[]; issues: Json[]; events: { at: string; who: string; kind: string; what: string }[]
  decisions: { issue: number; title: string; question: string | null; recommendation: string | null; options: string[]; asked_at: string | null; url: string }[]
  merged: { number: number; title: string; branch: string; merged_at: string; url: string }[]
  health: Json; phoneQueue: Json[]; local_health?: Record<string, unknown>
}
export function needsPhone(pr: { labels: string[]; body?: string }): boolean
export function phoneCheckSteps(body: string): string[]
export function prStage(p: { labels: string[]; draft: boolean; needsPhone: boolean; required: string; conflicting: boolean }): string
export function sessionGroup(s: Json, openPrs: Json[]): 'done' | 'phone' | 'blocked' | 'review' | 'working'
export function derive(raw: Json, opts?: { now?: string; [k: string]: unknown }): FleetState
export function mergeLocal(state: FleetState, local: { sessions?: Json[]; events?: Json[]; health?: Record<string, unknown> }): FleetState
export function bundleHeadroom(notice: Json): { state: 'unknown' | 'ok' | 'high'; alert_at?: number; sha?: string | null; url?: string | null; measures: Json[]; high: Json[] }
