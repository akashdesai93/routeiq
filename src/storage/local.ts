/**
 * A tiny synchronous text store: the way RouteIQ keeps the few small things
 * that have to be there before the first paint (saved places, the last
 * trip). In the browser it is localStorage; tests and places without
 * storage get memory. Larger, licensed datasets go through kv.ts instead.
 *
 * No method ever throws. A store that cannot read answers null; one that
 * cannot write answers false, and the caller decides whether to say so.
 */
export interface TextStore {
  /** Null when there is nothing under the key, or it cannot be read. */
  read(key: string): string | null
  /** False when the value could not be written (storage full, blocked or missing). */
  write(key: string, value: string): boolean
  /** False when the key could not be removed. Removing a key that is not there succeeds. */
  remove(key: string): boolean
}

/** The part of the Web Storage API the store uses, so a test can hand in a stand-in. */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Kept in memory for as long as the page is open. Used in tests, and where the browser has no storage. */
export function memoryTextStore(initial: Readonly<Record<string, string>> = {}): TextStore {
  const values = new Map<string, string>(Object.entries(initial))
  return {
    read: (key) => values.get(key) ?? null,
    write: (key, value) => {
      values.set(key, value)
      return true
    },
    remove: (key) => {
      values.delete(key)
      return true
    },
  }
}

function defaultStorage(): StorageLike | null {
  try {
    // Reading the property itself can throw where storage is blocked (some private windows, sandboxed frames).
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/**
 * A store in the browser's localStorage. Where there is none (Node, storage
 * blocked) it is a memory store for the session. A read that throws is a
 * miss; a write that throws (the quota is used up, storage went away)
 * answers false and leaves what was stored before as it was.
 */
export function localTextStore(storage: StorageLike | null = defaultStorage()): TextStore {
  if (storage === null) return memoryTextStore()
  return {
    read(key) {
      try {
        return storage.getItem(key)
      } catch {
        return null
      }
    },
    write(key, value) {
      try {
        storage.setItem(key, value)
        return true
      } catch {
        return false
      }
    },
    remove(key) {
      try {
        storage.removeItem(key)
        return true
      } catch {
        return false
      }
    },
  }
}
