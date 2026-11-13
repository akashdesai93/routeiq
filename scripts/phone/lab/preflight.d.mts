// Types for preflight.mjs, so the tests can import it. The script itself is plain JavaScript.
export const DEFAULT_LAB_RULES: Readonly<{ quietFromHour: number; quietToHour: number; maxCommentPages: number }>
export const SILENT_SCENARIOS: readonly string[]
export const MIN_SHA_LENGTH: number
export function readLabWindow(gh: (apiPath: string) => any, repo: string, now: string, rules?: typeof DEFAULT_LAB_RULES): { window: { opened_at: string; until: string; voice_ok: boolean } | null } | { error: string }
export function ghJson(apiPath: string): any
export function isQuietHour(hour: number, rules?: { quietFromHour: number; quietToHour: number }): boolean
export function quietHoursProblem(hour: number, scenario: string, voiceOk: boolean, rules?: { quietFromHour: number; quietToHour: number }): string | null
export function windowProblem(window: { until: string } | null, now: string): string | null
export function buildProblem(buildSha: string | null | undefined, headSha: string | null | undefined): string | null
export function waitAllowance(waitHours: number, untilHHMM: string | null, now: Date | string): { ms: number } | { error: string }
export function labWindowFrom(comments: { body: string; created_at: string }[]): { opened_at: string; until: string; voice_ok: boolean } | null
export function preflight(input: { now: string; hour: number; scenario?: string | null; voiceOk?: boolean; window: { until: string; voice_ok?: boolean } | null; buildSha?: string | null; headSha?: string | null }): { ok: boolean; problems: string[] }
