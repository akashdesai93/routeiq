// Types for publish.mjs, so the tests can import it. The script itself is plain JavaScript.
export const ALERT_LABEL: string
export const ALERT_TITLE: string
export function keysOf(body: string): string[]
export function alertAction(
  existing: { number: number; state: string; body: string } | null,
  alert: { ok: boolean; keys: string[]; body: string },
): { action: 'none' | 'create' | 'reopen' | 'update' | 'close'; comment: string | null }
export function hasMorningToday(comments: { body: string }[], nowIso: string): boolean
export function publish(
  argv: string[],
  io?: { gh?: (args: string[]) => string; log?: (line: string) => void; env?: Record<string, string | undefined>; now?: string },
): void
