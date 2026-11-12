// Types for queue.mjs, so the tests can import it. The script itself is plain JavaScript.

export const DEFAULT_RUNS: readonly (readonly string[])[]
export const UNLOCK_POLL_MS: number
export const UNLOCK_SETTLE_MS: number

export interface QueueBuild {
  name: string
  ipa: string | null
  runs: readonly (readonly string[])[]
  keep: boolean
}

export function readPlan(text: string, exists?: (file: string) => boolean): { error: string } | { rollback: string; builds: QueueBuild[] }

export interface QueueResult {
  name: string
  ipa: string | null
  keep: boolean
  installed: boolean
  installNote: string
  runs: { label: string; code: number; summary: string }[]
}

export function bestVerified(results: readonly QueueResult[]): QueueResult | null
export function queueReport(run: { startedAt: string; endedAt: string; results: readonly QueueResult[]; left: string; note: string }): string
export function labStartProblem(gh: (apiPath: string) => any, repo: string, now: Date | string): string | null
