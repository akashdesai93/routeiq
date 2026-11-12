import { EMPTY_DRIVE_LOG, parseDriveLog, type DriveLog } from '../core/index.ts'
import type { TextStore } from './local.ts'

/**
 * The one key the private drive log lives under (#107). The version is in
 * the key and in the stored value, as with the place book: a new shape gets
 * a new key, and a value of another version under this one is discarded.
 * On this device only: nothing here is sent anywhere.
 */
export const DRIVE_LOG_KEY = 'routeiq.drives.v1'

/** Reads the log. Never throws. Text that is not a log of this version is removed and read as an empty log. */
export function loadDriveLog(store: TextStore): DriveLog {
  const text = store.read(DRIVE_LOG_KEY)
  if (text === null) return EMPTY_DRIVE_LOG
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    raw = null
  }
  const log = parseDriveLog(raw)
  if (log === null) {
    store.remove(DRIVE_LOG_KEY)
    return EMPTY_DRIVE_LOG
  }
  return log
}

/** Writes the log. False when the device would not take it (full or blocked). */
export function saveDriveLog(store: TextStore, log: DriveLog): boolean {
  return store.write(DRIVE_LOG_KEY, JSON.stringify(log))
}

/** Removes the whole log from the device. False when the device would not do it. */
export function clearDriveLog(store: TextStore): boolean {
  return store.remove(DRIVE_LOG_KEY)
}
