// Types for assertions.mjs, so the tests can import it. The script itself is plain JavaScript.

export const DEFAULT_LAB_CHECKS: Readonly<{ minFixesAway: number; minTicksAway: number; minBeatsPerAwayMinute: number }>

export interface DiagnosticsEvent {
  time: string
  what: string
  state: string
}

export interface ParsedDiagnostics {
  startedAt: string
  now: string
  appState: string
  gpsOn: boolean
  fixes: { count: number; away: number; longestGapSec: number }
  ticks: { count: number; away: number; longestGapSec: number }
  requests: { sent: number; away: number; answered: number; failed: number; cancelled: number; waiting: number }
  speech: { started: number; finished: number; cutOff: number }
  events: DiagnosticsEvent[]
  eventsDropped: boolean
}

export interface ParsedLabReport {
  scenario: string
  writtenAt: string
  number: number
  screen: string
  status: string
  routes: number
  turnCard: boolean
  arrivalTime: boolean
  warnings: number
  history: { time: string; what: string }[]
  diagnostics: ParsedDiagnostics | null
}

export interface Verdict {
  name: string
  pass: boolean
  detail: string
  notRun?: boolean
}

export function parseDiagnostics(text: unknown): ParsedDiagnostics | null
export function parseLabReport(text: unknown): ParsedLabReport | null
export function planFromCaptions(captions: unknown): { routes: number; startDrive: boolean; tokenScreen: boolean }
export function notRun(name: string, why: string): Verdict
export function checkFixesWhileAway(d: ParsedDiagnostics, min?: number): Verdict
export function checkTicksWhileAway(d: ParsedDiagnostics, min?: number): Verdict
export function checkRequestAnsweredWhileAway(d: ParsedDiagnostics): Verdict
export function checkOffRouteThenNewRoute(report: ParsedLabReport): Verdict
export function checkSpeechFinished(d: ParsedDiagnostics): Verdict
export function checkNoFailedRequests(d: ParsedDiagnostics): Verdict
export function checkSteadyWhileAway(d: ParsedDiagnostics, awayMinutes: number, perMinute?: number): Verdict
export function checkPlanShowsRoutes(seen: { routes: number; startDrive: boolean }): Verdict
export function awayWindows(d: ParsedDiagnostics): { from: number; to: number }[]
export function checkStayedAway(d: ParsedDiagnostics, expectedSec: number): Verdict
export function checkLockedWrongTurn(report: ParsedLabReport | null, awaySec?: number): Verdict[]
export function checkSoak(report: ParsedLabReport | null, awayMinutes: number): Verdict[]
export function redact(line: unknown): string
