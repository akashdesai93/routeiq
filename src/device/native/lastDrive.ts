import type { TextStore } from '../../storage/local.ts'
import type { DriveDiagnostics } from './diagnostics.ts'

/**
 * The last drive's diagnostics, kept on the phone so they are still there
 * after the app was closed (the log itself is in memory). Written when a
 * drive ends and about every 30 s during one.
 *
 * Privacy: what is kept is the diagnostics text, which holds counts, times
 * of day and whole milliseconds only (diagnostics.ts). As a second lock, a
 * text that looks as if it held a coordinate, a token or an address is not
 * written at all, and one read back that looks so is not shown
 * (tests/lastDrive.test.ts checks both by pattern).
 */
export const LAST_DRIVE_KEY = 'routeiq.shell.lastDrive.v1'
/** During a drive the text is written again this often, in milliseconds. */
export const LAST_DRIVE_SAVE_MS = 30_000
/** A text longer than this is not kept. The log is bounded (200 events), so this is never reached in practice. */
export const LAST_DRIVE_MAX_CHARS = 40_000

export interface LastDrive {
  /** When it was written, milliseconds since 1970. */
  readonly savedAtMs: number
  readonly text: string
}

/**
 * What must never be stored: a number with a decimal point (a coordinate has
 * one; nothing in the diagnostics does), a Mapbox token, an address.
 */
const NOT_STORED = /\d[.,]\d|\b[ps]k\.|https?:|:\/\//i

/** True when the text holds nothing that looks like a position, a token or an address. */
export function safeToStore(text: string): boolean {
  return text.length > 0 && text.length <= LAST_DRIVE_MAX_CHARS && !NOT_STORED.test(text)
}

/** Keeps the text as the last drive. False when it was refused (see safeToStore) or the phone would not store it. */
export function saveLastDrive(store: TextStore, text: string, nowMs: number): boolean {
  if (!safeToStore(text) || !Number.isFinite(nowMs)) return false
  return store.write(LAST_DRIVE_KEY, JSON.stringify({ savedAtMs: Math.round(nowMs), text }))
}

/** The last drive kept on this phone. Null when there is none, or what is there is not a diagnostics text. */
export function readLastDrive(store: TextStore): LastDrive | null {
  const raw = store.read(LAST_DRIVE_KEY)
  if (raw === null) return null
  try {
    const value = JSON.parse(raw) as { savedAtMs?: unknown; text?: unknown } | null
    if (value === null || typeof value !== 'object') return null
    const { savedAtMs, text } = value
    if (typeof savedAtMs !== 'number' || !Number.isFinite(savedAtMs) || typeof text !== 'string' || !safeToStore(text)) return null
    return { savedAtMs, text }
  } catch {
    return null
  }
}

export interface LastDriveSaver {
  /** Call often during a drive (every tick): writes when LAST_DRIVE_SAVE_MS has passed since the last write. */
  tick(): void
  /** The drive ended: writes now. */
  end(): void
}

export function lastDriveSaver(log: Pick<DriveDiagnostics, 'text'>, store: TextStore, now: () => number = Date.now): LastDriveSaver {
  let savedAt: number | null = null
  const save = () => {
    savedAt = now()
    saveLastDrive(store, log.text(), savedAt)
  }
  return {
    tick() {
      const at = now()
      // The first tick only starts the wait; a clock that went backwards writes at once.
      if (savedAt === null) savedAt = at
      else if (at < savedAt || at - savedAt >= LAST_DRIVE_SAVE_MS) save()
    },
    end: save,
  }
}
