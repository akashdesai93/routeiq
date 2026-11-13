// Types for drive-report.mjs, so the tests can import it. The script itself is plain JavaScript.
export const DEFAULT_REPORT_OPTIONS: Readonly<{
  pollIntervalSec: number
  requestBudget: number
  minSavingSec: number
  blindAfterSec: number
  offCycleBelowSec: number
  slowRequestMs: number
  longGapSec: number
}>
export const CHECK_LABELS: Readonly<Record<string, string>>
export const PROBE_SKIP_LABELS: Readonly<Record<string, string>>
export const OFFER_ENDINGS: Readonly<Record<string, string>>
export const OFFER_END_WORDS: readonly string[]
export const FASTER_NOT_OFFERED: Readonly<Record<string, string>>
export function clockOf(sec: number): string
export function lengthOf(sec: number): string
export function parseTally(body: string, labels: Readonly<Record<string, string>>): Record<string, number> | null
export interface Finding {
  id: string
  says: string
  lines: string[]
}
export interface DriveReport {
  report: string
  log: {
    recognised: boolean
    eventsDropped: number
    unknownLines: number
    privateLines: number
    has: { probeCounts: boolean; checkOutcomes: boolean; probeSkips: boolean; offers: boolean }
    simulatedDrives: number
  }
  drive: null | {
    start: string
    end: string
    startInLog: boolean
    endInLog: boolean
    lengthSec: number
    spells: number
    fixes: number | null
    ticks: number | null
    fixesPerSec: number | null
    ticksPerSec: number | null
    longestFixGapSec: number | null
    longestTickGapSec: number | null
    notActiveSec: number
  }
  requests: {
    sent: number | null
    answered: number | null
    failed: number | null
    cancelled: number | null
    waiting: number | null
    averageMs: number | null
    slowestMs: number | null
    plainChecksInDrive: number
    checksStoppedAt: string | null
    blindStretchSec: number
    longestCheckGapSec: number | null
  }
  probes: { total: number | null; inEvents: number; duringDrive: number; atPlanTime: number; times: string[]; skipped: null | { count: number; tally: Record<string, number> } }
  pathChecks: { total: number | null; inEvents: number; duringDrive: number; atPlanTime: number; times: string[] }
  routeChanges: { offCycleRequests: number; offCycleTimes: string[]; switches: number | null; offersShown: number | null }
  offers: null | {
    shown: number
    ended: Record<string, number>
    list: { at: string; savingSec: number | null; why: string; how: string | null; afterSec: number | null; because: string | null; directions: string | null }[]
  }
  checks: null | { count: number; tally: Record<string, number>; fastest: number; bestSavingSec: number | null; fasterNotOffered: Record<string, number> }
  speech: null | { started: number; finished: number; cutOff: number }
  findings: Finding[]
}
export function parseDiagnostics(text: string): unknown
export function analyse(text: string, options?: Partial<typeof DEFAULT_REPORT_OPTIONS>): DriveReport
export function reportText(report: DriveReport): string
