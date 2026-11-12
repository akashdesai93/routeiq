// Types for gates.mjs, so the tests can import it. The script itself is plain JavaScript.
export const HOLD_LABELS: string[]
export const PHONE_LABEL: string
export const PHONE_VERIFIED: string
export const PHONE_MARKER: RegExp
export const COMPARE_FILE_LIMIT: number
export function areasOf(path: string): string[]
export function evaluate(
  pr: { labels: string[]; body: string; files: string[] },
  main: { aheadBy: number; files: string[] } | null,
): { ok: boolean; failures: { gate: string; message: string }[] }
export const RERUN_WAIT: Readonly<{ pollMs: number; maxMs: number }>
type Gh = (path: string, method?: string) => any
export function rerunRequired(
  R: string,
  sha: string,
  opts?: { dry?: boolean; why?: string; gh?: Gh; sleep?: (ms: number) => Promise<void>; wait?: { pollMs: number; maxMs: number }; log?: (s: string) => void },
): Promise<'no-run' | 'no-job' | 'dry-run' | 'rerun'>
export function recheckMain(
  R: string,
  opts: { pushed: string[]; pushedAt: string; dry?: boolean; gh?: Gh; rerun?: (R: string, sha: string, opts: any) => Promise<unknown>; log?: (s: string) => void },
): Promise<{ pr: number; message: string }[]>
