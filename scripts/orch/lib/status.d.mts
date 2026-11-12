// Types for status.mjs, so the tests can import it. The script itself is plain JavaScript.
export interface BoardComment { id: number; created_at: string; updated_at?: string; body: string; html_url?: string }
export interface StatusRecord {
  id: string; name: string; kind: string; surface: 'cloud' | 'local'; role: string; state: string
  where: string | null; branch: string | null; branches: string[]; working_on: string | null; issue: number | null; prs: number[]
  done: string | null; next: string | null; blocked: string | null; asks: string | null; formatted: boolean
  at: string; comment_id: number; url: string | null; body: string
}
export const ROLES: string[]
export const STATES: string[]
export function keyLines(body: string): Record<string, string>
export function commentKind(body: string): 'heartbeat' | 'dispatch' | 'lab-window' | 'status' | 'other'
export function nameFromFirstLine(first: string): string | null
export function roleFromName(name: string): string
export function inferState(keys: Record<string, string>, first: string): string
export function numbersIn(text: string): number[]
export function prsIn(text: string): number[]
export function branchesIn(text: string): string[]
export function branchIn(text: string): string | null
export function parseStatus(c: BoardComment): StatusRecord | null
export function parseDispatch(c: BoardComment): { name: string; surface: string; role: string; issues: number[]; by: string | null; at: string; comment_id: number } | null
export function parseHeartbeat(c: BoardComment): { who: string; session: string | null; state: string; away_until: string | null; next_tick_min: number | null; at: string; comment_id: number } | null
export function parseLabWindow(c: BoardComment): { opened_at: string; until: string; comment_id: number } | null
export function parseDecision(body: string): { question: string; recommendation: string | null; options: string[] } | null
export function parsePrComment(c: BoardComment): { type: string; [k: string]: unknown } | null
