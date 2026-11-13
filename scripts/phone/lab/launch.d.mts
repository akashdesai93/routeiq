// Types for launch.mjs, so the tests can import it.

export const BACKGROUND_APP: string
export const DEFAULT_LAB_LAUNCH: Readonly<{ backgroundFirstMs: number }>
export function startsFromBackground(bundleId: string, options?: { keep?: boolean; env?: Record<string, string | undefined> }): boolean
