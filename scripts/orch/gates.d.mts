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
